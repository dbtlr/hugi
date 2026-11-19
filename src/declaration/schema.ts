/**
 * The declaration's schema: a YAML mapping with one key, `lanes`, a nonempty list of entries.
 * Each entry names a workflow file, the jobs in it, and optionally a matrix filter (ADR-0004).
 * Everything here works on the parsed text alone; reading the workflow files comes later.
 */
import { posix } from 'node:path';

import type { Scalar } from '../lane/matrix';
import { WORKFLOWS_DIRECTORY, emptyMap, isPrototypeKey, workflowPath } from '../lane/names';
import { isMapping } from '../yaml/strict';
import { DeclarationRefusalError } from './errors';

const HUGI_DIRECTORY = '.github/hugi';

/** One validated entry; `workflow` is already the canonical repository-relative path. */
export type Entry = {
  readonly workflow: string;
  readonly jobs: readonly string[];
  readonly matrix: Readonly<Record<string, Scalar>>;
};

/**
 * The repository-relative path a `workflow:` value names. A bare file name is read from
 * `.github/workflows/`; a path with `/` must be canonical and name a file directly in
 * `.github/workflows/` or `.github/hugi/`.
 */
export function resolveWorkflowPath(name: string): string {
  if (name === '') {
    throw new DeclarationRefusalError('workflow must not be empty');
  }
  if (!name.includes('/')) {
    if (name === '.' || name === '..') {
      throw new DeclarationRefusalError(`workflow "${name}" is not a file name`);
    }
    return workflowPath(name);
  }
  if (name.startsWith('/')) {
    throw new DeclarationRefusalError(`workflow "${name}" must not start with /`);
  }
  const segments = name.split('/');
  const bad = segments.find((segment) => segment === '' || segment === '.' || segment === '..');
  if (bad !== undefined) {
    throw new DeclarationRefusalError(
      `workflow "${name}" is not a canonical path: it has ${bad === '' ? 'an empty' : `a "${bad}"`} segment`,
    );
  }
  const directory = posix.dirname(name);
  if (directory !== WORKFLOWS_DIRECTORY && directory !== HUGI_DIRECTORY) {
    throw new DeclarationRefusalError(
      `workflow "${name}" must be a file directly in ${WORKFLOWS_DIRECTORY}/ or ${HUGI_DIRECTORY}/`,
    );
  }
  return name;
}

function checkKeys(entry: Record<string, unknown>) {
  const unknown = Object.keys(entry).filter(
    (key) => key !== 'workflow' && key !== 'jobs' && key !== 'matrix',
  );
  if (unknown.length > 0) {
    throw new DeclarationRefusalError(`has an unknown key "${unknown[0]}"`);
  }
}

function readJobs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new DeclarationRefusalError('jobs must be a list of job ids');
  }
  if (value.length === 0) {
    throw new DeclarationRefusalError('jobs must not be empty');
  }
  const seen = new Set<string>();
  for (const job of value) {
    if (typeof job !== 'string' || job === '') {
      throw new DeclarationRefusalError('jobs must hold only job ids, as strings');
    }
    if (seen.has(job)) {
      throw new DeclarationRefusalError(`jobs lists "${job}" more than once`);
    }
    seen.add(job);
  }
  return [...seen];
}

function readFilter(value: unknown): Record<string, Scalar> {
  if (value === undefined) {
    return {};
  }
  if (!isMapping(value)) {
    throw new DeclarationRefusalError('matrix must be a mapping from matrix key to a value');
  }
  const filter = emptyMap<Scalar>();
  for (const [key, item] of Object.entries(value)) {
    if (isPrototypeKey(key)) {
      throw new DeclarationRefusalError(`matrix uses the reserved name "${key}"`);
    }
    if (
      typeof item !== 'string' &&
      typeof item !== 'boolean' &&
      !(typeof item === 'number' && Number.isFinite(item))
    ) {
      throw new DeclarationRefusalError(`matrix.${key} must be a string, number, or boolean`);
    }
    filter[key] = item;
  }
  return filter;
}

function readEntry(value: unknown): Entry {
  if (!isMapping(value)) {
    throw new DeclarationRefusalError('must be a mapping');
  }
  checkKeys(value);
  if (typeof value.workflow !== 'string') {
    throw new DeclarationRefusalError('workflow is required and must be a string');
  }
  return {
    jobs: readJobs(value.jobs),
    matrix: readFilter(value.matrix),
    workflow: resolveWorkflowPath(value.workflow),
  };
}

/** The entries of a parsed declaration; throws a `DeclarationRefusalError` naming the entry at fault. */
export function readEntries(parsed: unknown): Entry[] {
  if (!isMapping(parsed)) {
    throw new DeclarationRefusalError('the declaration must be a mapping with one key, lanes');
  }
  const extra = Object.keys(parsed).find((key) => key !== 'lanes');
  if (extra !== undefined) {
    throw new DeclarationRefusalError(
      `the declaration has an unknown key "${extra}"; only lanes is allowed`,
    );
  }
  if (!Array.isArray(parsed.lanes)) {
    throw new DeclarationRefusalError('lanes is required and must be a list of entries');
  }
  if (parsed.lanes.length === 0) {
    throw new DeclarationRefusalError('lanes must not be empty');
  }
  return parsed.lanes.map((value: unknown, index) => {
    try {
      return readEntry(value);
    } catch (cause) {
      if (cause instanceof DeclarationRefusalError) {
        throw new DeclarationRefusalError(`lanes[${index}] ${cause.message}`, { cause });
      }
      throw cause;
    }
  });
}
