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
 * After "Install tools" the runner computes the tool environment (`./tool-steps`), and every step
 * runs with its `PATH` and variables. A `tools: mise` lane gets one more step after the checkout.
 * A `jdx/mise-action` step runs at its own place (`./mise-action-step`, ADR-0007); the steps after
 * one that ran no longer ignore the repository's mise config.
 *
 * GitHub's run-time conditions apply, including to the synthetic "Install
 * tools" step: after a failure, `success` steps are skipped while `always` and
 * `failure` steps still run. One exception: once the job times out, every
 * remaining step is skipped, `always` steps included.
 */
import type { ActionStep, PlanStep, RunStep, StepWhen } from '../lane/step-plan';
import type { MiseActionResolution } from '../toolchain/types';
import { buildWorkspaceScript, checkoutStepIndex } from './checkout';
import { withDeadline } from './deadline';
import {
  carriedGithubEnv,
  githubEnvironment,
  parseEnvFile,
  parseOutputFile,
  parsePathFile,
  prependPaths,
  stepEnvironment,
  toolVersionEnvironment,
  withoutToolVersions,
} from './guest-env';
import type { Environment } from './guest-env';
import { stepFiles } from './guest-paths';
import type { StepFiles } from './guest-paths';
import { runHostStep } from './host-step';
import type { HostStepContext, HostStepRun, HostStepVerdict } from './host-step';
import { copyGuestFile, killProcessGroup, readGuestFile } from './housekeeping';
import type { GuestCall } from './housekeeping';
import { openLogFile, stepLogName } from './logs';
import { runMiseActionStep } from './mise-action-step';
import type { RunRequest, StepResult } from './run-request';
import { shellQuote } from './shell';
import { buildStepLauncher } from './step-launcher';
import type { Clock, Tart } from './tart';
import {
  runMiseConfigStep,
  runToolEnvironment,
  MISE_CONFIG_STEP_NAME,
  workflowEnvironment,
} from './tool-steps';

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

/**
 * What ended a step, if anything other than its own exit. `infrastructure` is a step the runner
 * performs itself, the checkout, failing.
 */
type StepEnd =
  | 'exited'
  | 'step-timeout'
  | 'job-timeout'
  | 'interrupted'
  | 'vm-lost'
  | 'infrastructure';

/** Values earlier steps handed to later ones. */
type CarriedState = {
  readonly fromGithubEnv: Environment;
  readonly extraPath: readonly string[];
  /** The tool environment (ADR-0006) every step runs with once it is computed. */
  readonly toolEnvironment?: Environment;
  /** A `jdx/mise-action` step has run, so later steps read the repository's config (ADR-0007). */
  readonly afterMiseAction: boolean;
};

/** Hugi's own step that installs the tools the repository's mise config requests (`tools: mise`). */
type MiseConfigStep = {
  readonly kind: 'mise-config';
  readonly index: number;
  readonly name: string;
  readonly when: 'success';
};

const MILLISECONDS_PER_MINUTE = 60_000;

/** Whether a step with this `when` runs, given whether an earlier step has failed. */
export function shouldRun(when: StepWhen, anEarlierStepFailed: boolean): boolean {
  if (when === 'always') {
    return true;
  }
  return when === 'failure' ? anEarlierStepFailed : !anEarlierStepFailed;
}

function skipped(step: Pick<PlanStep, 'index' | 'name'>): StepResult {
  return { index: step.index, name: step.name, outcome: 'skipped', seconds: 0 };
}

const guestCall = (ctx: StepRunContext): GuestCall => ({
  clock: ctx.clock,
  deadlineMs: ctx.tuning.housekeepingMs,
  tart: ctx.tart,
  vm: ctx.vm,
});

/**
 * Start the step in the guest; a launcher that fails or does not answer is an infrastructure
 * error. An interrupt ends the launch at once and is not an error: the caller sees the interrupt
 * and kills whatever the launcher got started.
 */
