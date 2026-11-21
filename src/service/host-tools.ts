import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { FatalError } from '@loomcli/core';
import type { Host } from '@loomcli/core';

/** Exit 1: the service could not find its required host programs. */
export class HostToolsError extends FatalError {
  override readonly name = 'HostToolsError';
  static override readonly exitCode = 1;
}

type IsExecutable = (path: string) => boolean;

// Synchronous because Loom calls the unit's `environment` synchronously (`serviceEnvironment`).
function isExecutableFile(path: string): boolean {
  try {
    // oxlint-disable-next-line node/no-sync -- see above
    if (!statSync(path).isFile()) {
      return false;
    }
    // Any execute bit is not enough: it may belong to another user.
    // oxlint-disable-next-line node/no-sync -- see above
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find the first executable in PATH, returning its absolute path. */
export function findExecutable(
  name: string,
  pathValue: string | undefined,
  isExecutable: IsExecutable = isExecutableFile,
): string | undefined {
  if (pathValue === undefined) {
    return undefined;
  }
  for (const directory of pathValue.split(':')) {
    // Keep path components as written so the filesystem resolves symlinks before any '..'.
    const dir = isAbsolute(directory)
      ? directory
      : resolve('.') + (directory ? `/${directory}` : '');
    const candidate = `${dir}${dir.endsWith('/') ? '' : '/'}${name}`;
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Resolve the required host tools or report all missing names in one startup error. */
export function requireHostTools(
  env: Host['env'],
  names: readonly string[],
  isExecutable: IsExecutable = isExecutableFile,
  fix = 'Put the directories that hold them on PATH.',
): Readonly<Record<string, string>> {
  const matches = names.map((name) => findExecutable(name, env.PATH, isExecutable));
  const tools: [string, string][] = [];
  const missing: string[] = [];
  for (const [index, name] of names.entries()) {
    const path = matches[index];
    if (path === undefined) {
      missing.push(name);
    } else {
      tools.push([name, path]);
    }
  }
  if (missing.length > 0) {
    const searched = env.PATH === undefined ? '(unset)' : JSON.stringify(env.PATH);
    throw new HostToolsError(
      `Could not find required host tools ${missing.join(', ')} on PATH ${searched}. ${fix}`,
    );
  }
  return Object.fromEntries(tools);
}

/** The programs `hugi serve` runs on the host. */
export const SERVICE_HOST_TOOLS = ['tart', 'git'] as const;

/**
 * The variables `hugi service install` writes into the launchd unit: the installing shell's
 * `PATH`, so the agent finds tart and git where that shell does instead of on launchd's bare
 * `PATH`. Only its absolute directories are kept, because the agent would resolve a relative or
 * empty entry against the home, not the directory install ran in. Throws, so install writes
 * nothing, when the kept directories do not find them both.
 */
export function serviceEnvironment(
  env: Host['env'],
  isExecutable: IsExecutable = isExecutableFile,
): Readonly<Record<string, string>> {
  const PATH = (env.PATH ?? '')
    .split(':')
    .filter((directory) => isAbsolute(directory))
    .join(':');
  requireHostTools(
    // An empty PATH would search the working directory, so it searches nothing here.
    PATH === '' ? {} : { PATH },
    SERVICE_HOST_TOOLS,
    isExecutable,
    'Run hugi service install from a shell whose PATH finds them in absolute directories.',
  );
  return { PATH };
}

/**
 * The host's spawn as the service uses it: a tool `requireHostTools` resolved runs by its absolute
 * path, and a call that names no environment gets the service's.
 */
export function spawnWithTools(
  spawn: Host['spawn'],
  tools: Readonly<Record<string, string>>,
  env: Host['env'],
): Host['spawn'] {
  return (command, args, options) =>
    spawn(tools[command] ?? command, args, { ...options, env: options?.env ?? env });
}
