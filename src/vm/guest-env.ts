/**
 * The GitHub environment the lanes read: the variables a runner sets, and the
 * `GITHUB_ENV` / `GITHUB_PATH` files steps append to for later steps. Each step
 * gets fresh, empty command files; the runner parses them once the step exits.
 */
import type { EventContext } from '../lane/step-plan';
import { GUEST_COMMAND_FILES, GUEST_RUNNER_PATHS } from './guest-paths';

export type Environment = Readonly<Record<string, string>>;

/** The variables GitHub's runner exports to every step. */
export function githubEnvironment(event: EventContext): Environment {
  const refPrefix = event.refType === 'tag' ? 'refs/tags' : 'refs/heads';
  // oxlint-disable-next-line sort-keys -- grouped by meaning, not alphabet
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: GUEST_RUNNER_PATHS.workspace,
    GITHUB_REPOSITORY: event.repository,
    GITHUB_SHA: event.sha,
    GITHUB_REF: `${refPrefix}/${event.refName}`,
    GITHUB_REF_NAME: event.refName,
    GITHUB_REF_TYPE: event.refType,
    GITHUB_EVENT_NAME: event.event,
    RUNNER_OS: 'macOS',
    RUNNER_ARCH: 'ARM64',
    RUNNER_TEMP: GUEST_RUNNER_PATHS.temp,
    GITHUB_OUTPUT: GUEST_COMMAND_FILES.output,
    GITHUB_STEP_SUMMARY: GUEST_COMMAND_FILES.stepSummary,
    // Lets mise read the checked-out repository's config, and keeps brew quick.
    MISE_TRUSTED_CONFIG_PATHS: GUEST_RUNNER_PATHS.workspace,
    HOMEBREW_NO_AUTO_UPDATE: '1',
  };
}

/** A parsed `GITHUB_ENV` file, or the error GitHub's runner reports for it. */
export type EnvFileParse = { readonly env: Environment } | { readonly error: string };

/**
 * Parse the content of a `GITHUB_ENV` file as GitHub's runner does: `KEY=value`
 * lines and `KEY<<DELIMITER` blocks that run to a line equal to the delimiter,
 * whichever of `=` and `<<` comes first deciding the form. Empty lines are
 * skipped and later assignments win. Any other line, an empty name or
 * delimiter, or a block with no closing delimiter is an error that fails the
 * step, with GitHub's wording.
 */
export function parseEnvFile(content: string): EnvFileParse {
  const parsed: Record<string, string> = {};
  const lines = content.split('\n').map((line) => line.replace(/\r$/, ''));
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line === '') {
      continue;
    }
    const equals = line.indexOf('=');
    const heredoc = line.indexOf('<<');
    if (equals !== -1 && (heredoc === -1 || equals < heredoc)) {
      if (equals === 0) {
        return {
          error: `Invalid environment variable format '${line}'. Environment variable name must not be empty`,
        };
      }
      parsed[line.slice(0, equals)] = line.slice(equals + 1);
      continue;
    }
    if (heredoc === -1) {
      return { error: `Invalid environment variable format '${line}'` };
    }
    const key = line.slice(0, heredoc);
    const delimiter = line.slice(heredoc + 2);
    if (key === '' || delimiter === '') {
      return {
        error: `Invalid environment variable format '${line}'. Environment variable name must not be empty and delimiter must not be empty`,
      };
    }
    const end = lines.findIndex((candidate, offset) => offset > at && candidate === delimiter);
    if (end === -1) {
      return {
        error: `Invalid environment variable value. Matching delimiter not found '${delimiter}'`,
      };
    }
    parsed[key] = lines.slice(at + 1, end).join('\n');
    at = end;
  }
  return { env: parsed };
}

/** Parse a `GITHUB_PATH` file into directories, highest priority first (the last one added wins). */
export function parsePathFile(content: string): readonly string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .toReversed();
}

/**
 * Put one step's `GITHUB_PATH` additions (highest priority first) in front of
 * the ones earlier steps made. A directory added again moves to the front.
 */
export function prependPaths(
  earlier: readonly string[],
  added: readonly string[],
): readonly string[] {
  return [...added, ...earlier.filter((directory) => !added.includes(directory))];
}

/**
 * mise's per-tool version overrides (`MISE_NODE_VERSION=22.23.2`) for the
 * request's tool specs, so the shims on PATH resolve to the pinned versions
 * whatever a config file says. A spec with no `@version` sets nothing.
 */
export function toolVersionEnvironment(tools: readonly string[]): Environment {
  const env: Record<string, string> = {};
  for (const spec of tools) {
    const at = spec.lastIndexOf('@');
    if (at > 0) {
      const name = spec
        .slice(0, at)
        .toUpperCase()
        .replaceAll(/[^A-Z0-9]/g, '_');
      env[`MISE_${name}_VERSION`] = spec.slice(at + 1);
    }
  }
  return env;
}

/**
 * The environment one step runs with, lowest to highest priority: the runner's
 * variables, the plan's `env`, values earlier steps put in `GITHUB_ENV`, then
 * the step's own `env`.
 */
export function stepEnvironment(layers: {
  readonly runner: Environment;
  readonly plan: Environment;
  readonly fromGithubEnv: Environment;
  readonly step: Environment;
}): Environment {
  return { ...layers.runner, ...layers.plan, ...layers.fromGithubEnv, ...layers.step };
}
