/**
 * Replace a file whole: write a temporary file in the same directory, then rename it over the
 * target, so a reader sees the old contents or the whole new ones and never half of them. Writers
 * running at the same time use different temporary names. The run record and the service state
 * are written this way.
 */
import { randomBytes } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** The file operations an atomic write uses; the seam a test replaces to watch their order. */
export type AtomicWriteFiles = {
  readonly writeFile: (path: string, text: string, options: { mode: number }) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string, options: { force: true }) => Promise<void>;
};

const REAL_FILES: AtomicWriteFiles = { rename, rm, writeFile };

/**
 * A temporary name beside `path`: hidden, unique to this process by its pid and among its writers
 * by 8 random bytes, and ending in `.tmp`.
 */
export function temporaryPathFor(path: string): string {
  // oxlint-disable-next-line @loomcli/host-bypass -- the name needs this process's pid; Host has none
  const { pid } = process;
  return join(dirname(path), `.${basename(path)}.${pid}.${randomBytes(8).toString('hex')}.tmp`);
}

/** Write `text` to `path` atomically, readable by the user only; a failed write leaves no temporary file. */
export async function writeFileAtomically(
  path: string,
  text: string,
  files: AtomicWriteFiles = REAL_FILES,
): Promise<void> {
  const temporary = temporaryPathFor(path);
  try {
    await files.writeFile(temporary, text, { mode: 0o600 });
    await files.rename(temporary, path);
  } catch (error) {
    await files.rm(temporary, { force: true });
    throw error;
  }
}
