/**
 * How `hugi serve` starts and runs (README, "Running the coordinator"): take the single-instance
 * lock, load the configuration and check the setup, record the start in the service state, delete
 * the `hugi-svc-*` VMs a crash left, then run the coordinator until it is stopped, keeping the
 * state current from its events. A refused start is recorded in the state, because launchd
 * discards an agent's output; a held lock is the exception, since the state then belongs
 * to the service that holds it. The refusal reaches the service log as the command's failure,
 * which Loom's logging plugin records, so it is not logged here as well. Every collaborator is
 * injected.
 */
import type { HugiConfig } from '../config/schema';
import { messageOf } from '../errors';
import { SERVICE_VM_PREFIX } from '../vm/lifecycle';
import type { SweepResult } from '../vm/sweep';
import type { CoordinatorEvent, CoordinatorLog } from './loop';
import type { ServiceState } from './state';

/** The start's collaborators. `Setup` is what the setup check found, which the sweep and the loop use. */
export type StartDeps<Setup> = {
  /** Take the lock, or throw `ServeLockError`; returns the release. */
  readonly acquireLock: () => Promise<() => Promise<void>>;
  readonly loadConfig: () => Promise<HugiConfig>;
  /** Throw, saying what to fix, unless the App key and the host tools are usable; else return what it found. */
  readonly checkSetup: (config: HugiConfig) => Promise<Setup>;
  /** Delete the `hugi-svc-*` VMs; a failed listing throws. */
  readonly sweep: (setup: Setup) => Promise<SweepResult>;
  readonly writeState: (state: ServiceState) => Promise<void>;
  /** Run the coordinator until it is stopped, reporting its events. */
  readonly coordinate: (
    config: HugiConfig,
    setup: Setup,
    report: (event: CoordinatorEvent) => Promise<void>,
  ) => Promise<void>;
  readonly log: CoordinatorLog;
  readonly now: () => Date;
  readonly pid: number;
};

/**
 * The state after one coordinator event. A run is in flight from when its candidate is taken; its
 * VM is added once known, and its start time stays the time it was taken.
 */
export function applyEvent(state: ServiceState, event: CoordinatorEvent, now: Date): ServiceState {
  const at = now.toISOString();
  switch (event.kind) {
    case 'poll-ended': {
      return {
        ...state,
        lastPoll: { endedAt: at, failures: event.failures },
        queue: { candidates: event.queued, waiting: event.waiting },
      };
    }
    case 'run-started': {
      const { commit, repository, statusName, vmId } = event;
      return {
        ...state,
        run: {
          commit,
          repository,
          startedAt: state.run?.startedAt ?? at,
          statusName,
          ...(vmId === undefined ? {} : { vm: `${SERVICE_VM_PREFIX}${vmId}` }),
        },
      };
    }
    case 'run-ended': {
      const { run: _ended, ...rest } = state;
      return rest;
    }
    default: {
      return state;
    }
  }
}

/** Log what the startup sweep did; a failed sweep is an error, and the service still starts. */
async function sweepLeftovers<Setup>(deps: StartDeps<Setup>, setup: Setup): Promise<void> {
  let result: SweepResult;
  try {
    result = await deps.sweep(setup);
  } catch (error) {
    deps.log.error(`Could not sweep leftover VMs: ${messageOf(error)}`);
    return;
  }
  for (const vm of result.deleted) {
    deps.log.info(`Deleted leftover VM ${vm}.`);
  }
  for (const { message, vm } of result.failed) {
    deps.log.error(`Could not delete leftover VM ${vm}: ${message}`);
  }
}

export async function startService<Setup>(deps: StartDeps<Setup>): Promise<void> {
  const release = await deps.acquireLock();
  const write = async (state: ServiceState): Promise<void> => {
    try {
      await deps.writeState(state);
    } catch (error) {
      deps.log.warn(`Could not write the service state: ${messageOf(error)}`);
    }
  };
  try {
    const startedAt = deps.now().toISOString();
    let config: HugiConfig;
    let setup: Setup;
    try {
      config = await deps.loadConfig();
      setup = await deps.checkSetup(config);
    } catch (error) {
      const reason = messageOf(error);
      await write({
        pid: deps.pid,
        start: { at: deps.now().toISOString(), kind: 'refused', reason },
        startedAt,
      });
      throw error;
    }
    let state: ServiceState = { pid: deps.pid, start: { kind: 'running' }, startedAt };
    await write(state);
    deps.log.info(`hugi serve started (pid ${deps.pid}).`);
    await sweepLeftovers(deps, setup);
    await deps.coordinate(config, setup, async (event) => {
      state = applyEvent(state, event, deps.now());
      await write(state);
    });
    deps.log.info('hugi serve stopped.');
  } finally {
    await release();
  }
}
