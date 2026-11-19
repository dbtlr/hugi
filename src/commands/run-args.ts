/** Parsing of `hugi run`'s lane, `--matrix`, and `--needs` arguments into the lane reader's inputs. */
import { UsageError } from '@loomcli/core';

import { readMatrixEntries } from '../lane/matrix';
import type { MatrixEntryProblem } from '../lane/matrix';
import { emptyMap, isPrototypeKey, workflowPath } from '../lane/names';
import type { EventContext, LaneRef } from '../lane/step-plan';

/** Exit 2: an argument of `hugi run` is malformed. */
export class RunUsageError extends UsageError {
  override readonly name = 'RunUsageError';
}

const PULL_REQUEST_ARGUMENT = /^pull\/([1-9][0-9]*)$/u;

/**
 * The pull request a `<commit>` argument of the form `pull/<n>` names, `<n>` a positive decimal
 * number; `undefined` for anything else, such as `pull/0`, which stays a branch name or sha.
 */
export function parsePullRequestArgument(commit: string): number | undefined {
  const digits = PULL_REQUEST_ARGUMENT.exec(commit)?.[1];
  if (digits === undefined) {
    return undefined;
  }
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) {
    throw new RunUsageError(`"${commit}" names a pull request number no repository can have.`);
  }
  return number;
}

/** `<workflow>:<job>`, with a bare workflow file name read from `.github/workflows/`. */
export function parseLaneArgument(text: string): Pick<LaneRef, 'job' | 'workflow'> {
  const split = text.lastIndexOf(':');
  const file = text.slice(0, split);
  const job = text.slice(split + 1);
  if (split <= 0 || job === '') {
    throw new RunUsageError(
      `The lane "${text}" is not <workflow>:<job>, for example ci.yml:build.`,
    );
  }
  const path = file.replace(/^\.\//, '');
  if (path === '') {
    throw new RunUsageError(`The lane "${text}" names no workflow file, for example ci.yml:build.`);
  }
  return { job, workflow: workflowPath(path) };
}

/** Split `key=value` at the first equals sign; both sides must be non-empty. */
function parsePair(entry: string, flag: string): [string, string] {
  const equals = entry.indexOf('=');
  if (equals <= 0) {
    throw new RunUsageError(`${flag} "${entry}" is not key=value.`);
  }
  return [entry.slice(0, equals), entry.slice(equals + 1)];
}

function refusePrototypeKey(key: string, flag: string, entry: string): void {
  if (isPrototypeKey(key)) {
    throw new RunUsageError(`${flag} "${entry}" uses the reserved name "${key}".`);
  }
}

function matrixProblemText(problem: MatrixEntryProblem): string {
  if (problem.kind === 'reserved-key') {
    return `--matrix "${problem.entry}" uses the reserved name "${problem.key}".`;
  }
  if (problem.kind === 'repeated-key') {
    return `--matrix names "${problem.key}" twice.`;
  }
  return `--matrix "${problem.entry}" is not key=value.`;
}

/** `--matrix key=value` entries. Values stay strings; the lane reader compares them as GitHub does. */
export function parseMatrix(entries: readonly string[]): Record<string, string> {
  const result = readMatrixEntries(entries);
  if ('matrix' in result) {
    return result.matrix;
  }
  throw new RunUsageError(matrixProblemText(result.problem));
}

type Needs = NonNullable<EventContext['needs']>;

/** `--needs <job>.outputs.<name>=value` entries: the upstream outputs Hugi cannot compute itself. */
export function parseNeeds(entries: readonly string[]): Needs {
  const needs = emptyMap<{ outputs: Record<string, string> }>();
  for (const entry of entries) {
    const [path, value] = parsePair(entry, '--needs');
    const [job, middle, name, ...rest] = path.split('.');
    if (!job || middle !== 'outputs' || !name || rest.length > 0) {
      throw new RunUsageError(`--needs "${entry}" is not <job>.outputs.<name>=value.`);
    }
    refusePrototypeKey(job, '--needs', entry);
    refusePrototypeKey(name, '--needs', entry);
    const outputs = (needs[job] ??= { outputs: emptyMap() }).outputs;
    if (Object.hasOwn(outputs, name)) {
      throw new RunUsageError(`--needs names ${job}.outputs.${name} twice.`);
    }
    outputs[name] = value;
  }
  return needs;
}
