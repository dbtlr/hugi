/**
 * `jdx/mise-action` (ADR-0007): which references run, and what each input of v5.3.0 means under
 * Hugi. Every input is read as the action reads it, through `core.getInput`, which trims it. An
 * input Hugi honours becomes a setting; a no-op input must still be one the action accepts; an
 * input Hugi cannot honour exactly fails resolution. The table in `docs/supported-actions.md` is
 * the contract.
 */
import { posix } from 'node:path';

import type { MiseActionSettings } from './types';

/** The boolean inputs and v5.3.0's defaults for them. */
const BOOLEAN_DEFAULTS = {
  add_shims_to_path: true,
  auto_update: false,
  cache: true,
  cache_save: true,
  cache_save_post: false,
  env: true,
  experimental: false,
  export_path: true,
  fetch_from_github: true,
  install: true,
  monorepo: true,
  reshim: false,
} as const;

type BooleanInput = keyof typeof BOOLEAN_DEFAULTS;

/** Inputs that write config files, move mise's directories, or run code: refused unless empty. */
const EMPTY_ONLY = [
  'bootstrap_args',
  'bootstrap_skip',
  'install_dir',
  'mise_dir',
  'mise_toml',
  'plugins',
  'sha256',
  'tool_versions',
] as const;

/** Inputs refused unless they are `false`. */
const FALSE_ONLY = ['bootstrap', 'persist_github_token', 'wings_enabled'] as const;

/** Every input of v5.3.0; any other fails resolution. */
export const MISE_ACTION_INPUTS: readonly string[] = [
  ...Object.keys(BOOLEAN_DEFAULTS),
  ...EMPTY_ONLY,
  ...FALSE_ONLY,
  'cache_key',
  'cache_key_prefix',
  'cache_max_age_days',
  'cache_restore_retry_budget',
  'cache_save_retry_budget',
  'github_token',
  'install_args',
  'log_level',
  'minimum_release_age',
  'mise_env',
  'version',
  'working_directory',
];

/** `core.getBooleanInput`'s spellings. */
const TRUE_VALUES = new Set(['true', 'True', 'TRUE']);
const FALSE_VALUES = new Set(['false', 'False', 'FALSE']);

type Inputs = Readonly<Record<string, string>>;

/** An input as `core.getInput` returns it: trimmed, and empty when not given. */
const inputOf = (inputs: Inputs, name: string): string => inputs[name]?.trim() ?? '';

/**
 * The moving tag `v5`, a release tag from v5.3.0 on, or a commit SHA. Hugi reproduces v5.3.0 and
 * cannot tell which release the moving tag or a SHA names.
 */
export function checkMiseActionRef(ref: string): void {
  const release = /^v5\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(ref);
  const minor = release === null ? -1 : Number(release[1]);
  if (ref === 'v5' || minor >= 3 || /^[0-9a-f]{40}$/iu.test(ref)) {
    return;
  }
  throw new Error(
    `unsupported ref "${ref}": use v5, a v5 release from v5.3.0 on, or a 40-character commit SHA`,
  );
}

function booleanOf(inputs: Inputs, name: BooleanInput): boolean {
  if (inputs[name] === undefined) {
    return BOOLEAN_DEFAULTS[name];
  }
  return parseBoolean(name, inputOf(inputs, name));
}

function parseBoolean(name: string, value: string): boolean {
  if (TRUE_VALUES.has(value)) {
    return true;
  }
  if (FALSE_VALUES.has(value)) {
    return false;
  }
  throw new Error(`${name} must be true or false, as GitHub reads a boolean input`);
}

/** `cache-retry.ts`'s `parseDuration`: `60s`, `500ms`, `2m`, `1h`, or bare seconds; empty is 0. */
function checkRetryBudget(inputs: Inputs, name: string): void {
  const value = inputOf(inputs, name);
  if (value !== '' && !/^\d+(?:\.\d+)?\s*(?:ms|s|m|h)?$/iu.test(value)) {
    throw new Error(`${name} must be a duration like 60s, 2m or 0s`);
  }
}

/** `cachePeriod`'s rule on `Number(value || '30')`: a non-negative integer. */
function checkCacheMaxAge(inputs: Inputs): void {
  const days = Number(inputOf(inputs, 'cache_max_age_days') || '30');
  if (!Number.isInteger(days) || days < 0) {
    throw new Error('cache_max_age_days must be a non-negative integer');
  }
}

