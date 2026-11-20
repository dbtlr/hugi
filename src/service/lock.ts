/**
 * The single-instance lock of `hugi serve` (`resolveServeLockPath`): the lock file opened with
 * darwin's `O_EXLOCK`, so the kernel holds an exclusive lock on it for as long as the file stays
 * open and drops it when the process exits, however it exits. There is never a stale lock to
 * judge. The file records the holder's pid, for a refusal and for `hugi service status`.
 *
 * `hugi service status` takes the lock for an instant to see whether it is free, so a start that
 * finds it held tries again for a moment before it refuses; and it reads a holder only when the
 * pid the file records is alive, since the file can still hold an earlier pid, or none, while a
 * new holder writes its own.
 */
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { FatalError } from '@loomcli/core';

import { errnoCode } from '../errno';

/** Exit 1: another `hugi serve` holds the lock, or this host is not macOS. */
export class ServeLockError extends FatalError {
  override readonly name = 'ServeLockError';
  static override readonly exitCode = 1;
}

/**
 * darwin's `O_EXLOCK` from `<fcntl.h>`: open the file with an exclusive `flock`. Node's
 * `fs.constants` does not export it, and Linux has no such flag.
 */
const O_EXLOCK = 0x20;

/**
 * Open, creating, with the exclusive lock, and without blocking: when any open file description,
 * in this process or another, holds the lock, the open fails with `EAGAIN` at once.
 */
const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK;

/** The lock is darwin's; the VM host is macOS. */
const LOCK_PLATFORM = 'darwin';

/**
 * How often a start tries a held lock, and how long it waits between tries: 180 ms in all, far
 * longer than a status probe holds it, and too short for a person to notice before the refusal.
 */
const LOCK_TRIES = 10;
const LOCK_RETRY_MS = 20;

const sleepFor = (ms: number): Promise<void> => delay(ms);

/** Who takes the lock: this process's pid, and the platform it runs on. */
export type ServeLockHolder = { readonly pid: number; readonly platform: string };

/** Open `path` with the lock, or `undefined` when another open holds it. */
async function openLocked(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, LOCK_FLAGS, 0o600);
  } catch (error) {
    if (errnoCode(error) === 'EAGAIN') {
      return undefined;
    }
    throw error;
  }
}

/** The pid the lock file records, or `undefined` when it records none (a holder between its open and its write). */
async function recordedPid(path: string): Promise<number | undefined> {
  const text = (await readFile(path, 'utf8')).trim();
  return /^\d+$/u.test(text) ? Number(text) : undefined;
}

function refusal(pid: number | undefined): ServeLockError {
  const holder = pid === undefined ? 'another hugi serve' : `hugi serve (pid ${pid})`;
  return new ServeLockError(
    `${holder} already runs for this user, so this one will not start. Stop it first.`,
  );
}

/** Open `path` with the lock, trying `LOCK_TRIES` times `LOCK_RETRY_MS` apart while another holds it. */
async function openLockedWithRetry(
  path: string,
  sleep: (ms: number) => Promise<void>,
): Promise<FileHandle | undefined> {
  for (let tries = 1; ; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each try waits for the one before it
    const handle = await openLocked(path);
    if (handle !== undefined || tries === LOCK_TRIES) {
      return handle;
    }
    // oxlint-disable-next-line no-await-in-loop -- the pause between tries
    await sleep(LOCK_RETRY_MS);
  }
}

/**
 * Take the lock, or throw a `ServeLockError` naming the holder once it has stayed held through
 * every try. The open handle is the lock: it is kept until `release` closes it, and the kernel
 * closes it when the process exits, so the caller must keep `release` reachable for as long as it
 * holds the lock. The file then holds this pid. Off darwin the service does not start at all.
 */
export async function acquireServeLock(
  path: string,
  holder: ServeLockHolder,
  sleep: (ms: number) => Promise<void> = sleepFor,
): Promise<() => Promise<void>> {
  if (holder.platform !== LOCK_PLATFORM) {
    throw new ServeLockError('hugi serve runs only on macOS, the host of its VMs.');
  }
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const handle = await openLockedWithRetry(path, sleep);
  if (handle === undefined) {
    throw refusal(await recordedPid(path));
  }
  try {
    await handle.truncate(0);
    await handle.write(`${holder.pid}\n`, 0);
  } catch (error) {
    await handle.close();
    throw error;
  }
  let released = false;
  return async () => {
    if (!released) {
      released = true;
      await handle.close();
    }
  };
}

/** Whether a process with this pid exists: signal 0 checks without sending, and `EPERM` means it exists. */
export function pidAlive(pid: number): boolean {
  try {
    // oxlint-disable-next-line @loomcli/host-bypass -- signal 0 asks after a pid; Host has no such check
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

/**
 * The pid recorded by the process that holds the lock at `path`, or `undefined` when nobody holds
 * it, or the pid it records is not alive (a new holder that has not yet replaced the pid before it).
 * It tries the lock as a starter does: an open that succeeds found it free, and closes at once.
 * Off darwin nobody can hold it.
 */
export async function serveLockHolder(path: string, platform: string): Promise<number | undefined> {
  if (platform !== LOCK_PLATFORM) {
    return undefined;
  }
  let handle: FileHandle | undefined;
  try {
    handle = await openLocked(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (handle !== undefined) {
    await handle.close();
    return undefined;
  }
  const pid = await recordedPid(path);
  return pid !== undefined && pidAlive(pid) ? pid : undefined;
}
