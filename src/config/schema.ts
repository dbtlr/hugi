/**
 * Validate the parsed text of Hugi's configuration file into a frozen `HugiConfig` with defaults
 * applied. The configuration says who may run (enrolled repositories, allowlisted authors) and
 * how the host behaves; it never says what runs, so a `lanes` key is refused like any unknown key.
 * Every refusal is a `ConfigError` naming the key path at fault.
 */
import { FatalError } from '@loomcli/core';

import { VM_RESOURCES } from '../vm/lifecycle';
import { isMapping } from '../yaml/strict';

/** Exit 1: the configuration file is missing or refused. */
export class ConfigError extends FatalError {
  override readonly name = 'ConfigError';
  static override readonly exitCode = 1;
}

export type HugiConfig = {
  /** Enrolled repositories as written, `owner/name`, in file order. */
  readonly repositories: readonly string[];
  /** GitHub logins whose pull requests run on every enrolled repository, in file order. */
  readonly allowlist: readonly string[];
  readonly pollIntervalSeconds: number;
  readonly vm: { readonly cpus: number; readonly memoryGb: number };
};

/** The VM size defaults are the runner's own (`VM_RESOURCES`, ADR-0003), so they are written once. */
export const DEFAULTS = {
  cpus: VM_RESOURCES.cpus,
  memoryGb: VM_RESOURCES.memoryMb / 1024,
  pollIntervalSeconds: 60,
} as const;

const POLL_INTERVAL_RANGE = [15, 3600] as const;
const CPUS_RANGE = [1, 16] as const;
const MEMORY_GB_RANGE = [2, 64] as const;

const LOGIN = /^[A-Za-z0-9]+([-_][A-Za-z0-9]+)*$/u;
const LOGIN_MAX = 39;
const REPOSITORY_NAME = /^[A-Za-z0-9._-]+$/u;
const REPOSITORY_NAME_MAX = 100;

type Mapping = Readonly<Record<string, unknown>>;

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  return typeof value === 'object' ? 'a mapping' : `${typeof value} ${JSON.stringify(value)}`;
}

function refuse(path: string, problem: string): never {
  throw new ConfigError(`${path}: ${problem}.`);
}

/** The mapping at `path`, whose keys are all in `allowed`. */
function mappingOf(value: unknown, path: string, allowed: readonly string[]): Mapping {
  if (!isMapping(value)) {
    refuse(path, `must be a mapping, not ${describe(value)}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const where = path === 'configuration' ? key : `${path}.${key}`;
      refuse(where, `is not a known key (known keys: ${allowed.join(', ')})`);
    }
  }
  return value;
}

/**
 * A GitHub login: alphanumerics joined by single hyphens or underscores, none leading or
 * trailing, at most 39. The underscore admits Enterprise Managed User logins (`handle_shortcode`).
 */
export function isLogin(text: string): boolean {
  return text.length <= LOGIN_MAX && LOGIN.test(text);
}

/** `owner/name` in GitHub's syntax: a login-shaped owner, and a name that is not `.` or `..`. */
export function isRepositoryName(text: string): boolean {
  const [owner, name, ...rest] = text.split('/');
  return (
    rest.length === 0 &&
    owner !== undefined &&
    name !== undefined &&
    isLogin(owner) &&
    name.length <= REPOSITORY_NAME_MAX &&
    REPOSITORY_NAME.test(name) &&
    name !== '.' &&
    name !== '..'
  );
}

/** The list at `path` of strings that pass `valid`, distinct when compared case-insensitively. */
function distinctStrings(
  value: unknown,
  path: string,
  expectation: string,
  valid: (text: string) => boolean,
): readonly string[] {
  if (!Array.isArray(value)) {
    refuse(path, `must be a list, not ${describe(value)}`);
  }
  const seen = new Map<string, number>();
  return value.map((item: unknown, index) => {
    const at = `${path}[${index}]`;
    if (typeof item !== 'string' || !valid(item)) {
      refuse(at, `must be ${expectation}, not ${describe(item)}`);
    }
    const first = seen.get(item.toLowerCase());
    if (first !== undefined) {
      refuse(at, `repeats ${path}[${first}] (${item}); names compare case-insensitively`);
    }
    seen.set(item.toLowerCase(), index);
    return item;
  });
}

/** The integer at `path` within `[min, max]`, or `fallback` when absent. */
function integerOf(
  value: unknown,
  path: string,
  [min, max]: readonly [number, number],
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    refuse(path, `must be an integer, not ${describe(value)}`);
  }
  if (value < min || value > max) {
    refuse(path, `must be between ${min} and ${max}, not ${value}`);
  }
  return value;
}

function readVm(value: unknown): HugiConfig['vm'] {
  if (value === undefined) {
    return { cpus: DEFAULTS.cpus, memoryGb: DEFAULTS.memoryGb };
  }
  const vm = mappingOf(value, 'vm', ['cpus', 'memory_gb']);
  return {
    cpus: integerOf(vm.cpus, 'vm.cpus', CPUS_RANGE, DEFAULTS.cpus),
    memoryGb: integerOf(vm.memory_gb, 'vm.memory_gb', MEMORY_GB_RANGE, DEFAULTS.memoryGb),
  };
}

/** Validate the parsed configuration text; throws a `ConfigError` for the first problem found. */
export function validateConfig(parsed: unknown): HugiConfig {
  const top = mappingOf(parsed, 'configuration', [
    'repositories',
    'allowlist',
    'poll_interval',
    'vm',
  ]);
  if (top.repositories === undefined) {
    refuse('repositories', 'is required: list the repositories to enrol as owner/name');
  }
  const repositories = distinctStrings(
    top.repositories,
    'repositories',
    'a GitHub repository as owner/name',
    isRepositoryName,
  );
  if (repositories.length === 0) {
    refuse('repositories', 'must list at least one repository');
  }
  if (top.allowlist === undefined) {
    refuse('allowlist', 'is required: list GitHub logins, or write [] to allow no pull requests');
  }
  const allowlist = distinctStrings(top.allowlist, 'allowlist', 'a GitHub login', isLogin);
  return Object.freeze({
    allowlist: Object.freeze(allowlist),
    pollIntervalSeconds: integerOf(
      top.poll_interval,
      'poll_interval',
      POLL_INTERVAL_RANGE,
      DEFAULTS.pollIntervalSeconds,
    ),
    repositories: Object.freeze(repositories),
    vm: Object.freeze(readVm(top.vm)),
  });
}