/** A subset of the action's grammar: whole numbers with units, or whole seconds; no ISO dates. */
function checkMinimumReleaseAge(inputs: Inputs): void {
  if (inputs.minimum_release_age === undefined) {
    return;
  }
  const value = inputOf(inputs, 'minimum_release_age');
  if (!/^(?:\d+|(?:\d+(?:y|mo|w|d|h|m|s))+)$/u.test(value)) {
    throw new Error(
      'minimum_release_age must be a relative duration such as 24h or 1d12h (units y, mo, w, d, h, m, s), or whole seconds',
    );
  }
}

function checkRefused(inputs: Inputs): void {
  for (const name of EMPTY_ONLY) {
    if (inputOf(inputs, name) !== '') {
      throw new Error(`${name} is not supported: it must be empty`);
    }
  }
  for (const name of FALSE_ONLY) {
    if (inputs[name] !== undefined && !FALSE_VALUES.has(inputOf(inputs, name))) {
      throw new Error(`${name} is not supported: it must be false`);
    }
  }
  if (inputs.github_token !== undefined) {
    throw new Error('github_token is not supported: Hugi passes no credentials into the VM');
  }
}

/**
 * Tool names separated by spaces, each without a version or a flag. The action splits them with
 * @actions/exec's argStringToArray, on spaces only, stripping double quotes; any other whitespace,
 * quote, or backslash would split differently there, so it is refused.
 */
function installArgsOf(inputs: Inputs): string[] {
  const value = inputOf(inputs, 'install_args');
  if (/[^\S ]|["'\\]/u.test(value)) {
    throw new Error(
      'install_args must be tool names separated by spaces, without tabs, line breaks, quotes, or backslashes',
    );
  }
  const names = value === '' ? [] : value.split(/ +/u);
  for (const name of names) {
    if (name.includes('@') || name.startsWith('-')) {
      throw new Error(
        `install_args must be tool names without a version or a flag, but has ${JSON.stringify(name)}`,
      );
    }
  }
  return names;
}

/** A relative path inside the workspace, normalized; `undefined` for the workspace itself. */
function workingDirectoryOf(inputs: Inputs): string | undefined {
  const value = inputOf(inputs, 'working_directory');
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '..')
  ) {
    throw new Error(
      'working_directory must be a relative path inside the workspace, without parent traversal',
    );
  }
  const normalized = value === '' ? '.' : posix.normalize(value).replace(/\/+$/u, '');
  return normalized === '.' || normalized === '' ? undefined : normalized;
}

/** The step's settings from its inputs; throws on an input Hugi cannot honour or the action would reject. */
export function miseActionSettings(inputs: Inputs): MiseActionSettings {
  checkRetryBudget(inputs, 'cache_restore_retry_budget');
  checkRetryBudget(inputs, 'cache_save_retry_budget');
  checkCacheMaxAge(inputs);
  checkMinimumReleaseAge(inputs);
  checkRefused(inputs);
  for (const name of [
    'cache',
    'cache_save',
    'cache_save_post',
    'auto_update',
    'fetch_from_github',
  ] as const) {
    booleanOf(inputs, name);
  }
  const logLevel = inputs.log_level === undefined ? 'info' : inputOf(inputs, 'log_level');
  const miseEnv = inputOf(inputs, 'mise_env');
  const version = inputOf(inputs, 'version').replace(/^v/u, '');
  const workingDirectory = workingDirectoryOf(inputs);
  return {
    addShimsToPath: booleanOf(inputs, 'add_shims_to_path'),
    env: booleanOf(inputs, 'env'),
    experimental: booleanOf(inputs, 'experimental'),
    exportPath: booleanOf(inputs, 'export_path'),
    install: booleanOf(inputs, 'install'),
    installArgs: installArgsOf(inputs),
    monorepo: booleanOf(inputs, 'monorepo'),
    reshim: booleanOf(inputs, 'reshim'),
    ...(logLevel === '' ? {} : { logLevel }),
    ...(miseEnv === '' ? {} : { miseEnv }),
    ...(version === '' ? {} : { version }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  };
}
