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

/** Hugi's configuration file: the flag, else `HUGI_CONFIG`, else `hugi/config.yaml` in the XDG config home. */
export function resolveConfigPath(flag: string | undefined, env: Env, home: string): string {
  return (
    present(flag) ??
    present(env.HUGI_CONFIG) ??
    join(present(env.XDG_CONFIG_HOME) ?? join(home, '.config'), 'hugi', 'config.yaml')
  );
}

/** The parent of every run's log directory. */
export function resolveRunsDir(env: Env, home: string): string {
  return join(present(env.XDG_STATE_HOME) ?? join(home, '.local', 'state'), 'hugi', 'runs');
}

/** The directory holding the service's state file: `hugi` in the XDG state home. */
export function resolveServiceStateDir(env: Env, home: string): string {
  return join(present(env.XDG_STATE_HOME) ?? join(home, '.local', 'state'), 'hugi');
}

/**
 * The single-instance lock of `hugi serve`: always `~/.local/state/hugi/serve.lock`. It does not
 * follow `XDG_STATE_HOME`, because the startup sweep covers tart's whole VM store: a service
 * started where that variable differs must still find the lock of the one already running.
 */
export function resolveServeLockPath(home: string): string {
  return join(home, '.local', 'state', 'hugi', 'serve.lock');
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
