/** Finding runs in the runs directory: the entries that look like run directories, and lookup by id. */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errnoCode } from '../errno';
import { messageOf } from '../errors';
import { RECORD_FILE, readRunRecord, RunRecordError } from './record';
import type { RunRecord } from './record';

/**
 * What a run directory is called: `runDirectoryName`'s UTC stamp and short commit, then the random
 * suffix `createRunDirectory` adds. Retention and lookup touch only names that match.
 */
export const RUN_DIRECTORY_NAME = /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{1,40}-[A-Za-z0-9]{6}$/u;

/**
 * What a run directory holds: its record, no record at all (a directory left by a run that never
 * got to write one), or a record that cannot be used, with the reason.
 */
export type RunContents =
  | { readonly kind: 'record'; readonly record: RunRecord }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unusable'; readonly error: RunRecordError };

export type StoredRun = {
  readonly id: string;
  readonly dir: string;
  readonly contents: RunContents;
};

/** A run id that names no run, or a prefix that names several. */
export class RunLookupError extends Error {
  override readonly name = 'RunLookupError';
}

/** Whether `path` is a real directory: a symlink to one is not. */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What the run directory `dir`, named `id`, holds. The record must be a regular file (never a
 * link, so reading it cannot leave the directory) and must name the directory as its run.
 */
export async function inspectRunDirectory(dir: string, id: string): Promise<RunContents> {
  const path = join(dir, RECORD_FILE);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      return { kind: 'missing' };
    }
    return {
      error: new RunRecordError(`No readable run record at ${path}: ${messageOf(error)}`),
      kind: 'unusable',
    };
  }
  if (!info.isFile()) {
    return {
      error: new RunRecordError(`${path} is not a regular file, so Hugi will not read it.`),
      kind: 'unusable',
    };
  }
  try {
    const record = await readRunRecord(dir);
    if (record.runId !== id) {
      return {
        error: new RunRecordError(`${path} belongs to run ${record.runId}, not to ${id}.`),
        kind: 'unusable',
      };
    }
    return { kind: 'record', record };
  } catch (error) {
    if (error instanceof RunRecordError) {
      return { error, kind: 'unusable' };
    }
    throw error;
  }
}

/** The names under `runsDir` that look like run directories and are real directories; none when it is missing. */
export async function runDirectoryNames(runsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }
  const names = entries.filter((name) => RUN_DIRECTORY_NAME.test(name));
  const real = await Promise.all(names.map((name) => isRealDirectory(join(runsDir, name))));
  return names.filter((_, index) => real[index]).toSorted();
}

/**
 * The run named by `idOrPrefix`: an exact id, or a prefix that only one run starts with, with what
 * its directory holds. An unknown or ambiguous id is a `RunLookupError` that names the runs directory.
 */
export async function findRun(runsDir: string, idOrPrefix: string): Promise<StoredRun> {
  const names = await runDirectoryNames(runsDir);
  const exact = names.find((name) => name === idOrPrefix);
  const matches =
    exact === undefined ? names.filter((name) => name.startsWith(idOrPrefix)) : [exact];
  if (idOrPrefix === '' || matches.length === 0) {
    throw new RunLookupError(`No run "${idOrPrefix}" in ${runsDir}.`);
  }
  if (matches.length > 1) {
    throw new RunLookupError(
      `"${idOrPrefix}" matches ${matches.length} runs in ${runsDir}: ${matches.join(', ')}. Give more of the id.`,
    );
  }
  const [id] = matches;
  if (id === undefined) {
    throw new RunLookupError(`No run "${idOrPrefix}" in ${runsDir}.`);
  }
  const dir = join(runsDir, id);
  return { contents: await inspectRunDirectory(dir, id), dir, id };
}
