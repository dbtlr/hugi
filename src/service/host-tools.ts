import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { FatalError } from '@loomcli/core';
import type { Host } from '@loomcli/core';

import type { HugiConfig } from '../config/schema';

/** Exit 1: the service could not find its required host programs. */
export class HostToolsError extends FatalError {
  override readonly name = 'HostToolsError';
  static override readonly exitCode = 1;
}

/** Copy the host environment, using the configured directories when supplied. */
export function hostEnv(
  config: Pick<HugiConfig, 'path'>,
  env: Host['env'],
): Record<string, string | undefined> {
  return config.path === undefined ? { ...env } : { ...env, PATH: config.path.join(':') };
}

type IsExecutable = (path: string) => boolean | Promise<boolean>;

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const file = await stat(path);
    return file.isFile() && (file.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Find the first executable in PATH, returning its absolute path. */
export async function findExecutable(
  name: string,
  pathValue: string | undefined,
  isExecutable: IsExecutable = isExecutableFile,
): Promise<string | undefined> {
  if (pathValue === undefined) {
    return undefined;
  }
  for (const directory of pathValue.split(':')) {
    // Keep path components as written so the filesystem resolves symlinks before any '..'.
    const dir = isAbsolute(directory)
      ? directory
      : resolve('.') + (directory ? `/${directory}` : '');
    const candidate = `${dir}${dir.endsWith('/') ? '' : '/'}${name}`;
    // oxlint-disable-next-line no-await-in-loop -- stop at the first executable in search order
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Resolve the required host tools or report all missing names in one startup error. */
export async function requireHostTools(
  env: Host['env'],
  names: readonly string[],
  isExecutable: IsExecutable = isExecutableFile,
): Promise<Readonly<Record<string, string>>> {
  const matches = await Promise.all(
    names.map((name) => findExecutable(name, env.PATH, isExecutable)),
  );
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
      `Could not find required host tools ${missing.join(', ')} on PATH ${searched}. Set \`path\` in Hugi's configuration to the directories that hold them.`,
    );
  }
  return Object.fromEntries(tools);
}

/**
 * The host's spawn as the service uses it: a tool `requireHostTools` resolved runs by its absolute
 * path, and a call that names no environment gets the service's, whose `PATH` is `path` when the
 * configuration sets it. A launchd agent inherits a bare `PATH`, so neither may rely on it.
 */
export function spawnWithTools(
  spawn: Host['spawn'],
  tools: Readonly<Record<string, string>>,
  env: Host['env'],
): Host['spawn'] {
  return (command, args, options) =>
    spawn(tools[command] ?? command, args, { ...options, env: options?.env ?? env });
}
