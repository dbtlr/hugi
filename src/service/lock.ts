/**
 * The single-instance lock of `hugi serve` (`resolveServeLockPath`): the lock file opened with
 * darwin's `O_EXLOCK`, so the kernel holds an exclusive lock on it for as long as the file stays
 * open and drops it when the process exits, however it exits. There is never a stale lock to
 * judge. The file records the holder's pid, for a refusal and for `hugi service status`.
 */
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

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

/**
 * Take the lock, or throw a `ServeLockError` naming the holder. The open handle is the lock: it is
 * kept until `release` closes it, and the kernel closes it when the process exits. The file then
 * holds this pid. Off darwin the service does not start at all.
 */
export async function acquireServeLock(
  path: string,
  holder: ServeLockHolder,
): Promise<() => Promise<void>> {
  if (holder.platform !== LOCK_PLATFORM) {
    throw new ServeLockError('hugi serve runs only on macOS, the host of its VMs.');
  }
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const handle = await openLocked(path);
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

/**
 * The pid recorded by the process that holds the lock at `path`, or `undefined` when nobody holds
 * it. It tries the lock as a starter does: an open that succeeds found it free, and closes at once.
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
  return recordedPid(path);
}
