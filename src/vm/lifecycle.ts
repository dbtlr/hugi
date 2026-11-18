/**
 * One run in one throwaway VM: clone the image, boot, fetch the source, run
 * the plan, and delete the VM on every exit path (ADR-0003). The host never
 * executes a step; it drives tart and reads logs. The workspace stays empty
 * until the plan's checkout step (see `./checkout`).
 *
 * The job's `timeout-minutes` starts once the VM answers and covers the
 * source fetch and every step, as on GitHub; a fetch still running at the
 * deadline is `infrastructure`, since it lies outside the lane's steps. After
 * boot the runner watches the `tart run` process, and a VM that exits ends the
 * run as `infrastructure`. Every housekeeping call (status polls, log copies,
 * kills, `tart stop`) has a short deadline of its own, so teardown always
 * reaches `tart delete`.
 */
import { messageOf } from '../errors';
import { buildCheckoutScript } from './checkout';
import { withDeadline } from './deadline';
import { LOCAL_SOURCE_SHARE_NAME } from './guest-paths';
import { openLogFile } from './logs';
import type { RunReason, RunRequest, RunResult, StepResult } from './run-request';
import { runSteps } from './step-executor';
import type { StepTuning } from './step-executor';
import type { Clock, Tart, VmProcess } from './tart';

export const VM_NAME_PREFIX = 'hugi-run-';

/** The VM size every run gets. */
export const VM_RESOURCES = { cpus: 4, memoryMb: 4096 } as const;

export type RunTuning = StepTuning & {
  /** How long the guest agent may take to answer after `tart run`. */
  readonly bootTimeoutMs: number;
  readonly deleteAttempts: number;
  readonly deleteRetryMs: number;
  /** How long the `tart run` process may take to exit after a stop or a kill. */
  readonly stopGraceMs: number;
};

export const DEFAULT_TUNING: RunTuning = {
  agentFailureLimit: 3,
  bootTimeoutMs: 5 * 60_000,
  deleteAttempts: 3,
  deleteRetryMs: 2000,
  guestPollMs: 1000,
  housekeepingMs: 30_000,
  stopGraceMs: 30_000,
};

export type RunDeps = {
  readonly tart: Tart;
  readonly clock: Clock;
  /** Aborts when Hugi is asked to stop (SIGINT/SIGTERM); the run cleans up and reports `interrupted`. */
  readonly interrupt: AbortSignal;
  /** A short unique suffix for the VM name. */
  readonly newId: () => string;
  /** Where cleanup problems and other non-fatal trouble are reported. */
  readonly warn: (message: string) => void;
  readonly tuning?: Partial<RunTuning>;
};

/** What the run did before it ended, for assembling the result and for teardown. */
type RunState = {
  /** `tart clone` was started; it can fail after creating the VM. */
  cloneStarted: boolean;
  vmCloned: boolean;
  vmProcess?: VmProcess;
  cloneSeconds: number;
  bootSeconds: number;
  /** Results of the steps that have finished, kept even when the run throws part-way. */
  readonly steps: StepResult[];
};

type Ending = { readonly reason: RunReason; readonly detail?: string };

const seconds = (clock: Clock, since: number): number => (clock.now() - since) / 1000;

/** Wait for the guest agent to answer, or fail when the VM exits or the boot deadline passes. */
async function waitForGuest(
  deps: RunDeps,
  tuning: RunTuning,
  vm: string,
  process: VmProcess,
): Promise<Ending | undefined> {
  let exitCode: number | undefined;
  const watchExit = async (): Promise<void> => {
    exitCode = await process.exited;
  };
  void watchExit();

  const watched = await withDeadline(
    deps.clock,
    tuning.bootTimeoutMs,
    async (signal) => {
      while (!signal.aborted) {
        if (exitCode !== undefined) {
          return 'exited' as const;
        }
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        const probe = await deps.tart.exec(vm, ['true'], { signal }).catch(() => ({ exitCode: 1 }));
        if (probe.exitCode === 0) {
          return 'ready' as const;
        }
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        await deps.clock.sleep(tuning.guestPollMs, signal);
      }
      return 'aborted' as const;
    },
    { parent: deps.interrupt, waitForWork: true },
  );
  if (!watched.ok) {
    throw new Error(`could not wait for the guest agent: ${watched.why}`);
  }
  const { value, timedOut } = watched;
  if (value === 'ready') {
    return undefined;
  }
  if (deps.interrupt.aborted) {
    return { detail: 'interrupted while the VM booted', reason: 'interrupted' };
  }
  const tail = process.output().trim().split('\n').slice(-3).join(' | ');
  if (value === 'exited') {
    return {
      detail: `the VM exited during boot (code ${exitCode}): ${tail}`,
      reason: 'infrastructure',
    };
  }
  return {
    detail: timedOut
      ? `the guest agent did not answer within ${tuning.bootTimeoutMs / 1000}s`
      : 'boot aborted',
    reason: 'infrastructure',
  };
}

