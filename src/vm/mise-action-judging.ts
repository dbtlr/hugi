/**
 * The pure parts of a `jdx/mise-action` step (ADR-0007): reading what its guest scripts wrote, and
 * the host's judgements on it — which lock file makes the install `--locked`, which executables
 * overlap a workflow tool's, and what the step exports. The guest scripts live in
 * `mise-action-step.ts`; the config check reuses `tool-environment.ts`.
 */
import { posix } from 'node:path';

import { isMapping } from '../yaml/strict';
import type { Environment } from './guest-env';
import { GUEST_RUNNER_PATHS } from './guest-paths';
import { ToolOutputError } from './tool-environment';

/** Parse one JSON document per line, failing with a `ToolOutputError` that names `what`. */
function jsonLines(text: string, what: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new ToolOutputError(`${what} has a line that is not JSON`);
      }
      if (!isMapping(record)) {
        throw new ToolOutputError(`${what} has a line of an unknown shape`);
      }
      return record;
    });
}

const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

// The action's lock file names (v5.3.0, `index.ts`), by the place it searches for them.
const ROOT_LOCK = /^\.?mise(?:\.[^.]+)?\.lock$/u;
const CONFIG_DIR_LOCK = /^mise(?:\.[^.]+)?\.lock$/u;
const CONFIG_LOCK = /^config(?:\.[^.]+)?\.lock$/u;

/** A directory the lock file search lists, and the names that count as a lock file there. */
export type LockFilePlace = {
  readonly path: string;
  readonly patterns: readonly RegExp[];
};

/**
 * Where the action looks for a mise lock file: in the working directory and each of its ancestors,
 * up to the workspace root, since directories above the workspace are empty on GitHub's runner.
 * Two searches can share a directory, as the workspace's `mise` and a working directory named
 * `mise`, so each directory is one place, with the names of every search that looks there.
 */
export function lockFilePlaces(workingDirectory: string | undefined): LockFilePlace[] {
  const { workspace } = GUEST_RUNNER_PATHS;
  const dirs: string[] = [];
  for (let dir = workingDirectory ?? '.'; dir !== '.'; dir = posix.dirname(dir)) {
    dirs.push(`${workspace}/${dir}`);
  }
  dirs.push(workspace);
  const places = new Map<string, RegExp[]>();
  for (const dir of dirs) {
    for (const [path, patterns] of [
      [dir, [ROOT_LOCK]],
      [`${dir}/.config`, [CONFIG_DIR_LOCK]],
      [`${dir}/.config/mise`, [ROOT_LOCK, CONFIG_LOCK]],
      [`${dir}/.mise`, [ROOT_LOCK, CONFIG_LOCK]],
      [`${dir}/mise`, [ROOT_LOCK, CONFIG_LOCK]],
    ] as const) {
      places.set(path, [...new Set([...(places.get(path) ?? []), ...patterns])]);
    }
  }
  return [...places].map(([path, patterns]) => ({ path, patterns }));
}

/**
 * Whether the guest's listing of the places' regular files (`{path, files}` lines) holds a lock
 * file. A listing without exactly one readable line for every place cannot say there is no lock
 * file, so it is a `ToolOutputError`.
 */
export function hasLockFile(places: readonly LockFilePlace[], listing: string): boolean {
  const listed = new Map<string, readonly string[]>();
  for (const record of jsonLines(listing, 'the lock file listing')) {
    if ('monorepo' in record) {
      continue;
    }
    const { files, path } = record;
    if (typeof path !== 'string' || !isTextList(files)) {
      throw new ToolOutputError('the lock file listing has a line of an unknown shape');
    }
    if (listed.has(path)) {
      throw new ToolOutputError(`the lock file listing lists ${path} twice`);
    }
    listed.set(path, files);
  }
  const unlisted = places.find(({ path }) => !listed.has(path));
  if (unlisted !== undefined) {
    throw new ToolOutputError(`the lock file listing has no line for ${unlisted.path}`);
  }
  return places.some(({ path, patterns }) =>
    (listed.get(path) ?? []).some((name) => patterns.some((pattern) => pattern.test(name))),
  );
}

/** Whether the install check found that the config sets `monorepo.config_roots` (a `{monorepo}` line). */
export function setsMonorepoRoots(listing: string): boolean {
  return jsonLines(listing, 'the install check').some(({ monorepo }) => monorepo === true);
}

