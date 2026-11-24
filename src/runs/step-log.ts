/**
 * Reading a step's log from its run directory, as `hugi logs` and the run page both do. A log that
 * is missing, a symbolic link, not a regular file, or unreadable is reported, never thrown, and a
 * link is never followed, so a read cannot leave the run directory.
 */
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

import { errnoCode } from '../errno';
import { messageOf } from '../errors';

/** Why a step log was not read. */
export type StepLogProblem = 'missing' | 'symbolic-link' | 'not-a-file' | 'unreadable';

export type StepLogRead =
  | {
      readonly kind: 'read';
      /** The file's bytes from `start` to its end. */
      readonly bytes: Buffer;
      /** Where `bytes` begin in the file: 0 unless only its tail was read. */
      readonly start: number;
    }
  | {
      readonly kind: 'refused';
      readonly problem: StepLogProblem;
      /** What `hugi logs` prints for it. */
      readonly message: string;
    };

const SYMBOLIC_LINK = 'the log is a symbolic link, so Hugi will not read it';
const NOT_A_FILE = 'the log is not a regular file, so Hugi will not read it';

function refused(problem: StepLogProblem, message: string): StepLogRead {
  return { kind: 'refused', message, problem };
}

function refusedFor(error: unknown): StepLogRead {
  const code = errnoCode(error);
  if (code === 'ELOOP') {
    return refused('symbolic-link', SYMBOLIC_LINK);
  }
  return refused(code === 'ENOENT' ? 'missing' : 'unreadable', messageOf(error));
}

type ReadAt = {
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>;
};

/**
 * Fill `buffer` from `position`, reading again after a short read, as a single read may return
 * fewer bytes than asked. Returns what was read, shorter only when the file ended first.
 */
export async function readFully(handle: ReadAt, buffer: Buffer, position: number): Promise<Buffer> {
  let filled = 0;
  while (filled < buffer.length) {
    // oxlint-disable-next-line no-await-in-loop -- each read continues where the last one ended
    const { bytesRead } = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      position + filled,
    );
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * Read the step log at `path`: all of it, or only its last `tailBytes`. The file is opened without
 * following a link and without waiting on a pipe, then checked again as opened, so one swapped in
 * after the first check is refused too.
 */
export async function readStepLog(
  path: string,
  tailBytes: number = Number.POSITIVE_INFINITY,
): Promise<StepLogRead> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return refused('symbolic-link', SYMBOLIC_LINK);
    }
    if (!info.isFile()) {
      return refused('not-a-file', NOT_A_FILE);
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        return refused('not-a-file', NOT_A_FILE);
      }
      const start = Math.max(0, opened.size - tailBytes);
      const buffer = Buffer.alloc(opened.size - start);
      return { bytes: await readFully(handle, buffer, start), kind: 'read', start };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return refusedFor(error);
  }
}
