/**
 * Runs a plan's steps in order inside the guest. Honors `when`, `continueOnError`,
 * step and job timeouts, and carries `GITHUB_ENV` / `GITHUB_PATH` additions
 * from one step to the next.
 *
 * Each step starts detached in its own session (see `step-launcher.ts`); the
 * host polls for the exit status the step's supervisor writes, then copies the
 * step's log from the guest. A step that outlives its timeout, or runs when the
 * job times out or Hugi is interrupted, is killed with its whole process group.
 * A VM that exits, or a guest agent that stops answering, ends the run as
 * `infrastructure`.
 *
 * GitHub's run-time conditions apply, including to the synthetic "Install
 * tools" step: after a failure, `success` steps are skipped while `always` and
 * `failure` steps still run. One exception: once the job times out, every
 * remaining step is skipped, `always` steps included.
 */
import type { PlanStep, RunStep, StepWhen } from '../lane/step-plan';
import { withDeadline } from './deadline';
import {
  githubEnvironment,
  parseEnvFile,
  parsePathFile,
  prependPaths,
  stepEnvironment,
  toolVersionEnvironment,
} from './guest-env';
import type { Environment } from './guest-env';
import { stepFiles } from './guest-paths';
import type { StepFiles } from './guest-paths';
import { bounded, killProcessGroup, readGuestFile } from './housekeeping';
import type { GuestCall } from './housekeeping';
import { openLogFile, stepLogName } from './logs';
import type { RunRequest, StepResult } from './run-request';
import { shellQuote } from './shell';
import { buildStepLauncher } from './step-launcher';
import type { Clock, Tart } from './tart';

export type StepTuning = {
  /** How often the host asks whether the running step has exited. */
  readonly guestPollMs: number;
  /** The deadline of each housekeeping call: a status poll, a log copy, a kill. */
  readonly housekeepingMs: number;
  /** Consecutive failed status polls after which the guest agent counts as gone. */
  readonly agentFailureLimit: number;
};

export type StepRunContext = {
  readonly tart: Tart;
  readonly clock: Clock;
  readonly vm: string;
  readonly request: RunRequest;
  readonly interrupt: AbortSignal;
  /** Aborts when the VM process exits after boot. */
  readonly vmLost: AbortSignal;
  /** Clock time (ms) at which the job timeout expires. */
  readonly jobDeadline: number;
  readonly tuning: StepTuning;
  readonly warn: (message: string) => void;
};

export type PlanOutcome = {
  readonly reason: 'passed' | 'step-failed' | 'timeout' | 'interrupted' | 'infrastructure';
  readonly detail?: string;
};

/** What ended a step, if anything other than its own exit. */
type StepEnd = 'exited' | 'step-timeout' | 'job-timeout' | 'interrupted' | 'vm-lost';

/** Values earlier steps handed to later ones. */
type CarriedState = { readonly fromGithubEnv: Environment; readonly extraPath: readonly string[] };

const MILLISECONDS_PER_MINUTE = 60_000;

/** Whether a step with this `when` runs, given whether an earlier step has failed. */
export function shouldRun(when: StepWhen, anEarlierStepFailed: boolean): boolean {
  if (when === 'always') {
    return true;
  }
  return when === 'failure' ? anEarlierStepFailed : !anEarlierStepFailed;
}

function skipped(step: PlanStep): StepResult {
  return { index: step.index, name: step.name, outcome: 'skipped', seconds: 0 };
}

const guestCall = (ctx: StepRunContext): GuestCall => ({
  clock: ctx.clock,
  deadlineMs: ctx.tuning.housekeepingMs,
  tart: ctx.tart,
  vm: ctx.vm,
});

/** Start the step in the guest; a launcher that fails or does not answer is an infrastructure error. */
async function launch(ctx: StepRunContext, step: RunStep, stdin: string): Promise<void> {
  let output = '';
  const started = await bounded(ctx.clock, ctx.tuning.housekeepingMs, (signal) =>
    ctx.tart.exec(ctx.vm, ['bash', '-s'], {
      onOutput: (chunk) => {
        output += chunk;
      },
      signal,
      stdin,
    }),
  );
  const why = started.ok
    ? started.value.exitCode !== 0 && `exit code ${started.value.exitCode}: ${output.trim()}`
    : started.why;
  if (why) {
    throw new Error(`could not start step ${step.index} "${step.name}" (${why})`);
  }
}

type Waited =
  | { readonly kind: 'exited'; readonly exitCode: number }
  | { readonly kind: 'agent-lost' }
  | { readonly kind: 'cut-short' };

