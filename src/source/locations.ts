/** Where Hugi keeps its host-side cache and run logs, following the XDG base directories. */
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** A set, non-empty value, so an empty variable counts as unset. */
function present(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** The cache holding bare partial clones: the flag, else `HUGI_CACHE_DIR`, else the XDG cache. */
export function resolveCacheDir(flag: string | undefined, env: Env, home: string): string {
  return (
    present(flag) ??
    present(env.HUGI_CACHE_DIR) ??
    join(present(env.XDG_CACHE_HOME) ?? join(home, '.cache'), 'hugi')
  );
}

/** The parent of every run's log directory. */
export function resolveRunsDir(env: Env, home: string): string {
  return join(present(env.XDG_STATE_HOME) ?? join(home, '.local', 'state'), 'hugi', 'runs');
}

/** A fresh log directory name: the UTC time to the second, then the short commit. */
export function runDirectoryName(now: Date, sha: string): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '');
  return `${stamp}-${sha.slice(0, 9)}`;
}

/**
 * Create a run's log directory under `runsDir`: its name, then a random suffix, made atomically
 * so two runs of one commit in the same second never share a directory.
 */
export async function createRunDirectory(runsDir: string, now: Date, sha: string): Promise<string> {
  await mkdir(runsDir, { mode: 0o700, recursive: true });
  return mkdtemp(join(runsDir, `${runDirectoryName(now, sha)}-`));
}
