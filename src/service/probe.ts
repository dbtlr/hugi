/**
 * The rows `hugi service status` adds under the unit: what the service wrote to its state file,
 * read with the manager's word on whether a process is running, plus the VMs left behind and the
 * log's path. The state describes the last time the service wrote it, so rows read from it say
 * they are stale when no process runs. Every input comes in through `ProbeInput`.
 */
import type { ProbeContext, ServiceDetail } from '@loomcli/plugins/service';

import { messageOf } from '../errors';
import { isServiceStateError } from './state';
import type { ServiceState, ServiceStateError } from './state';

/** The prefix of the VMs only `hugi serve` creates. */
const SERVICE_VM_PREFIX = 'hugi-svc-';

const STALE = ' (stale: no service process)';

export type ProbeInput = {
  /** The state file's contents: absent, unreadable, or valid. */
  readonly state: ServiceState | ServiceStateError | undefined;
  /** Whether the service manager reports a running process. */
  readonly running: boolean;
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

/** The four rows read from the state, in order; each says why when there is no usable state. */
function stateRows(input: ProbeInput): readonly ServiceDetail[] {
  const { now, running, state } = input;
  const names = ['run', 'queue', 'last poll', 'start'] as const;
  if (state === undefined || isServiceStateError(state)) {
    const value = state === undefined ? 'no state yet' : `state unreadable: ${state.message}`;
    return names.map((name) => ({ name, value }));
  }
  const suffix = running ? '' : STALE;
  const values = [runRow(state, now), queueRow(state), pollRow(state, now), startRow(state, now)];
  return names.map((name, index) => ({ name, value: `${values[index]}${suffix}` }));
}

/** The `hugi-svc-*` VMs left over, or why tart could not list them. */
async function leftoverVms(input: ProbeInput): Promise<string> {
  const inFlight =
    input.running && input.state !== undefined && !isServiceStateError(input.state)
      ? input.state.run?.vm
      : undefined;
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
  readonly listVms: () => Promise<readonly string[]>;
  readonly logPath: string;
  readonly now: () => Date;
};

/** The `probe` for Loom's `ServiceSettings`. */
export function createProbe(
  deps: ProbeDeps,
): (context: Pick<ProbeContext, 'state'>) => Promise<readonly ServiceDetail[]> {
  return async (context) =>
    serviceRows({
      listVms: deps.listVms,
      logPath: deps.logPath,
      now: deps.now(),
      running: context.state.running,
      state: await deps.readState(),
    });
}