/**
 * Fetch the commit into the guest's staging repository; undefined on success.
 * Bounded by the job deadline, and cut short when the VM exits.
 */
async function fetchSource(
  deps: RunDeps,
  request: RunRequest,
  vm: string,
  jobDeadline: number,
  vmLost: AbortSignal,
): Promise<Ending | undefined> {
  const log = await openLogFile(request.logDir, '00-checkout.log');
  try {
    const fetched = await withDeadline(
      deps.clock,
      jobDeadline - deps.clock.now(),
      (signal) =>
        deps.tart.exec(vm, ['bash', '-s'], {
          onOutput: (chunk) => log.write(chunk),
          signal,
          stdin: buildCheckoutScript(request),
        }),
      { parent: AbortSignal.any([deps.interrupt, vmLost]), waitForWork: true },
    );
    if (vmLost.aborted) {
      return { detail: 'the VM exited while fetching the source', reason: 'infrastructure' };
    }
    if (deps.interrupt.aborted) {
      return { detail: 'interrupted while fetching the source', reason: 'interrupted' };
    }
    if (fetched.timedOut) {
      return { detail: 'fetching the source timed out', reason: 'infrastructure' };
    }
    if (!fetched.ok) {
      return { detail: fetched.why, reason: 'infrastructure' };
    }
    return fetched.value.exitCode === 0
      ? undefined
      : {
          detail: `fetching ${request.event.sha} failed with exit code ${fetched.value.exitCode} (see ${log.path})`,
          reason: 'infrastructure',
        };
  } finally {
    await log.close();
  }
}

/** A signal that aborts once the booted VM's `tart run` process exits. */
function watchVm(process: VmProcess): AbortSignal {
  const lost = new AbortController();
  const watch = async (): Promise<void> => {
    await process.exited;
    lost.abort();
  };
  void watch();
  return lost.signal;
}

/** Everything between clone and teardown. Records progress in `state`; returns how the run ended. */
async function perform(
  deps: RunDeps,
  tuning: RunTuning,
  request: RunRequest,
  vm: string,
  state: RunState,
): Promise<Ending> {
  const { tart, clock } = deps;
  if (deps.interrupt.aborted) {
    return { detail: 'interrupted before the run started', reason: 'interrupted' };
  }

  const cloneStart = clock.now();
  state.cloneStarted = true;
  await tart.clone(request.image, vm);
  state.vmCloned = true;
  await tart.setResources(vm, VM_RESOURCES);
  state.cloneSeconds = seconds(clock, cloneStart);
  if (deps.interrupt.aborted) {
    return { detail: 'interrupted after cloning', reason: 'interrupted' };
  }

  const bootStart = clock.now();
  const readOnlyShares =
    request.source.kind === 'local'
      ? [{ hostPath: request.source.path, name: LOCAL_SOURCE_SHARE_NAME }]
      : [];
  state.vmProcess = tart.run(vm, { readOnlyShares });
  const bootFailure = await waitForGuest(deps, tuning, vm, state.vmProcess);
  state.bootSeconds = seconds(clock, bootStart);
  if (bootFailure) {
    return bootFailure;
  }

  const vmLost = watchVm(state.vmProcess);
  const jobDeadline = clock.now() + request.plan.timeoutMinutes * 60_000;
  const fetchFailure = await fetchSource(deps, request, vm, jobDeadline, vmLost);
  if (fetchFailure) {
    return fetchFailure;
  }

  return runSteps(
    {
      clock,
      interrupt: deps.interrupt,
      jobDeadline,
      request,
      tart,
      tuning,
      vm,
      vmLost,
      warn: deps.warn,
    },
    state.steps,
  );
}

