/**
 * An exclusive lock the kernel holds: a file opened with darwin's `O_EXLOCK`. The lock lasts as
 * long as the file stays open and is dropped when the process exits, however it exits, so there is
 * never a stale lock to judge. `hugi serve`'s single-instance lock and each cached clone's lock use
 * it. Linux has no such flag, so the lock exists only on macOS.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { errnoCode } from './errno';

/** The one platform the lock exists on. */
export const EXCLUSIVE_LOCK_PLATFORM = 'darwin';

/**
 * darwin's `O_EXLOCK` from `<fcntl.h>`: open the file with an exclusive `flock`. Node's
 * `fs.constants` does not export it.
 */
const O_EXLOCK = 0x20;

/**
 * Open, creating, with the exclusive lock, and without blocking: when any open file description,
 * in this process or another, holds the lock, the open fails with `EAGAIN` at once.
 */
const LOCK_FLAGS = constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK;

/**
 * Open `path` holding its lock, or `undefined` when another open holds it. The handle is the lock:
 * closing it lets go. Call it only on darwin.
 */
export async function openExclusiveLock(path: string): Promise<FileHandle | undefined> {
  try {
    return await open(path, LOCK_FLAGS, 0o600);
  } catch (error) {
    if (errnoCode(error) === 'EAGAIN') {
      return undefined;
    }
    throw error;
  }
}
