/**
 * Decide whether a workflow's `on:` block starts it for one event Hugi considers (ADR-0004,
 * "Events"). Pure: the caller supplies the event and, lazily, the files it changed.
 */
import { TriggerError } from './errors';
import { filtersStart } from './filters';

export { TriggerError } from './errors';
export { skipsWorkflows } from './skip';

export type TriggerEvent =
  | {
      readonly kind: 'push';
      readonly branch: string;
      readonly changedFiles: () => Promise<readonly string[]>;
    }
  | {
      readonly kind: 'pull_request';
      readonly baseRef: string;
      readonly changedFiles: () => Promise<readonly string[]>;
    };

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the workflow's parsed `on:` value starts it for `event`. */
export async function workflowStarts(on: unknown, event: TriggerEvent): Promise<boolean> {
  if (typeof on === 'string') {
    return on === event.kind;
  }
  if (Array.isArray(on)) {
    if (on.some((name) => typeof name !== 'string')) {
      throw new TriggerError('on: a list must name events as strings');
    }
    return on.includes(event.kind);
  }
  if (!isMapping(on)) {
    throw new TriggerError('on: must be an event name, a list of them, or a mapping');
  }
  if (!Object.hasOwn(on, event.kind)) {
    return false;
  }
  const filters = on[event.kind];
  if (filters === null || filters === undefined) {
    return event.kind !== 'pull_request' || filtersStart(event, {});
  }
  if (!isMapping(filters)) {
    throw new TriggerError(`on.${event.kind} must be empty or a mapping of filters`);
  }
  return filtersStart(event, filters);
}
