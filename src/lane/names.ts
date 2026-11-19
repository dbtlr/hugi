/**
 * Names shared by the readers of lane arguments: `hugi run`'s lane and `--matrix` arguments and
 * the lane declaration. Each reader words its own refusals; the rules live here once.
 */

/** Where a bare workflow file name is read from. */
export const WORKFLOWS_DIRECTORY = '.github/workflows';

/** The repository-relative path of a workflow name: a bare file name is read from `.github/workflows/`. */
export function workflowPath(name: string): string {
  return name.includes('/') ? name : `${WORKFLOWS_DIRECTORY}/${name}`;
}

/** Names that would reach or shadow `Object.prototype` if a later reader used a plain object. */
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isPrototypeKey(key: string): boolean {
  return PROTOTYPE_KEYS.has(key);
}

/** A map with no prototype, so no key resolves to an inherited member. */
export function emptyMap<Value>(): Record<string, Value> {
  const map: Record<string, Value> = {};
  Object.setPrototypeOf(map, null);
  return map;
}