async function launch(ctx: StepRunContext, step: RunStep, stdin: string): Promise<void> {
  let output = '';
  const started = await withDeadline(
    ctx.clock,
    ctx.tuning.housekeepingMs,
    (signal) =>
      ctx.tart.exec(ctx.vm, ['bash', '-s'], {
        onOutput: (chunk) => {
          output += chunk;
        },
        signal,
        stdin,
      }),
    { parent: ctx.interrupt, waitForWork: false },
  );
  if (ctx.interrupt.aborted) {
    return;
  }
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
 * Stream the step's guest log into its host log file, followed by `epilogue`, a
 * note of Hugi's own; a failed copy adds a note after whatever had arrived.
 */
async function copyLog(
  ctx: StepRunContext,
  step: RunStep,
  files: StepFiles,
  epilogue = '',
): Promise<string> {
  const log = await openLogFile(ctx.request.logDir, stepLogName(step.index, step.name));
  try {
    const copied = await copyGuestFile(guestCall(ctx), files.log, log.write);
    if (!copied.ok) {
      ctx.warn(`could not copy the log of step ${step.index} from ${ctx.vm}: ${copied.why}`);
      log.write(`hugi: could not copy this step's log from the VM (${copied.why})\n`);
    }
    log.write(epilogue);
  } finally {
    await log.close();
  }
  return log.path;
}

/** Read one of the step's command files; a guest that cannot answer is an infrastructure error. */
async function readCommandFile(ctx: StepRunContext, step: RunStep, path: string): Promise<string> {
  const text = await readGuestFile(guestCall(ctx), path, ctx.interrupt);
  if (!text.ok) {
    throw new Error(`could not read ${path} after step ${step.index} "${step.name}" (${text.why})`);
  }
  return text.value;
}

/**
 * Parse the step's `GITHUB_ENV` and `GITHUB_PATH` into the carried state and check its
 * `GITHUB_OUTPUT`, or say why one of them is invalid. The errors GitHub's runner logs for the
 * `GITHUB_ENV` writes it refuses come back for the step's log.
 */
async function applyCommandFiles(
  ctx: StepRunContext,
  step: RunStep,
  files: StepFiles,
  carried: CarriedState,
): Promise<
  { readonly carried: CarriedState; readonly refused: readonly string[] } | { readonly error: string }
> {
  const envText = await readCommandFile(ctx, step, files.env);
  const pathText = await readCommandFile(ctx, step, files.path);
  const outputError = parseOutputFile(await readCommandFile(ctx, step, files.output));
  const env = parseEnvFile(envText);
  if ('error' in env) {
    return { error: env.error };
  }
  if (outputError !== undefined) {
    return { error: outputError };
  }
  const kept = carriedGithubEnv(env.env);
  return {
    carried: {
      ...carried,
      extraPath: prependPaths(carried.extraPath, parsePathFile(pathText)),
      fromGithubEnv: { ...carried.fromGithubEnv, ...kept.env },
    },
    refused: kept.refused,
  };
}

/**
 * The checkout step: materialize the workspace from the staging repository, bounded by the job
 * deadline. Anything but a clean exit ends the run, since the failure lies outside the lane.
 */
function runCheckoutStep(
  ctx: StepRunContext,
  step: PlanStep,
  remainingMs: number,
): Promise<HostStepRun<never>> {
  return runHostStep(
    hostContext(ctx),
    step,
    remainingMs,
    async (tools): Promise<HostStepVerdict<never>> => {
      const exitCode = await tools.exec(buildWorkspaceScript(ctx.request));
      if (exitCode !== 0) {
        return { error: `the checkout failed with exit code ${exitCode}`, exitCode, ok: false };
      }
      return { exitCode, note: `checked out ${ctx.request.event.sha}`, ok: true };
    },
    true,
  );
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

/**
 * The runner's layer of a step's environment: GitHub's variables, the workflow tools' version
 * variables, and the tool environment. After a `jdx/mise-action` step has run, it no longer sets
 * `MISE_IGNORED_CONFIG_PATHS`, as GitHub's runner sets none (ADR-0007).
 */
function runnerEnvironment(ctx: StepRunContext, carried: CarriedState): Environment {
  const runner = {
    ...githubEnvironment(ctx.request.event),
    ...toolVersionEnvironment(ctx.request.tools),
    ...carried.toolEnvironment,
  };
  if (!carried.afterMiseAction) {
    return runner;
  }
  const { MISE_IGNORED_CONFIG_PATHS: _ignored, ...rest } = runner;
  return rest;
}

/** How long a step may run, and whether the job deadline, not its own timeout, is the limit. */
function stepLimit(step: PlanStep, remainingMs: number) {
  const stepLimitMs = (step.timeoutMinutes ?? Number.POSITIVE_INFINITY) * MILLISECONDS_PER_MINUTE;
  return { jobLimited: remainingMs <= stepLimitMs, limitMs: Math.min(stepLimitMs, remainingMs) };
}

async function runOneStep(
  ctx: StepRunContext,
  step: RunStep,
  carried: CarriedState,
  remainingMs: number,
): Promise<StepRun> {
  const { jobLimited, limitMs } = stepLimit(step, remainingMs);
  const files = stepFiles(step.index);
  const env = stepEnvironment({
    fromGithubEnv: carried.fromGithubEnv,
    plan: ctx.request.plan.env,
    runner: runnerEnvironment(ctx, carried),
    step: step.env,
  });
  const began = ctx.clock.now();
  await launch(ctx, step, buildStepLauncher({ env, extraPath: carried.extraPath, files, step }));

  const stopWaiting = AbortSignal.any([ctx.interrupt, ctx.vmLost]);
  const watched = await withDeadline(
    ctx.clock,
    limitMs,
    (signal) => waitForExit(ctx, files, signal),
    {
      parent: stopWaiting,
      waitForWork: true,
    },
  );
  if (!watched.ok) {
    throw new Error(`could not watch step ${step.index} "${step.name}" (${watched.why})`);
  }
  const { value: waited, timedOut } = watched;
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
  // An interrupt ends the run, so the step's command files no longer matter: skip them, and copy
  // the log within its own deadline, so teardown starts well inside the shutdown budget.
  const applied = ctx.interrupt.aborted
    ? undefined
    : await applyCommandFiles(ctx, step, files, carried).catch((error: unknown) => {
        // A read the interrupt cut short is no infrastructure failure.
        if (ctx.interrupt.aborted) {
          return undefined;
        }
        throw error;
      });
  if (applied === undefined) {
    const logFile = await copyLog(ctx, step, files);
    return {
      carried,
      end: 'interrupted',
      result: { ...base, exitCode, logFile, outcome: 'failure' },
    };
  }
  if ('error' in applied) {
    const logFile = await copyLog(ctx, step, files, `Error: ${applied.error}\n`);
    return {
      carried,
      end: 'exited',
      result: { ...base, error: applied.error, exitCode, logFile, outcome: 'failure' },
    };
  }
  const refusals = applied.refused.map((message) => `Error: ${message}\n`).join('');
  const logFile = await copyLog(ctx, step, files, refusals);
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

function hostContext(ctx: StepRunContext): HostStepContext {
  return {
    clock: ctx.clock,
    housekeepingMs: ctx.tuning.housekeepingMs,
    interrupt: ctx.interrupt,
    logDir: ctx.request.logDir,
    tart: ctx.tart,
    vm: ctx.vm,
    vmLost: ctx.vmLost,
  };
}

type Walk = {
  carried: CarriedState;
  failed: boolean;
  firstFailure: string | undefined;
  stop: Required<PlanOutcome> | undefined;
  /** The tool environment's computation has been tried. */
  toolEnvironmentTried: boolean;
  /** The plan's checkout step ran and succeeded. */
  checkedOut: boolean;
};

/** The step list: the tool install first, and for `tools: mise` the config install after the checkout. */
function stepsOf(
  request: RunRequest,
  install: RunStep | undefined,
): readonly (PlanStep | MiseConfigStep)[] {
  const { plan } = request;
  const checkout = checkoutStepIndex(plan);
  // Numbered after the plan's highest step number: the plan's numbers are the job's own, shown in
  // failure details, results and `hugi logs`, and they can have gaps where the reader dropped a
  // step whose `if:` was false, so the plan's length could name a real step.
  const miseStep: MiseConfigStep = {
    index: Math.max(0, ...plan.steps.map((step) => step.index)) + 1,
    kind: 'mise-config',
    name: MISE_CONFIG_STEP_NAME,
    when: 'success',
  };
  const planned = plan.steps.flatMap((step) =>
    request.toolSource === 'mise' && step.index === checkout ? [step, miseStep] : [step],
  );
  return install ? [install, ...planned] : planned;
}

/**
 * Compute the tool environment before the first plan step, once "Install tools" has passed; a
 * failure is a failing step of the lane, as a failed tool install is.
 */
async function computeToolEnvironment(
  ctx: StepRunContext,
  walk: Walk,
  results: StepResult[],
): Promise<void> {
  walk.toolEnvironmentTried = true;
  const remainingMs = ctx.jobDeadline - ctx.clock.now();
  if (walk.stop || walk.failed || remainingMs <= 0) {
    return;
  }
  const run = await runToolEnvironment(hostContext(ctx), ctx.request, remainingMs);
  if (run.end === 'exited' && run.result.outcome === 'success' && run.value) {
    walk.carried = { ...walk.carried, toolEnvironment: run.value };
    return;
  }
  results.push(run.result);
  if (run.end === 'exited') {
    walk.failed = true;
    walk.firstFailure ??= describeFailure(run.result);
  } else {
    walk.stop = stopFor(ctx, run.end, run.result);
  }
}

/**
 * Fold a step's end into the walk. `continue-on-error` lets a failure or a step timeout pass,
 * except a failure that is Hugi's own (ADR-0007); any other end stops the run.
 */
function foldStep(
  ctx: StepRunContext,
  walk: Walk,
  results: StepResult[],
  run: { readonly result: StepResult; readonly end: StepEnd },
  tolerated: boolean,
): void {
  const ranToEnd = run.end === 'exited' || run.end === 'step-timeout';
  const failedStep = ranToEnd && run.result.outcome !== 'success';
  results.push(failedStep && tolerated ? { ...run.result, continuedOnError: true } : run.result);
  if (!ranToEnd) {
    walk.stop = stopFor(ctx, run.end, run.result);
  } else if (failedStep && !tolerated) {
    walk.failed = true;
    walk.firstFailure ??= describeFailure(run.result);
  }
}

/**
 * Run a `jdx/mise-action` step at its place (ADR-0007). Its own mise commands run without Hugi's
 * runner `MISE_IGNORED_CONFIG_PATHS` and the workflow tools' version variables; what it wrote,
 * even before a failure, reaches later steps, which from now on read the repository's config.
 */
async function runMiseAction(
  ctx: StepRunContext,
  step: ActionStep,
  action: MiseActionResolution,
  walk: Walk,
  results: StepResult[],
  remainingMs: number,
): Promise<void> {
  const { carried } = walk;
  const { jobLimited, limitMs } = stepLimit(step, remainingMs);
  const { MISE_IGNORED_CONFIG_PATHS: _ignored, ...runner } = runnerEnvironment(ctx, carried);
  const env = stepEnvironment({
    fromGithubEnv: carried.fromGithubEnv,
    plan: ctx.request.plan.env,
    runner: withoutToolVersions(runner),
    step: step.env,
  });
  const run = await runMiseActionStep(
    hostContext(ctx),
    {
      env,
      extraPath: carried.extraPath,
      index: step.index,
      name: step.name,
      settings: action.settings,
      tools: ctx.request.tools,
      workflowEnv: workflowEnvironment(ctx.request),
      ...(carried.toolEnvironment?.PATH === undefined
        ? {}
        : { toolPath: carried.toolEnvironment.PATH }),
    },
    limitMs,
  );
  walk.carried = {
    ...carried,
    afterMiseAction: true,
    extraPath: prependPaths(carried.extraPath, parsePathFile(run.writes.path.join('\n'))),
    fromGithubEnv: { ...carried.fromGithubEnv, ...run.writes.env },
  };
  const end: StepEnd = run.end === 'job-timeout' && !jobLimited ? 'step-timeout' : run.end;
  foldStep(ctx, walk, results, { end, result: run.result }, step.continueOnError && !run.hugisOwn);
}

/** Run Hugi's own mise-config step and fold its verdict into the walk. */
async function runMiseConfig(
  ctx: StepRunContext,
  step: MiseConfigStep,
  walk: Walk,
  results: StepResult[],
  remainingMs: number,
): Promise<void> {
  const first = walk.carried.toolEnvironment;
  if (first === undefined) {
    results.push(skipped(step));
    return;
  }
  const run = await runMiseConfigStep(
    hostContext(ctx),
    step.index,
    ctx.request,
    first,
    remainingMs,
  );
  results.push(run.result);
  if (run.end !== 'exited') {
    walk.stop = stopFor(ctx, run.end, run.result);
  } else if (run.result.outcome === 'success' && run.value) {
    walk.carried = { ...walk.carried, toolEnvironment: run.value };
  } else {
    walk.failed = true;
    walk.firstFailure ??= describeFailure(run.result);
  }
}

/**
 * Execute the request's tool install and every step of its plan, appending
 * each step's result to `results` as it finishes, so a caller keeps them even
 * when this throws. Steps never run after the job timeout, an interrupt, or
 * the loss of the VM.
 */
export async function runSteps(ctx: StepRunContext, results: StepResult[]): Promise<PlanOutcome> {
  const walk: Walk = {
    carried: { afterMiseAction: false, extraPath: [], fromGithubEnv: {} },
    checkedOut: false,
    failed: false,
    firstFailure: undefined,
    stop: undefined,
    toolEnvironmentTried: false,
  };
  const checkoutIndex = checkoutStepIndex(ctx.request.plan);
  const install = installToolsStep(ctx.request.tools);
  const miseActions = new Map(ctx.request.miseActions?.map((action) => [action.index, action]));

  for (const step of stepsOf(ctx.request, install)) {
    if (!walk.toolEnvironmentTried && step !== install) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await computeToolEnvironment(ctx, walk, results);
    }
    const remainingMs = ctx.jobDeadline - ctx.clock.now();
    const miseAction = step.kind === 'action' ? miseActions.get(step.index) : undefined;
    const performed =
      step.kind !== 'action' || step.index === checkoutIndex || miseAction !== undefined;
    const wanted = step.kind === 'mise-config' ? walk.checkedOut : true;
    if (walk.stop || !performed || !wanted || !shouldRun(step.when, walk.failed)) {
      results.push(skipped(step));
      continue;
    }
    if (ctx.interrupt.aborted) {
      walk.stop = { detail: 'interrupted before the plan finished', reason: 'interrupted' };
      results.push(skipped(step));
      continue;
    }
    if (remainingMs <= 0) {
      walk.stop = {
        detail: `job timed out after ${ctx.request.plan.timeoutMinutes} minutes`,
        reason: 'timeout',
      };
      results.push(skipped(step));
      continue;
    }
    if (step.kind === 'mise-config') {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await runMiseConfig(ctx, step, walk, results, remainingMs);
      continue;
    }
    if (step.kind === 'action' && miseAction !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await runMiseAction(ctx, step, miseAction, walk, results, remainingMs);
      continue;
    }
    if (step.kind === 'action') {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      const checkout = await runCheckoutStep(ctx, step, remainingMs);
      results.push(checkout.result);
      walk.checkedOut = checkout.end === 'exited';
      if (checkout.end !== 'exited') {
        walk.stop = stopFor(ctx, checkout.end, checkout.result);
      }
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential by design
    const run = await runOneStep(ctx, step, walk.carried, remainingMs);
    walk.carried = run.carried;
    foldStep(ctx, walk, results, run, step.continueOnError);
  }

  if (walk.stop) {
    return walk.stop;
  }
  if (walk.failed) {
    return { detail: walk.firstFailure, reason: 'step-failed' };
  }
  return { reason: 'passed' };
}
