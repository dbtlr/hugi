/**
 * The GitHub environment the lanes read: the variables a runner sets, and the
 * `GITHUB_ENV` / `GITHUB_PATH` / `GITHUB_OUTPUT` files steps append to. Each
 * step gets fresh, empty command files; the runner parses them once the step
 * exits, and a malformed file fails the step as it does on GitHub.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { refValues } from '../lane/refs';
import type { EventContext } from '../lane/step-plan';
import { GUEST_COMMAND_FILES, GUEST_RUNNER_PATHS } from './guest-paths';
import { shellQuote } from './shell';

export type Environment = Readonly<Record<string, string>>;

/** The variables GitHub's runner exports to every step. */
export function githubEnvironment(event: EventContext): Environment {
  const refs = refValues(event);
  // oxlint-disable-next-line sort-keys -- grouped by meaning, not alphabet
  return {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: GUEST_RUNNER_PATHS.workspace,
    GITHUB_REPOSITORY: event.repository,
    GITHUB_SHA: event.sha,
    GITHUB_REF: refs.ref,
    GITHUB_REF_NAME: refs.refName,
    GITHUB_REF_TYPE: refs.refType,
    GITHUB_HEAD_REF: refs.headRef,
    GITHUB_BASE_REF: refs.baseRef,
    GITHUB_EVENT_NAME: event.event,
    RUNNER_OS: 'macOS',
    RUNNER_ARCH: 'ARM64',
    RUNNER_TEMP: GUEST_RUNNER_PATHS.temp,
    GITHUB_STEP_SUMMARY: GUEST_COMMAND_FILES.stepSummary,
    // A step that runs `mise` itself does not read the repository's config (ADR-0006). A runner
    // variable, so a workflow or step can override it.
    MISE_IGNORED_CONFIG_PATHS: GUEST_RUNNER_PATHS.workspace,
    HOMEBREW_NO_AUTO_UPDATE: '1',
  };
}

/**
 * The environment of Hugi's own steps that read the repository's mise config: what "Install
 * tools" runs with (the runner's variables, then the plan's `env`), with the workspace trusted
 * instead of ignored.
 */
export function miseConfigEnvironment(event: EventContext, planEnv: Environment): Environment {
  const { MISE_IGNORED_CONFIG_PATHS: _ignored, ...rest } = {
    ...githubEnvironment(event),
    ...planEnv,
  };
  return { ...rest, MISE_TRUSTED_CONFIG_PATHS: GUEST_RUNNER_PATHS.workspace };
}

/**
 * The variables that keep every mise config outside the workspace from loading: `configDir`, an
 * empty directory, as mise's config directory and the home of its global config, and a ceiling on
 * the upward search at the workspace's parent (ADR-0007, ADR-0008).
 */
export function miseIsolation(configDir: string): Environment {
  return {
    MISE_CEILING_PATHS: posix.dirname(GUEST_RUNNER_PATHS.workspace),
    MISE_CONFIG_DIR: configDir,
    MISE_GLOBAL_CONFIG_FILE: `${configDir}/config.toml`,
  };
}

/** The environment without mise's per-tool version variables (`MISE_NODE_VERSION`). */
export function withoutToolVersions(env: Environment): Environment {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !/^MISE_.+_VERSION$/.test(name)),
  );
}

/**
 * A parsed `GITHUB_ENV` file: the assignments read, and the error GitHub's runner reports for the
 * first bad line. The runner sets each assignment as it reads it, so `env` holds the ones before
 * that line even when `error` is set.
 */
export type EnvFileParse = { readonly env: Environment; readonly error?: string };

/**
 * Parse the content of a `GITHUB_ENV` file as GitHub's runner does: `KEY=value`
 * lines and `KEY<<DELIMITER` blocks that run to a line equal to the delimiter,
 * whichever of `=` and `<<` comes first deciding the form. Lines end at `\n`
 * alone, as on the runner outside Windows, so a `\r` stays in the line. Empty
 * lines are skipped and later assignments win. Any other line, an empty name or
 * delimiter, or a block with no closing delimiter is an error that fails the
 * step, with GitHub's wording; parsing stops there, keeping what came before.
 */
export function parseEnvFile(content: string): EnvFileParse {
  return parseKeyValueFile(content, 'env');
}

