/**
 * The service state file, `service.json` in Hugi's state directory: what `hugi serve` last wrote
 * about itself, for `hugi service status` to show. It describes the last time the service wrote
 * it, so a reader treats it as stale when no service process is running. A reader never trusts the
 * file: every field is validated.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { messageOf } from '../errors';
import { isIsoTimestamp } from '../runs/record';

/** The state file's name inside the state directory. */
export const SERVICE_STATE_FILE = 'service.json';

/** The run in flight; `vm` is its `hugi-svc-*` VM, which `status` leaves out of the leftovers. */
export type ServiceRun = {
  readonly statusName: string;
  readonly repository: string;
  readonly commit: string;
  readonly vm: string;
  /** ISO 8601 UTC. */
  readonly startedAt: string;
};

export type ServiceStart =
  | { readonly kind: 'running' }
  | { readonly kind: 'refused'; readonly at: string; readonly reason: string };

export type ServiceState = {
  readonly pid: number;
  /** ISO 8601 UTC. */
  readonly startedAt: string;
  readonly start: ServiceStart;
  readonly lastPoll?: { readonly endedAt: string; readonly failures: number };
  readonly queue?: { readonly candidates: number; readonly waiting: number };
  readonly run?: ServiceRun;
};

/** The state file exists but cannot be used; `message` says why and names the file. */
export type ServiceStateError = { readonly kind: 'error'; readonly message: string };

export function isServiceStateError(
  value: ServiceState | ServiceStateError | undefined,
): value is ServiceStateError {
  return value !== undefined && 'kind' in value;
}

/**
 * Write the state atomically: a temporary file in the same directory, then a rename, so a reader
 * sees the old state or the whole new one. The directory is created private to the user.
 */
export async function writeServiceState(dir: string, state: ServiceState): Promise<void> {
  await mkdir(dir, { mode: 0o700, recursive: true });
  const temporary = join(dir, `.${SERVICE_STATE_FILE}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, join(dir, SERVICE_STATE_FILE));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function isStart(value: unknown): value is ServiceStart {
  if (!isObject(value)) {
    return false;
  }
  if (value.kind === 'running') {
    return true;
  }
  return value.kind === 'refused' && isIsoTimestamp(value.at) && isText(value.reason);
}

function isRun(value: unknown): value is ServiceRun {
  return (
    isObject(value) &&
    isText(value.statusName) &&
    isText(value.repository) &&
    isText(value.commit) &&
    isText(value.vm) &&
    isIsoTimestamp(value.startedAt)
  );
}

function isLastPoll(value: unknown): boolean {
  return isObject(value) && isIsoTimestamp(value.endedAt) && isCount(value.failures);
}

function isQueue(value: unknown): boolean {
  return isObject(value) && isCount(value.candidates) && isCount(value.waiting);
}

function isState(value: unknown): value is ServiceState {
  return (
    isObject(value) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    isIsoTimestamp(value.startedAt) &&
    isStart(value.start) &&
    (value.lastPoll === undefined || isLastPoll(value.lastPoll)) &&
    (value.queue === undefined || isQueue(value.queue)) &&
    (value.run === undefined || isRun(value.run))
  );
}

/** Read the state: `undefined` when there is no file, an error result when it cannot be used. */
export async function readServiceState(
  dir: string,
): Promise<ServiceState | ServiceStateError | undefined> {
  const path = join(dir, SERVICE_STATE_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    return { kind: 'error', message: `The service state ${path} cannot be read: ${messageOf(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { kind: 'error', message: `The service state ${path} is not valid JSON: ${messageOf(error)}` };
  }
  if (!isState(parsed)) {
    return { kind: 'error', message: `${path} is not a Hugi service state.` };
  }
  return parsed;
}
