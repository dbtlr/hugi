/**
 * The pure parts of how a lane's steps find their tools (ADR-0006): parsing what `mise` prints in
 * the guest, comparing the workflow's tool pins with the repository's mise config, and merging
 * the tool environments. The guest scripts that produce the text live in `tool-steps.ts`.
 */
import { isMapping } from '../yaml/strict';
import type { Environment } from './guest-env';

/** What `mise` printed in the guest cannot be read as what it should have printed. */
export class ToolOutputError extends Error {
  override readonly name = 'ToolOutputError';
}

/** mise's short names for tools it also knows under another name. */
const ALIASES: Readonly<Record<string, string>> = { golang: 'go', nodejs: 'node' };

/** mise's own name for a tool: `nodejs` and `core:node` are `node`. */
export function canonicalToolName(name: string): string {
  const bare = name.startsWith('core:') ? name.slice('core:'.length) : name;
  return Object.hasOwn(ALIASES, bare) ? ALIASES[bare]! : bare;
}

export type ToolPin = { readonly name: string; readonly version: string };

/** The specs that pin a version: `tool@version`. */
export const pinnedSpecs = (specs: readonly string[]): string[] =>
  specs.filter((spec) => spec.lastIndexOf('@') > 0);

/** The workflow tools' pins from `tool@version` specs; a spec with no version pins nothing. */
export function workflowPins(specs: readonly string[]): ToolPin[] {
  const pins: ToolPin[] = [];
  for (const spec of specs) {
    const at = spec.lastIndexOf('@');
    if (at > 0) {
      pins.push({ name: canonicalToolName(spec.slice(0, at)), version: spec.slice(at + 1) });
    }
  }
  return pins;
}

/** A tool environment is `mise env --json`'s object of text values, with a non-empty `PATH`. */
export function parseToolEnvironment(text: string): Environment {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolOutputError('the tool environment is not JSON');
  }
  if (!isMapping(parsed)) {
    throw new ToolOutputError('the tool environment is not an object');
  }
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new ToolOutputError(`the tool environment has a non-text value for ${key}`);
    }
    environment[key] = value;
  }
  if (environment.PATH === undefined || environment.PATH === '') {
    throw new ToolOutputError('the tool environment has no PATH');
  }
  return environment;
}

/** The config files mise loaded, each with the path it resolves to, and the workspace's own resolved path. */
export type ConfigListing = {
  readonly workspace: string;
  readonly files: readonly { readonly real: string; readonly path: string }[];
};

/**
 * Parse the guest's listing: one JSON document per line, `{kind: "workspace", real}` first and
 * then `{kind: "file", real, path}` for each config file `mise config ls` reports. JSON keeps a
 * name with a tab, a newline or a quote in one piece.
 */
export function parseConfigListing(text: string): ConfigListing {
  let workspace: string | undefined;
  const files: { real: string; path: string }[] = [];
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new ToolOutputError('the config listing has a line that is not JSON');
    }
    const { kind, path, real } = isMapping(record) ? record : {};
    if (kind === 'workspace' && typeof real === 'string') {
      workspace = real;
    } else if (kind === 'file' && typeof real === 'string' && typeof path === 'string') {
      files.push({ path, real });
    } else {
      throw new ToolOutputError('the config listing has a line of an unknown shape');
    }
  }
  if (workspace === undefined) {
    throw new ToolOutputError('the config listing names no workspace');
  }
  return { files, workspace };
}

const insideWorkspace = (listing: ConfigListing, real: string) =>
  real === listing.workspace || real.startsWith(`${listing.workspace}/`);

/** The paths of the loaded config files that lie inside the workspace once symbolic links are resolved. */
export function configFilesInWorkspace(listing: ConfigListing): string[] {
  return listing.files
    .filter((file) => insideWorkspace(listing, file.real))
    .map((file) => file.path);
}

/** The loaded config files that lie outside the workspace once symbolic links are resolved. */
export function configFilesOutsideWorkspace(listing: ConfigListing): ConfigListing['files'] {
  return listing.files.filter((file) => !insideWorkspace(listing, file.real));
}

