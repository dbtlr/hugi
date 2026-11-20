/**
 * The rows `hugi service status` adds under the unit: what the service wrote to its state file,
 * plus the VMs left behind and the log's path. The state describes the last time the service wrote
 * it, so it is live only while the `hugi serve` that wrote it still holds the single-instance lock,
 * whether launchd started it or not; otherwise the rows read from it say they are stale. Every
 * input comes in through `ProbeInput`.
 */
import type { ProbeContext, ServiceDetail } from '@loomcli/plugins/service';

import { messageOf } from '../errors';
import { SERVICE_VM_PREFIX } from '../vm/lifecycle';
import { isServiceStateError } from './state';
import type { ServiceState, ServiceStateError } from './state';

const STALE = ' (stale: the hugi serve that wrote it no longer runs)';

export type ProbeInput = {
  /** The state file's contents: absent, unreadable, or valid. */
  readonly state: ServiceState | ServiceStateError | undefined;
  /** The pid of the live `hugi serve` that holds the lock, if one does (`serveLockHolder`). */
  readonly lockHolder: number | undefined;
  readonly now: Date;
  /** The names of the VMs tart lists; may throw. */
  readonly listVms: () => Promise<readonly string[]>;
  readonly logPath: string;
};

/** A time as the clock reads it in the past, in one unit: `5s ago`, `3m ago`, `2h ago`, `3d ago`. */
export function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m ago`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ago`;
  }
  return `${Math.floor(seconds / 86_400)}d ago`;
}

const two = (value: number) => String(value).padStart(2, '0');

/** A duration as `12s`, `4m12s`, or `1h02m05s`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h${two(minutes)}m${two(seconds)}s`;
  }
  return minutes > 0 ? `${minutes}m${two(seconds)}s` : `${seconds}s`;
}

const ago = (iso: string, now: Date) =>
  `${iso} (${formatRelative(now.getTime() - Date.parse(iso))})`;

function runRow(state: ServiceState, now: Date): string {
  const { run } = state;
  if (run === undefined) {
    return 'idle';
  }
  const elapsed = formatElapsed(now.getTime() - Date.parse(run.startedAt));
  return `${run.statusName}, ${run.repository} @ ${run.commit.slice(0, 12)}, started ${run.startedAt}, ${elapsed} elapsed`;
}

function queueRow(state: ServiceState): string {
  return state.queue === undefined
    ? 'no poll yet'
    : `${state.queue.candidates} candidates, ${state.queue.waiting} waiting`;
}

function pollRow(state: ServiceState, now: Date): string {
  const poll = state.lastPoll;
  if (poll === undefined) {
    return 'no poll yet';
  }
  const result = poll.failures === 0 ? 'ok' : `${poll.failures} reads failed`;
  return `${ago(poll.endedAt, now)}, ${result}`;
}

function startRow(state: ServiceState, now: Date): string {
  const { start } = state;
  return start.kind === 'running'
    ? `started ${ago(state.startedAt, now)}`
    : `refused ${ago(start.at, now)}: ${start.reason}`;
}

/** The state, when it is usable and the process that wrote it still holds the lock. */
function liveState(input: ProbeInput): ServiceState | undefined {
  const { lockHolder, state } = input;
  return state !== undefined && !isServiceStateError(state) && state.pid === lockHolder
    ? state
    : undefined;
}

/** The four rows read from the state, in order; each says why when there is no usable state. */
function stateRows(input: ProbeInput): readonly ServiceDetail[] {
  const { now, state } = input;
  const names = ['run', 'queue', 'last poll', 'start'] as const;
  if (state === undefined || isServiceStateError(state)) {
    const value = state === undefined ? 'no state yet' : `state unreadable: ${state.message}`;
    return names.map((name) => ({ name, value }));
  }
  const suffix = liveState(input) === undefined ? STALE : '';
  const values = [runRow(state, now), queueRow(state), pollRow(state, now), startRow(state, now)];
  return names.map((name, index) => ({ name, value: `${values[index]}${suffix}` }));
}

/** The `hugi-svc-*` VMs left over, or why tart could not list them. */
async function leftoverVms(input: ProbeInput): Promise<string> {
  const inFlight = liveState(input)?.run?.vm;
  try {
    const names = (await input.listVms()).filter(
      (name) => name.startsWith(SERVICE_VM_PREFIX) && name !== inFlight,
    );
    return names.length === 0 ? 'none' : names.join(', ');
  } catch (error) {
    return messageOf(error);
  }
}

/** The rows `hugi service status` shows, in the README's order. */
export async function serviceRows(input: ProbeInput): Promise<readonly ServiceDetail[]> {
  return [
    ...stateRows(input),
    { name: 'leftover VMs', value: await leftoverVms(input) },
    { name: 'log', value: input.logPath },
  ];
}

export type ProbeDeps = {
  readonly readState: () => Promise<ServiceState | ServiceStateError | undefined>;
  /** The pid of the live `hugi serve` that holds the lock (`serveLockHolder`). */
  readonly lockHolder: () => Promise<number | undefined>;
  readonly listVms: () => Promise<readonly string[]>;
  readonly logPath: string;
  readonly now: () => Date;
};

/**
 * The `probe` for Loom's `ServiceSettings`. It ignores the manager's word on whether a process
 * runs: a `hugi serve` run by hand is live, and a process launchd restarted after a crash has not
 * yet written the state the crashed one left.
 */
export function createProbe(
  deps: ProbeDeps,
): (context: Pick<ProbeContext, 'state'>) => Promise<readonly ServiceDetail[]> {
  return async () =>
    serviceRows({
      listVms: deps.listVms,
      lockHolder: await deps.lockHolder(),
      logPath: deps.logPath,
      now: deps.now(),
      state: await deps.readState(),
    });
}
