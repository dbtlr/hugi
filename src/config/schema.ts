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
  /** How long and how much of the runs directory Hugi keeps (`applyRetention`). */
  readonly runs: { readonly maxAgeDays: number; readonly maxSizeGb: number };
  /** The GitHub App that posts statuses; absent when none is configured (`hugi run` needs none). */
  readonly githubApp?: GitHubAppConfig;
  /** The run page `hugi serve` serves; absent when there is none, and then no Details link either. */
  readonly web?: WebConfig;
};

/** Where the run page listens, and the origin that reaches it from outside the host. */
export type WebConfig = {
  /** The loopback port the run page listens on. */
  readonly port: number;
  /** An `http` or `https` origin with no trailing `/`, such as `https://hugi.example.ts.net`. */
  readonly url: string;
};

/** Which GitHub App Hugi authenticates as, and where its private key lives on the host. */
export type GitHubAppConfig = {
  readonly appId: number;
  /** Absolute, or starting with `~/`, which the host's home directory replaces. */
  readonly privateKeyPath: string;
};

/** The VM size defaults are the runner's own (`VM_RESOURCES`, ADR-0003), so they are written once. */
export const DEFAULTS = {
  cpus: VM_RESOURCES.cpus,
  maxAgeDays: 30,
  maxSizeGb: 5,
  memoryGb: VM_RESOURCES.memoryMb / 1024,
  pollIntervalSeconds: 60,
} as const;

const POLL_INTERVAL_RANGE = [15, 3600] as const;
const CPUS_RANGE = [1, 16] as const;
const MEMORY_GB_RANGE = [2, 64] as const;
const MAX_AGE_DAYS_RANGE = [1, 3650] as const;
const MAX_SIZE_GB_RANGE = [1, 100_000] as const;
const WEB_PORT_RANGE = [1024, 65_535] as const;

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

function readRuns(value: unknown): HugiConfig['runs'] {
  if (value === undefined) {
    return { maxAgeDays: DEFAULTS.maxAgeDays, maxSizeGb: DEFAULTS.maxSizeGb };
  }
  const runs = mappingOf(value, 'runs', ['max_age_days', 'max_size_gb']);
  return {
    maxAgeDays: integerOf(
      runs.max_age_days,
      'runs.max_age_days',
      MAX_AGE_DAYS_RANGE,
      DEFAULTS.maxAgeDays,
    ),
    maxSizeGb: integerOf(
      runs.max_size_gb,
      'runs.max_size_gb',
      MAX_SIZE_GB_RANGE,
      DEFAULTS.maxSizeGb,
    ),
  };
}

/** A key path the host can resolve without a working directory: absolute, or home-relative. */
function isHostPath(text: string): boolean {
  return text.startsWith('/') || text.startsWith('~/');
}

function readGitHubApp(value: unknown): GitHubAppConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const app = mappingOf(value, 'github_app', ['app_id', 'private_key_path']);
  if (app.app_id === undefined) {
    refuse('github_app.app_id', "is required: the number on the GitHub App's settings page");
  }
  const appId = integerOf(app.app_id, 'github_app.app_id', [1, Number.MAX_SAFE_INTEGER], 0);
  const path = app.private_key_path;
  if (path === undefined) {
    refuse('github_app.private_key_path', 'is required: the file holding the App private key');
  }
  if (typeof path !== 'string' || !isHostPath(path) || path.endsWith('/')) {
    refuse(
      'github_app.private_key_path',
      `must be a file path that is absolute or starts with ~/, not ${describe(path)}`,
    );
  }
  return { appId, privateKeyPath: path };
}

/** A URL as written: its scheme, its authority, and whatever follows the authority. */
const URL_PARTS = /^https?:\/\/(?<authority>[^/?#]*)(?<rest>.*)$/isu;

/** What `rest`, the text after a URL's authority, holds that an origin may not, if anything. */
function extraOf(rest: string): string | undefined {
  const path = rest.replace(/[?#].*$/su, '');
  if (path !== '' && path !== '/') {
    return 'path';
  }
  const query = rest.indexOf('?');
  const fragment = rest.indexOf('#');
  if (query !== -1 && (fragment === -1 || query < fragment)) {
    return 'query';
  }
  return fragment === -1 ? undefined : 'fragment';
}

/** `web.url` as an origin: http or https, a host and an optional port, a lone trailing `/` dropped. */
function webUrlOf(value: unknown): string {
  const path = 'web.url';
  if (value === undefined) {
    refuse(path, 'is required: the http or https origin that reaches the run page');
  }
  const expected = `must be an http or https origin, such as https://hugi.example.ts.net, not ${describe(value)}`;
  const parts = typeof value === 'string' ? URL_PARTS.exec(value)?.groups : undefined;
  if (typeof value !== 'string' || parts === undefined) {
    refuse(path, expected);
  }
  const { authority = '', rest = '' } = parts;
  if (authority.includes('@')) {
    refuse(path, `must have no credentials, not ${describe(value)}`);
  }
  const extra = extraOf(rest);
  if (extra !== undefined) {
    refuse(path, `must have no ${extra}: give the origin alone, not ${describe(value)}`);
  }
  if (!URL.canParse(value)) {
    refuse(path, expected);
  }
  return new URL(value).origin;
}

function readWeb(value: unknown): WebConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const web = mappingOf(value, 'web', ['port', 'url']);
  if (web.port === undefined) {
    refuse('web.port', 'is required: the loopback port the run page listens on');
  }
  const port = integerOf(web.port, 'web.port', WEB_PORT_RANGE, 0);
  return { port, url: webUrlOf(web.url) };
}

/** Validate the parsed configuration text; throws a `ConfigError` for the first problem found. */
export function validateConfig(parsed: unknown): HugiConfig {
  const top = mappingOf(parsed, 'configuration', [
    'repositories',
    'allowlist',
    'poll_interval',
    'vm',
    'runs',
    'github_app',
    'web',
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
  const githubApp = readGitHubApp(top.github_app);
  const web = readWeb(top.web);
  return Object.freeze({
    ...(githubApp === undefined ? {} : { githubApp: Object.freeze(githubApp) }),
    ...(web === undefined ? {} : { web: Object.freeze(web) }),
    allowlist: Object.freeze(allowlist),
    pollIntervalSeconds: integerOf(
      top.poll_interval,
      'poll_interval',
      POLL_INTERVAL_RANGE,
      DEFAULTS.pollIntervalSeconds,
    ),
    repositories: Object.freeze(repositories),
    runs: Object.freeze(readRuns(top.runs)),
    vm: Object.freeze(readVm(top.vm)),
  });
}
