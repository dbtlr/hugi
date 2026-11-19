/**
 * Evaluate the filters of one event inside a workflow's `on:` block, already checked by
 * `validateTriggers`. GitHub's rules: the branch filter and the path filter must both pass, and a
 * push filtered by tags alone does not start for a branch.
 */
import type { TriggerEvent } from './index';
import { matchesPattern, matchesPatterns } from './patterns';
import { filterList } from './validate';
import type { TriggerEventKind } from './validate';

type Filters = Readonly<Record<string, unknown>>;

/** The pull request activity types a poller can observe from a head commit's state. */
const OBSERVABLE_TYPES = new Set(['opened', 'synchronize', 'reopened']);

function ignored(patterns: readonly string[], name: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, name));
}

/** Whether a name passes an include/ignore pair, or true when neither key is present. */
function passesNames(event: TriggerEventKind, filters: Filters, prefix: string, name: string) {
  const include = filterList(event, filters, prefix);
  if (include) {
    return matchesPatterns(include, name);
  }
  const ignore = filterList(event, filters, `${prefix}-ignore`);
  return ignore ? !ignored(ignore, name) : true;
}

async function passesPaths(event: TriggerEvent, filters: Filters): Promise<boolean> {
  const include = filterList(event.kind, filters, 'paths');
  const ignore = filterList(event.kind, filters, 'paths-ignore');
  if (!include && !ignore) {
    return true;
  }
  const files = await event.changedFiles();
  if (include) {
    return files.some((file) => matchesPatterns(include, file));
  }
  return files.some((file) => !ignored(ignore!, file));
}

/** A push to the default branch: branch filters see the branch, and a tags-only filter excludes it. */
async function pushStarts(event: TriggerEvent & { kind: 'push' }, filters: Filters) {
  const branchFilter =
    filterList('push', filters, 'branches') ?? filterList('push', filters, 'branches-ignore');
  const tagFilter =
    filterList('push', filters, 'tags') ?? filterList('push', filters, 'tags-ignore');
  if (tagFilter && !branchFilter) {
    return false;
  }
  return (
    passesNames('push', filters, 'branches', event.branch) && (await passesPaths(event, filters))
  );
}

function typesStart(filters: Filters): boolean {
  const types = filterList('pull_request', filters, 'types');
  return !types || types.some((type) => OBSERVABLE_TYPES.has(type));
}

async function pullRequestStarts(event: TriggerEvent & { kind: 'pull_request' }, filters: Filters) {
  return (
    typesStart(filters) &&
    passesNames('pull_request', filters, 'branches', event.baseRef) &&
    (await passesPaths(event, filters))
  );
}

/** Whether the filters of the event's own `on:` entry let the event start the workflow. */
export function filtersStart(event: TriggerEvent, filters: Filters): Promise<boolean> {
  return event.kind === 'push' ? pushStarts(event, filters) : pullRequestStarts(event, filters);
}