/** Delete the VM, retrying briefly since a VM still shutting down refuses deletion. */
async function deleteVm(deps: RunDeps, tuning: RunTuning, vm: string): Promise<void> {
  for (let attempt = 1; attempt <= tuning.deleteAttempts; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await deps.tart.delete(vm);
      return;
    } catch (error) {
      const last = attempt === tuning.deleteAttempts;
      deps.warn(
        `could not delete ${vm} (attempt ${attempt}/${tuning.deleteAttempts})${last ? '; it is leaked and needs `tart delete`' : ''}: ${String(error)}`,
      );
      if (!last) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        await deps.clock.sleep(tuning.deleteRetryMs);
      }
    }
  }
}

/** Whether the VM process exits within the stop grace. */
async function exitsWithinGrace(
  deps: RunDeps,
  tuning: RunTuning,
  process: VmProcess,
): Promise<boolean> {
  const cancel = new AbortController();
  const exited = async (): Promise<boolean> => {
    await process.exited;
    return true;
  };
  const graceOver = async (): Promise<boolean> => {
    await deps.clock.sleep(tuning.stopGraceMs, cancel.signal);
    return false;
  };
  try {
    return await Promise.race([exited(), graceOver()]);
  } finally {
    cancel.abort();
  }
}

/**
 * Stop the VM if it was started, then delete it if it was cloned, or try once if its clone
 * failed part-way. A stop that
 * fails or misses its deadline, or a VM that keeps running after it, gets the
 * `tart run` process killed, so the delete is always attempted. Never throws.
 */
async function teardown(
  deps: RunDeps,
  tuning: RunTuning,
  vm: string,
  state: RunState,
): Promise<void> {
  if (state.vmProcess) {
    const stopped = await withDeadline(
      deps.clock,
      tuning.housekeepingMs,
      (signal) => deps.tart.stop(vm, { signal }),
      { waitForWork: false },
    );
    if (!stopped.ok) {
      deps.warn(`could not stop ${vm}; killing its tart run process: ${stopped.why}`);
      state.vmProcess.kill();
    }
    if (!(await exitsWithinGrace(deps, tuning, state.vmProcess))) {
      deps.warn(`${vm} kept running after the stop; killing its tart run process`);
      state.vmProcess.kill();
      await exitsWithinGrace(deps, tuning, state.vmProcess);
    }
  }
  if (state.vmCloned) {
    await deleteVm(deps, tuning, vm);
  } else if (state.cloneStarted) {
    await deleteCloneLeftover(deps, vm);
  }
}

/** One delete of the VM a failed `tart clone` may have created before it failed. */
async function deleteCloneLeftover(deps: RunDeps, vm: string): Promise<void> {
  try {
    await deps.tart.delete(vm);
  } catch (error) {
    deps.warn(
      `the failed clone may have left ${vm} behind; if \`tart list\` shows it, run \`tart delete ${vm}\`: ${String(error)}`,
    );
  }
}

/** `none` for the reasons that say nothing about the code. */
export function verdictFor(reason: RunReason): RunResult['verdict'] {
  if (reason === 'passed') {
    return 'pass';
  }
  return reason === 'infrastructure' || reason === 'interrupted' ? 'none' : 'fail';
}

/**
 * Run the request's plan in a fresh VM and delete the VM afterwards, whatever
 * happens. Never throws: a failure of the run itself is an `infrastructure`
 * result with the error as its detail.
 */
export async function runInVm(request: RunRequest, deps: RunDeps): Promise<RunResult> {
  const tuning = { ...DEFAULT_TUNING, ...deps.tuning };
  const began = deps.clock.now();
  const vm = `${VM_NAME_PREFIX}${deps.newId()}`;
  const state: RunState = {
    bootSeconds: 0,
    cloneSeconds: 0,
    cloneStarted: false,
    steps: [],
    vmCloned: false,
  };
  let ending: Ending;
  try {
    ending = await perform(deps, tuning, request, vm, state);
  } catch (error) {
    ending = deps.interrupt.aborted
      ? { detail: 'interrupted', reason: 'interrupted' }
      : {
          detail: messageOf(error),
          reason: 'infrastructure',
        };
  }
  await teardown(deps, tuning, vm, state);
  return {
    reason: ending.reason,
    steps: state.steps,
    timings: {
      bootSeconds: state.bootSeconds,
      cloneSeconds: state.cloneSeconds,
      totalSeconds: seconds(deps.clock, began),
    },
    verdict: verdictFor(ending.reason),
    ...(ending.detail === undefined ? {} : { detail: ending.detail }),
  };
}
