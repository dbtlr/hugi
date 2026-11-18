/** Parsing of `hugi run`'s lane, `--matrix`, and `--needs` arguments into the lane reader's inputs. */
import { UsageError } from '@loomcli/core';

import type { EventContext, LaneRef } from '../lane/step-plan';

/** Exit 2: an argument of `hugi run` is malformed. */
export class RunUsageError extends UsageError {
  override readonly name = 'RunUsageError';
}

const WORKFLOW_DIRECTORY = '.github/workflows';

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
  return { job, workflow: path.includes('/') ? path : `${WORKFLOW_DIRECTORY}/${path}` };
}

/** Split `key=value` at the first equals sign; both sides must be non-empty. */
function parsePair(entry: string, flag: string): [string, string] {
  const equals = entry.indexOf('=');
  if (equals <= 0) {
    throw new RunUsageError(`${flag} "${entry}" is not key=value.`);
  }
  return [entry.slice(0, equals), entry.slice(equals + 1)];
}

/** Names that would reach or shadow `Object.prototype` if a later reader used a plain object. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function refusePrototypeKey(key: string, flag: string, entry: string): void {
  if (PROTOTYPE_KEYS.has(key)) {
    throw new RunUsageError(`${flag} "${entry}" uses the reserved name "${key}".`);
  }
}

/** A map with no prototype, so no key resolves to an inherited member. */
function emptyMap<Value>(): Record<string, Value> {
  const map: Record<string, Value> = {};
  Object.setPrototypeOf(map, null);
  return map;
}

/** `--matrix key=value` entries. Values stay strings; the lane reader compares them as GitHub does. */
export function parseMatrix(entries: readonly string[]): Record<string, string> {
  const matrix = emptyMap<string>();
  for (const entry of entries) {
    const [key, value] = parsePair(entry, '--matrix');
    refusePrototypeKey(key, '--matrix', entry);
    if (Object.hasOwn(matrix, key)) {
      throw new RunUsageError(`--matrix names "${key}" twice.`);
    }
    matrix[key] = value;
  }
  return matrix;
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