/** Poll for the step's exit status until it appears, `signal` aborts, or the agent stops answering. */
async function waitForExit(
  ctx: StepRunContext,
  files: StepFiles,
  signal: AbortSignal,
): Promise<Waited> {
  let failures = 0;
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    const status = await readGuestFile(guestCall(ctx), files.status, signal);
    if (signal.aborted) {
      break;
    }
    if (status.ok) {
      failures = 0;
      if (status.value.trim() !== '') {
        return { exitCode: Number(status.value.trim()), kind: 'exited' };
      }
    } else {
      failures += 1;
      ctx.warn(`could not poll step status in ${ctx.vm}: ${status.why}`);
      if (failures >= ctx.tuning.agentFailureLimit) {
        return { kind: 'agent-lost' };
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    await ctx.clock.sleep(ctx.tuning.guestPollMs, signal);
  }
  return { kind: 'cut-short' };
}

/**
 * Copy the step's guest log into its host log file, followed by `epilogue`, a
 * note of Hugi's own; a failed copy leaves a note in the log's place.
 */
async function copyLog(
  ctx: StepRunContext,
  step: RunStep,
  files: StepFiles,
  epilogue = '',
): Promise<string> {
  const log = await openLogFile(ctx.request.logDir, stepLogName(step.index, step.name));
  try {
    const text = await readGuestFile(guestCall(ctx), files.log);
    if (text.ok) {
      log.write(text.value);
    } else {
      ctx.warn(`could not copy the log of step ${step.index} from ${ctx.vm}: ${text.why}`);
      log.write(`hugi: could not copy this step's log from the VM (${text.why})\n`);
    }
    log.write(epilogue);
  } finally {
    await log.close();
  }
  return log.path;
}

/** Read one of the step's command files; a guest that cannot answer is an infrastructure error. */
async function readCommandFile(ctx: StepRunContext, step: RunStep, path: string): Promise<string> {
  const text = await readGuestFile(guestCall(ctx), path);
  if (!text.ok) {
    throw new Error(`could not read ${path} after step ${step.index} "${step.name}" (${text.why})`);
  }
  return text.value;
}

/** Parse the step's `GITHUB_ENV` and `GITHUB_PATH` into the carried state, or say why they are invalid. */
async function applyCommandFiles(
  ctx: StepRunContext,
  step: RunStep,
  files: StepFiles,
  carried: CarriedState,
): Promise<{ readonly carried: CarriedState } | { readonly error: string }> {
  const envText = await readCommandFile(ctx, step, files.env);
  const pathText = await readCommandFile(ctx, step, files.path);
  const env = parseEnvFile(envText);
  if ('error' in env) {
    return { error: env.error };
  }
  return {
    carried: {
      extraPath: prependPaths(carried.extraPath, parsePathFile(pathText)),
      fromGithubEnv: { ...carried.fromGithubEnv, ...env.env },
    },
  };
}

type StepRun = {
  readonly result: StepResult;
  readonly end: StepEnd;
  readonly carried: CarriedState;
};

/** Which deadline or signal cut a step short, once a lost VM is ruled out. */
function cutShortBy(timedOut: boolean, jobLimited: boolean): StepEnd {
  if (timedOut) {
    return jobLimited ? 'job-timeout' : 'step-timeout';
  }
  return 'interrupted';
}

async function runOneStep(
  ctx: StepRunContext,
  step: RunStep,
  carried: CarriedState,
  remainingMs: number,
): Promise<StepRun> {
  const stepLimitMs = (step.timeoutMinutes ?? Number.POSITIVE_INFINITY) * MILLISECONDS_PER_MINUTE;
  const limitMs = Math.min(stepLimitMs, remainingMs);
  const jobLimited = remainingMs <= stepLimitMs;
  const files = stepFiles(step.index);
  const env = stepEnvironment({
    fromGithubEnv: carried.fromGithubEnv,
    plan: ctx.request.plan.env,
    runner: {
      ...githubEnvironment(ctx.request.event),
      ...toolVersionEnvironment(ctx.request.tools),
    },
    step: step.env,
  });
  const began = ctx.clock.now();
  await launch(ctx, step, buildStepLauncher({ env, extraPath: carried.extraPath, files, step }));

  const stopWaiting = AbortSignal.any([ctx.interrupt, ctx.vmLost]);
  const { value: waited, timedOut } = await withDeadline(
    ctx.clock,
    limitMs,
    stopWaiting,
    (signal) => waitForExit(ctx, files, signal),
  );
  const seconds = (ctx.clock.now() - began) / 1000;
  const base = { index: step.index, name: step.name, seconds };

  if (waited.kind === 'agent-lost' || ctx.vmLost.aborted) {
    const error = ctx.vmLost.aborted
      ? 'the VM exited while the step ran'
      : 'the guest agent stopped answering while the step ran';
    return { carried, end: 'vm-lost', result: { ...base, error, outcome: 'failure' } };
  }
  if (waited.kind === 'cut-short') {
    const end = cutShortBy(timedOut, jobLimited);
    const killed = await killProcessGroup(guestCall(ctx), files.processGroup);
    if (!killed.ok) {
      ctx.warn(`could not kill step ${step.index} in ${ctx.vm}: ${killed.why}`);
    }
    const logFile = await copyLog(ctx, step, files);
    const outcome = end === 'interrupted' ? 'failure' : 'timeout';
    return { carried, end, result: { ...base, logFile, outcome } };
  }

  const { exitCode } = waited;
  const applied = await applyCommandFiles(ctx, step, files, carried);
  if ('error' in applied) {
    const logFile = await copyLog(ctx, step, files, `Error: ${applied.error}\n`);
    return {
      carried,
      end: 'exited',
      result: { ...base, error: applied.error, exitCode, logFile, outcome: 'failure' },
    };
  }
  const logFile = await copyLog(ctx, step, files);
  return {
    carried: applied.carried,
    end: 'exited',
    result: { ...base, exitCode, logFile, outcome: exitCode === 0 ? 'success' : 'failure' },
  };
}

function describeFailure(result: StepResult): string {
  if (result.outcome === 'timeout') {
    return `step ${result.index} "${result.name}" timed out`;
  }
  const how = result.error ? `failed: ${result.error}` : `failed with exit code ${result.exitCode}`;
  return `step ${result.index} "${result.name}" ${how}`;
}

/** The synthetic first step that installs the request's tools; absent when there are none. */
function installToolsStep(tools: readonly string[]): RunStep | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return {
    continueOnError: false,
    env: {},
    index: 0,
    kind: 'run',
    name: 'Install tools',
    script: `mise install ${tools.map(shellQuote).join(' ')}`,
    shell: 'bash',
    when: 'success',
  };
}