type ListedDirectory = {
  readonly role: 'config' | 'workflow';
  readonly dir: string;
  readonly real: string;
  readonly executables: readonly string[];
};

function listedDirectories(text: string): ListedDirectory[] {
  return jsonLines(text, 'the overlap listing').map(({ dir, executables, real, role }) => {
    if (
      (role !== 'config' && role !== 'workflow') ||
      typeof dir !== 'string' ||
      typeof real !== 'string' ||
      !isTextList(executables)
    ) {
      throw new ToolOutputError('the overlap listing has a line of an unknown shape');
    }
    return { dir, executables, real, role };
  });
}

/**
 * One line for each executable that a directory the mise config puts on `PATH` and a different
 * workflow tool directory both hold; directories compare after resolving symbolic links.
 */
export function overlapConflicts(text: string): string[] {
  const listed = listedDirectories(text);
  const workflow = listed.filter((entry) => entry.role === 'workflow');
  const conflicts = new Set<string>();
  for (const config of listed.filter((entry) => entry.role === 'config')) {
    for (const tool of workflow.filter((entry) => entry.real !== config.real)) {
      for (const name of config.executables.filter((exe) => tool.executables.includes(exe))) {
        conflicts.add(
          `${name}: the mise config puts ${config.dir} on PATH and the workflow tools put ${tool.dir}, and both hold it; their order on PATH can differ from GitHub's runner, so make the config and the workflow name one install`,
        );
      }
    }
  }
  return [...conflicts];
}

/**
 * What `mise env --json` exports through `GITHUB_ENV`: every text value but `PATH`, in any case,
 * whatever its name. Whether the runner can read each name back is the step's check
 * (`parseExportedVariables`), as on GitHub.
 */
export function exportedVariables(json: string): Environment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ToolOutputError('mise env --json printed no JSON');
  }
  if (!isMapping(parsed)) {
    throw new ToolOutputError('mise env --json printed no object');
  }
  const exported: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (name.toUpperCase() === 'PATH' || typeof value !== 'string') {
      continue;
    }
    exported[name] = value;
  }
  return exported;
}

/** The entries of `mise env --paths`, mise's first entry first. */
export function managedPaths(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => line !== '');
}

/** What the probe found out about the guest's mise before the step changes anything. */
export type Probe = {
  /** mise's data directory by the action's rule, which holds the shims directory. */
  readonly dataDir: string;
  /** Whether the step's `PATH` reaches the guest's mise. */
  readonly onPath: boolean;
  /** Whether the guest's mise has the commands the step needs and does not fall back from. */
  readonly supports: {
    readonly envJson: boolean;
    readonly envPaths: boolean;
    readonly installLocked: boolean;
  };
};

export function parseProbe(text: string): Probe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolOutputError('the mise probe is not JSON');
  }
  const { dataDir, onPath, supports } = isMapping(parsed) ? parsed : {};
  const { envJson, envPaths, installLocked } = isMapping(supports) ? supports : {};
  if (
    typeof dataDir !== 'string' ||
    typeof onPath !== 'boolean' ||
    typeof envJson !== 'boolean' ||
    typeof envPaths !== 'boolean' ||
    typeof installLocked !== 'boolean'
  ) {
    throw new ToolOutputError('the mise probe has an unknown shape');
  }
  return { dataDir, onPath, supports: { envJson, envPaths, installLocked } };
}

/** The version `mise --version` printed: the first word of its first line, without a leading `v`. */
export function miseVersion(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? '';
  const version = (firstLine.trim().split(/\s+/u)[0] ?? '').replace(/^v/u, '');
  if (version === '') {
    throw new ToolOutputError('mise --version printed no version');
  }
  return version;
}

/** The workflow tools' bin directories in the tool environment's `PATH` order, the rest after them. */
export function orderedWorkflowBins(
  bins: readonly string[],
  toolPath: string | undefined,
): string[] {
  const order = (toolPath ?? '').split(':');
  const rank = (dir: string) => {
    const at = order.indexOf(dir);
    return at === -1 ? order.length : at;
  };
  return bins
    .map((dir, at) => ({ at, dir }))
    .toSorted((a, b) => rank(a.dir) - rank(b.dir) || a.at - b.at)
    .map(({ dir }) => dir);
}
