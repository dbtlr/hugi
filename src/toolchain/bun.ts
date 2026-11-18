import { posix } from 'node:path';

import type { ReadRepoFile } from './types';

/** Read the single Bun entry from an asdf-style version file. */
export async function bunVersion(
  inputs: Readonly<Record<string, string>>,
  readRepoFile: ReadRepoFile,
) {
  const version = inputs['bun-version'];
  const path = inputs['bun-version-file'];
  if (version !== undefined && path !== undefined) {
    throw new Error('use only one of bun-version and bun-version-file');
  }
  if (path === undefined) {
    return version ?? 'latest';
  }
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..')
  ) {
    throw new Error('bun-version-file must be a repository-relative path without parent traversal');
  }
  // The repository reader takes git's spelling of a path, without `./` segments.
  const text = await readRepoFile(posix.normalize(path));
  if (text === undefined) {
    throw new Error(`bun-version-file "${path}" was not found`);
  }
  const entries = text
    .split(/\r?\n/u)
    .map((line) => line.split('#')[0]?.trim().split(/\s+/u) ?? [])
    .filter(([tool]) => tool === 'bun');
  const entry = entries[0];
  if (entries.length !== 1 || entry?.length !== 2 || entry[1] === undefined) {
    throw new Error(
      `bun-version-file "${path}" must contain exactly one bun version in .tool-versions format`,
    );
  }
  return entry[1];
}
