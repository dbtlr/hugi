/**
 * Teardown: stop the VM if it was started, then delete it, so no run leaves a `hugi-run-*` (or
 * `hugi-svc-*`) VM behind (ADR-0003). It has a fixed time budget and always reaches `tart delete`: stopping may use
 * only the part of the budget before the delete's reserve, so a hung stop cannot starve the delete.
 * A delete that still fails is reported as a typed `leaked` outcome naming the VM.
 */
import { resolvesWithin, withDeadline } from './deadline';
import type { Clock, Tart, VmProcess } from './tart';
import { TartCallError } from './tart';
import { TART_DELETE_DEADLINE_MS, TART_ESCALATION_MS, TART_STOP_DEADLINE_MS } from './tart-process';

/**
 * The most time teardown takes, from its start to the end of the last delete attempt. It sits inside
 * the app's shutdown limit with the interrupted step's own cleanup (see `SHUTDOWN_BUDGET_MS`).
 */
export const TEARDOWN_BUDGET_MS = 100_000;
/**
 * The part of the budget held back for the delete. Stopping and waiting for the VM process to exit
 * end by `TEARDOWN_BUDGET_MS - DELETE_RESERVE_MS`, which leaves the delete two full attempts.
 */
export const DELETE_RESERVE_MS = 60_000;
/** The shortest deadline worth a delete attempt. */
const MIN_DELETE_ATTEMPT_MS = 5000;

export type TeardownTuning = {
  /** How long a stop may take at most (further capped by the stop deadline and the budget). */
  readonly housekeepingMs: number;
  /** How long the `tart run` process may take to exit after a stop or a kill. */
  readonly stopGraceMs: number;
  readonly deleteAttempts: number;
  readonly deleteRetryMs: number;
  readonly teardownBudgetMs: number;
  readonly deleteReserveMs: number;
};

export type TeardownDeps = {
  readonly tart: Tart;
  readonly clock: Clock;
  readonly warn: (message: string) => void;
};

/** What the run did that teardown has to undo. */
export type TeardownState = {
  /** `tart clone` was started; it can fail after creating the VM. */
  readonly cloneStarted: boolean;
  readonly vmCloned: boolean;
  readonly vmProcess?: VmProcess;
};

/**
 * `deleted`: the VM is gone. `nothing-to-delete`: the run never started a clone.
 * `leaked`: the VM may remain, and an operator has to run `tart delete <vm>`; `failure` says why.
 */
export type TeardownOutcome =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'nothing-to-delete' }
  | {
      readonly kind: 'leaked';
      readonly vm: string;
      readonly failure: 'timed-out' | 'killed' | 'failed';
      readonly detail: string;
    };

const remaining = (clock: Clock, end: number): number => Math.max(0, end - clock.now());

/** Whether the VM process exits within `milliseconds`. */
const exitsWithin = async (
  clock: Clock,
  process: VmProcess,
  milliseconds: number,
): Promise<boolean> => (await resolvesWithin(clock, process.exited, milliseconds)) !== undefined;

/**
 * Stop the VM and wait for its process to exit, all before `end`. A stop that fails or misses its
 * deadline, or a VM that keeps running after it, gets the `tart run` process killed.
 */
async function stopVm(
  deps: TeardownDeps,
  tuning: TeardownTuning,
  vm: string,
  process: VmProcess,
  end: number,
): Promise<void> {
  const { clock } = deps;
  const stopped = await withDeadline(
    clock,
    Math.min(tuning.housekeepingMs, TART_STOP_DEADLINE_MS, remaining(clock, end)),
    (signal) => deps.tart.stop(vm, { signal }),
    { waitForWork: false },
  );
  if (!stopped.ok) {
    deps.warn(`could not stop ${vm}; killing its tart run process: ${stopped.why}`);
    process.kill();
  }
  const grace = (): number => Math.min(tuning.stopGraceMs, remaining(clock, end));
  if (!(await exitsWithin(clock, process, grace()))) {
    deps.warn(`${vm} kept running after the stop; killing its tart run process`);
    process.kill();
    await exitsWithin(clock, process, grace());
  }
}

const failureOf = (error: unknown): 'timed-out' | 'killed' | 'failed' =>
  error instanceof TartCallError ? error.failure : 'failed';

/**
 * Delete the VM, retrying briefly since a VM still shutting down refuses deletion, until the
 * budget's end. The first attempt always runs. A VM whose clone failed part-way gets one attempt.
 */
async function deleteVm(
  deps: TeardownDeps,
  tuning: TeardownTuning,
  vm: string,
  end: number,
  cloneCompleted: boolean,
): Promise<TeardownOutcome> {
  const attempts = cloneCompleted ? tuning.deleteAttempts : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A call can run past its deadline by the escalation time; leave room for that.
    const room = remaining(deps.clock, end) - TART_ESCALATION_MS;
    const deadlineMs = Math.min(TART_DELETE_DEADLINE_MS, room);
    if (attempt > 1 && deadlineMs < MIN_DELETE_ATTEMPT_MS) {
      break;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential by design
      await deps.tart.delete(vm, { deadlineMs: Math.max(MIN_DELETE_ATTEMPT_MS, deadlineMs) });
      return { kind: 'deleted' };
    } catch (error) {
      lastError = error;
      const last = attempt === attempts;
      deps.warn(
        cloneCompleted
          ? `could not delete ${vm} (attempt ${attempt}/${attempts})${last ? '; it is leaked and needs `tart delete`' : ''}: ${String(error)}`
          : `the failed clone may have left ${vm} behind; if \`tart list\` shows it, run \`tart delete ${vm}\`: ${String(error)}`,
      );
      if (!last) {
        // oxlint-disable-next-line no-await-in-loop -- sequential by design
        await deps.clock.sleep(Math.min(tuning.deleteRetryMs, remaining(deps.clock, end)));
      }
    }
  }
  const detail = `${vm} was not deleted and needs \`tart delete ${vm}\`: ${String(lastError)}`;
  return { detail, failure: failureOf(lastError), kind: 'leaked', vm };
}

/**
 * Stop the VM if it was started, then delete it if it was cloned, or try once if its clone failed
 * part-way, all within `tuning.teardownBudgetMs`. Never throws.
 */
export async function teardown(
  deps: TeardownDeps,
  tuning: TeardownTuning,
  vm: string,
  state: TeardownState,
): Promise<TeardownOutcome> {
  const budgetEnd = deps.clock.now() + tuning.teardownBudgetMs;
  if (state.vmProcess) {
    await stopVm(deps, tuning, vm, state.vmProcess, budgetEnd - tuning.deleteReserveMs);
  }
  if (!state.cloneStarted) {
    return { kind: 'nothing-to-delete' };
  }
  return deleteVm(deps, tuning, vm, budgetEnd, state.vmCloned);
}