export type RequestedVersions = ReadonlyMap<
  string,
  { readonly file: string; readonly versions: readonly string[] }
>;

/**
 * What the workspace's own config files request, from `mise ls --current --json`: the requested
 * versions of each tool under mise's name for it. Entries sourced from another file, and from an
 * idiomatic version file, which Hugi resolves as workflow tools, do not count. An entry of the
 * workspace's own files whose requested version is not text fails with a `ToolOutputError`.
 */
export function requestedVersions(
  json: string,
  workspaceFiles: readonly string[],
): RequestedVersions {
  let listed: unknown;
  try {
    listed = JSON.parse(json);
  } catch {
    throw new ToolOutputError('mise ls --current --json printed no JSON');
  }
  if (!isMapping(listed)) {
    throw new ToolOutputError('mise ls --current --json printed no object of tools');
  }
  const found = new Map<string, { file: string; versions: string[] }>();
  for (const [name, entries] of Object.entries(listed)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const source: unknown = isMapping(entry) ? entry.source : undefined;
      const { path, type } = isMapping(source) ? source : {};
      const requested = isMapping(entry) ? entry.requested_version : undefined;
      const idiomatic = typeof type === 'string' && type.includes('idiomatic');
      if (typeof path !== 'string' || idiomatic || !workspaceFiles.includes(path)) {
        continue;
      }
      // A request that cannot be read cannot be compared with the pin, so it fails the lane
      // instead of passing the check unseen.
      if (typeof requested !== 'string') {
        throw new ToolOutputError(
          `mise ls --current --json lists ${name} from ${path} with a requested version that is not text`,
        );
      }
      const tool = canonicalToolName(name);
      const known = found.get(tool) ?? { file: path, versions: [] };
      known.versions.push(requested);
      found.set(tool, known);
    }
  }
  return found;
}

/** One line for each workflow tool whose pin differs from the config's request, or is requested several times. */
export function versionConflicts(pins: readonly ToolPin[], requested: RequestedVersions): string[] {
  const conflicts: string[] = [];
  for (const pin of pins) {
    const request = requested.get(pin.name);
    if (request === undefined) {
      continue;
    }
    const { file, versions } = request;
    if (versions.length > 1) {
      conflicts.push(
        `${pin.name}: the workflow pins ${pin.version}, but ${file} requests several versions (${versions.join(', ')}); make the two agree`,
      );
    } else if (versions[0] !== pin.version) {
      conflicts.push(
        `${pin.name}: the workflow pins ${pin.version}, but ${file} requests ${versions[0]}; make the two agree`,
      );
    }
  }
  return conflicts;
}

function splitPath(path: string | undefined): string[] {
  return (path ?? '').split(':');
}

function mergePath(parts: readonly (readonly string[])[]): string {
  const seen = new Set<string>();
  for (const directory of parts.flat()) {
    if (directory !== '') {
      seen.add(directory);
    }
  }
  return [...seen].join(':');
}

/**
 * The tool environment of a `tools: mise` lane's later steps (ADR-0008). `PATH` is the workflow
 * tools' bin directories, then the config environment's `PATH` in its own order, then the rest of
 * the first one, without duplicates. Every other variable is the config environment's, then the
 * first one's, except a variable that `workflowOnly`, the environment of the workflow tools alone,
 * sets: that one keeps the first environment's value, so nothing in the config moves a workflow
 * tool's variables, and an image default's yields to a tool the config pins.
 */
export function mergeToolEnvironments(input: {
  readonly first: Environment;
  readonly config: Environment;
  readonly workflowOnly: Environment;
  readonly workflowBins: readonly string[];
}): Environment {
  const { config, first, workflowOnly } = input;
  // PATH is set last, so it needs no exclusion here. A variable the first does not set has no
  // value to keep, and the config's stands.
  const workflowVariables = Object.keys(workflowOnly).filter((name) => Object.hasOwn(first, name));
  return {
    ...first,
    ...config,
    ...Object.fromEntries(workflowVariables.map((name) => [name, first[name]!])),
    PATH: mergePath([input.workflowBins, splitPath(config.PATH), splitPath(first.PATH)]),
  };
}
