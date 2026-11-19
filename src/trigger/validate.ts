/**
 * Check a workflow's `on:` block as GitHub checks it when it reads the workflow file. GitHub
 * refuses the whole file for a bad `push` or `pull_request` entry, whatever event is happening,
 * so both entries are checked every time and the result depends on the workflow alone. Other
 * events' entries are not inspected.
 */
import { TriggerError } from './errors';
import { parsePattern } from './patterns';

/** The filters GitHub accepts under each event Hugi considers. */
const FILTER_KEYS = {
  pull_request: ['branches', 'branches-ignore', 'paths', 'paths-ignore', 'types'],
  push: ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore'],
} as const;

/** Include lists, whose `!` patterns deselect and which need a pattern without `!`. */
const INCLUDE_KEYS = new Set(['branches', 'tags', 'paths']);

const PATTERN_KEYS = new Set([
  'branches',
  'branches-ignore',
  'tags',
  'tags-ignore',
  'paths',
  'paths-ignore',
]);

/** Pairs GitHub refuses together under one event. */
const EXCLUSIVE_PAIRS = [
  ['branches', 'branches-ignore'],
  ['tags', 'tags-ignore'],
  ['paths', 'paths-ignore'],
] as const;

/**
 * The activity types GitHub's workflow schema accepts for `pull_request` (`workflow-v1.0.json` in
 * actions/languageservices); any other `types` value is refused. `stacked` is in the schema
 * before the documentation lists it.
 */
const PULL_REQUEST_TYPES = new Set([
  'assigned',
  'unassigned',
  'labeled',
  'unlabeled',
  'opened',
  'edited',
  'closed',
  'reopened',
  'synchronize',
  'converted_to_draft',
  'ready_for_review',
  'locked',
  'unlocked',
  'review_requested',
  'review_request_removed',
  'auto_merge_enabled',
  'auto_merge_disabled',
  'milestoned',
  'demilestoned',
  'enqueued',
  'dequeued',
  'stacked',
]);

export type TriggerEventKind = keyof typeof FILTER_KEYS;

/** A YAML mapping: a plain object, never an array, a Date, or another class instance. */
export function isMapping(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** An own key's value, so a key inherited from a prototype never counts. */
export function ownValue(mapping: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(mapping, key) ? mapping[key] : undefined;
}

/** A filter's values: a string or a list of strings, or undefined when the key is absent or null. */
export function filterList(
  event: TriggerEventKind,
  filters: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const value = ownValue(filters, key);
  if (value === undefined || value === null) {
    return undefined;
  }
  const list: unknown = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) {
    throw new TriggerError(`on.${event}.${key} must be a string or a list of strings`);
  }
  return list;
}

function checkPatterns(event: TriggerEventKind, key: string, patterns: readonly string[]) {
  const include = INCLUDE_KEYS.has(key);
  for (const [index, pattern] of patterns.entries()) {
    if (pattern === '') {
      throw new TriggerError(`on.${event}.${key}[${index}] is an empty pattern`);
    }
    try {
      parsePattern(include && pattern.startsWith('!') ? pattern.slice(1) : pattern);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TriggerError(`on.${event}.${key}[${index}] is not a valid pattern: ${reason}`);
    }
  }
  if (include && patterns.some((pattern) => pattern.startsWith('!'))) {
    if (patterns.every((pattern) => pattern.startsWith('!'))) {
      throw new TriggerError(`on.${event}.${key} needs at least one pattern without a leading !`);
    }
  }
}

function checkTypes(event: TriggerEventKind, types: readonly string[]) {
  for (const [index, type] of types.entries()) {
    if (!PULL_REQUEST_TYPES.has(type)) {
      throw new TriggerError(`on.${event}.types[${index}] is not an activity type of ${event}`);
    }
  }
}

function checkEntry(event: TriggerEventKind, entry: unknown) {
  if (entry === null || entry === undefined) {
    return;
  }
  if (!isMapping(entry)) {
    throw new TriggerError(`on.${event} must be empty or a mapping of filters`);
  }
  const allowed: readonly string[] = FILTER_KEYS[event];
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) {
      throw new TriggerError(`on.${event} has an unknown filter key ${JSON.stringify(key)}`);
    }
  }
  const lists = new Map(allowed.map((key) => [key, filterList(event, entry, key)] as const));
  for (const [first, second] of EXCLUSIVE_PAIRS) {
    if (lists.get(first) && lists.get(second)) {
      throw new TriggerError(`on.${event} cannot have both ${first} and ${second}`);
    }
  }
  for (const [key, list] of lists) {
    if (list && PATTERN_KEYS.has(key)) {
      checkPatterns(event, key, list);
    }
    if (list && key === 'types') {
      checkTypes(event, list);
    }
  }
}

/**
 * Throw a `TriggerError` unless GitHub would accept the `on:` block: an event name, a list of
 * them, or a mapping of events, with well-formed `push` and `pull_request` entries.
 */
export function validateTriggers(on: unknown): void {
  if (typeof on === 'string') {
    if (on === '') {
      throw new TriggerError('on: must name an event');
    }
    return;
  }
  if (Array.isArray(on)) {
    if (on.length === 0 || !on.every((name) => typeof name === 'string' && name !== '')) {
      throw new TriggerError('on: a list must name one or more events as strings');
    }
    return;
  }
  if (!isMapping(on) || Object.keys(on).length === 0) {
    throw new TriggerError('on: must name an event, a list of events, or a mapping of events');
  }
  for (const event of ['push', 'pull_request'] as const) {
    checkEntry(event, ownValue(on, event));
  }
}
