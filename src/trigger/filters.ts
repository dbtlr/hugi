/**
 * Evaluate the filters of one event inside a workflow's `on:` block. GitHub's rules: the branch
 * filter and the path filter must both pass, a `branches` or `paths` list needs one positive
 * pattern, and `branches` cannot sit beside `branches-ignore`, nor `paths` beside `paths-ignore`.
 */
import { TriggerError } from './errors';
import type { TriggerEvent } from './index';
import { matchesPattern, matchesPatterns } from './patterns';

type Filters = Readonly<Record<string, unknown>>;

/** The pull request activity types a poller can observe from a head commit's state. */
const OBSERVABLE_TYPES = new Set(['opened', 'synchronize', 'reopened']);

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A filter's patterns: a string or a list of strings, or undefined when the key is absent. */
function patternList(event: string, filters: Filters, key: string): string[] | undefined {
  const value = filters[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const list: unknown = typeof value === 'string' ? [value] : value;
  if (!isStringList(list)) {
    throw new TriggerError(`on.${event}.${key} must be a string or a list of strings`);
  }
  return list;
}

function refuseTogether(event: string, filters: Filters, keys: readonly [string, string]): void {
  if (patternList(event, filters, keys[0]) && patternList(event, filters, keys[1])) {
    throw new TriggerError(`on.${event} cannot have both ${keys[0]} and ${keys[1]}`);
  }
}

/** Whether an include list selects the name, refusing a list with no positive pattern. */
function included(event: string, key: string, patterns: readonly string[], name: string): boolean {
  if (!patterns.some((pattern) => !pattern.startsWith('!'))) {
    throw new TriggerError(`on.${event}.${key} needs at least one pattern without a leading !`);
  }
  return matchesPatterns(patterns, name);
}

function ignored(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, name));
}

/** Whether a name passes an include/ignore pair, or true when neither key is present. */
function passesNames(
  event: string,
  filters: Filters,
  keys: readonly [string, string],
  name: string,
) {
  const include = patternList(event, filters, keys[0]);
  const ignore = patternList(event, filters, keys[1]);
  if (include) {
    return included(event, keys[0], include, name);
  }
  return ignore ? !ignored(ignore, name) : true;
}

async function passesPaths(event: TriggerEvent, filters: Filters): Promise<boolean> {
  const include = patternList(event.kind, filters, 'paths');
  const ignore = patternList(event.kind, filters, 'paths-ignore');
  if (!include && !ignore) {
    return true;
  }
  const files = await event.changedFiles();
  if (include) {
    return files.some((file) => included(event.kind, 'paths', include, file));
  }
  return files.some((file) => !ignored(ignore!, file));
}

function validate(event: string, filters: Filters, pairs: readonly [string, string][]): void {
  for (const pair of pairs) {
    refuseTogether(event, filters, pair);
  }
}

/** A push to the default branch: branch filters see the branch, and a tags-only filter excludes it. */
async function pushStarts(event: TriggerEvent & { kind: 'push' }, filters: Filters) {
  validate('push', filters, [
    ['branches', 'branches-ignore'],
    ['tags', 'tags-ignore'],
    ['paths', 'paths-ignore'],
  ]);
  const branchFilter =
    patternList('push', filters, 'branches') ?? patternList('push', filters, 'branches-ignore');
  const tagFilter =
    patternList('push', filters, 'tags') ?? patternList('push', filters, 'tags-ignore');
  if (tagFilter && !branchFilter) {
    return false;
  }
  return (
    passesNames('push', filters, ['branches', 'branches-ignore'], event.branch) &&
    (await passesPaths(event, filters))
  );
}

function typesStart(filters: Filters): boolean {
  const types = patternList('pull_request', filters, 'types');
  return !types || types.some((type) => OBSERVABLE_TYPES.has(type));
}

async function pullRequestStarts(event: TriggerEvent & { kind: 'pull_request' }, filters: Filters) {
  validate('pull_request', filters, [
    ['branches', 'branches-ignore'],
    ['paths', 'paths-ignore'],
  ]);
  return (
    typesStart(filters) &&
    passesNames('pull_request', filters, ['branches', 'branches-ignore'], event.baseRef) &&
    (await passesPaths(event, filters))
  );
}

/** Whether the filters of the event's own `on:` entry let the event start the workflow. */
export function filtersStart(event: TriggerEvent, filters: Filters): Promise<boolean> {
  return event.kind === 'push' ? pushStarts(event, filters) : pullRequestStarts(event, filters);
}