/**
 * How GitHub's runner reads an action's `core.exportVariable` writes of `variables`, in order: each
 * is a `name<<delimiter` block in `GITHUB_ENV`, with a random `ghadelimiter_<uuid>` delimiter, as
 * the action's toolkit writes it, and the runner parses the file as `parseEnvFile` does. A name the
 * file cannot carry, such as `A=B`, `C<<D` or one holding a newline, is an error that fails the
 * step, while `FOO-BAR` passes through. As on the runner, the bad name's opening line is still read
 * where it can be: `A=B` sets `A` to `B<<ghadelimiter_<uuid>`, which later steps get. The names
 * after the bad one are dropped.
 */
export function parseExportedVariables(variables: Environment): EnvFileParse {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  return parseEnvFile(
    Object.entries(variables)
      .map(([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
      .join(''),
  );
}

/**
 * Check a `GITHUB_OUTPUT` file against the `GITHUB_ENV` grammar: `undefined`
 * when it is valid, else the error GitHub's runner fails the step with. The
 * values go nowhere, since the lane reader refuses `steps.*.outputs`.
 */
export function parseOutputFile(content: string): string | undefined {
  return parseKeyValueFile(content, 'output').error;
}

/**
 * The runner's one parser for both files; an error opens with the line it logs before the parse
 * error, which names the file command.
 */
function parseKeyValueFile(content: string, command: 'env' | 'output'): EnvFileParse {
  const parsed: Record<string, string> = {};
  const failure = (error: string): EnvFileParse => ({
    env: parsed,
    error: `Unable to process file command '${command}' successfully. ${error}`,
  });
  const lines = content.split('\n');
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line === '') {
      continue;
    }
    const equals = line.indexOf('=');
    const heredoc = line.indexOf('<<');
    if (equals !== -1 && (heredoc === -1 || equals < heredoc)) {
      if (equals === 0) {
        return failure(`Invalid format '${line}'. Name must not be empty`);
      }
      parsed[line.slice(0, equals)] = line.slice(equals + 1);
      continue;
    }
    if (heredoc === -1) {
      return failure(`Invalid format '${line}'`);
    }
    const key = line.slice(0, heredoc);
    const delimiter = line.slice(heredoc + 2);
    if (key === '' || delimiter === '') {
      return failure(
        `Invalid format '${line}'. Name must not be empty and delimiter must not be empty`,
      );
    }
    // Searched from the opening line, so each line is visited once however many blocks there are.
    const end = lines.indexOf(delimiter, at + 1);
    if (end === -1) {
      return failure(`Invalid value. Matching delimiter not found '${delimiter}'`);
    }
    parsed[key] = lines.slice(at + 1, end).join('\n');
    at = end;
  }
  return { env: parsed };
}

/** Names GitHub's runner refuses from `GITHUB_ENV`, in any case (actions/runner `_setEnvBlockList`). */
const GITHUB_ENV_BLOCKED = ['NODE_OPTIONS'];

/**
 * What a step's `GITHUB_ENV` writes carry to later steps: all but the names GitHub's runner
 * refuses, with the error it logs for each refused write.
 */
export function carriedGithubEnv(written: Environment): {
  readonly env: Environment;
  readonly refused: readonly string[];
} {
  const env: Record<string, string> = {};
  const refused: string[] = [];
  for (const [name, value] of Object.entries(written)) {
    const blocked = GITHUB_ENV_BLOCKED.find((candidate) => candidate === name.toUpperCase());
    if (blocked === undefined) {
      env[name] = value;
    } else {
      refused.push(`Can't store ${blocked} output parameter using '$GITHUB_ENV' command.`);
    }
  }
  return { env, refused };
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
 * request's tool specs, so mise resolves the workflow's tools to the pinned
 * versions whatever a config file says. A spec with no `@version` sets nothing.
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

/**
 * The environment as `/usr/bin/env` assignment words, each `KEY=value` shell-quoted whole, without
 * the names in `omit`. Put after `/usr/bin/env --` on the command that starts a process, they give
 * it every variable exactly, whatever its name: `FOO-BAR`, a name bash treats specially such as
 * `UID` or `SECONDS`, or a key starting with `-`, which `--` keeps from reading as an option. No
 * shell of Hugi's sees them. A key `env` cannot set, such as an empty one or one starting with `=`,
 * makes `env` fail, so the process does not start and the command exits non-zero.
 */
export function envAssignments(env: Environment, omit: readonly string[]): string[] {
  return Object.entries(env)
    .filter(([key]) => !omit.includes(key))
    .map(([key, value]) => shellQuote(`${key}=${value}`));
}