/** How a step that ended early ends the run. */
function stopFor(
  ctx: StepRunContext,
  end: Exclude<StepEnd, 'exited' | 'step-timeout'>,
  result: StepResult,
): Required<PlanOutcome> {
  const during = `during step ${result.index} "${result.name}"`;
  if (end === 'interrupted') {
    return { detail: `interrupted ${during}`, reason: 'interrupted' };
  }
  if (end === 'job-timeout') {
    return {
      detail: `job timed out after ${ctx.request.plan.timeoutMinutes} minutes ${during}`,
      reason: 'timeout',
    };
  }
  return { detail: `${result.error ?? 'the VM was lost'} (${during})`, reason: 'infrastructure' };
}

/**
 * Execute the request's tool install and every step of its plan, appending
 * each step's result to `results` as it finishes, so a caller keeps them even
 * when this throws. Steps never run after the job timeout, an interrupt, or
 * the loss of the VM.
 */
export async function runSteps(ctx: StepRunContext, results: StepResult[]): Promise<PlanOutcome> {
  let carried: CarriedState = { extraPath: [], fromGithubEnv: {} };
  let failed = false;
  let firstFailure: string | undefined;
  let stop: Required<PlanOutcome> | undefined;
  const install = installToolsStep(ctx.request.tools);
  const steps: readonly PlanStep[] = install
    ? [install, ...ctx.request.plan.steps]
    : ctx.request.plan.steps;

  for (const step of steps) {
    const remainingMs = ctx.jobDeadline - ctx.clock.now();
    if (stop || step.kind === 'action' || !shouldRun(step.when, failed)) {
      results.push(skipped(step));
      continue;
    }
    if (ctx.interrupt.aborted) {
      stop = { detail: 'interrupted before the plan finished', reason: 'interrupted' };
      results.push(skipped(step));
      continue;
    }
    if (remainingMs <= 0) {
      stop = {
        detail: `job timed out after ${ctx.request.plan.timeoutMinutes} minutes`,
        reason: 'timeout',
      };
      results.push(skipped(step));
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    const run = await runOneStep(ctx, step, carried, remainingMs);
    results.push(run.result);
    carried = run.carried;
    if (run.end === 'exited' || run.end === 'step-timeout') {
      if (run.result.outcome !== 'success' && !step.continueOnError) {
        failed = true;
        firstFailure ??= describeFailure(run.result);
      }
    } else {
      stop = stopFor(ctx, run.end, run.result);
    }
  }

  if (stop) {
    return stop;
  }
  if (failed) {
    return { detail: firstFailure, reason: 'step-failed' };
  }
  return { reason: 'passed' };
}
