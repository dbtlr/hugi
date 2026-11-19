/**
 * Decide whether a workflow's `on:` block starts it for one event Hugi considers (ADR-0004,
 * "Events"). Pure: the caller supplies the event and, lazily, the files it changed.
 */
import { filtersStart } from './filters';
import { isMapping, validateTriggers } from './validate';

export { TriggerError } from './errors';
export { skipsWorkflows } from './skip';
export { validateTriggers } from './validate';

export type TriggerEvent =
  | {
      readonly kind: 'push';
      /** The short name of the branch pushed to, such as `main`, not `refs/heads/main`. */
      readonly branch: string;
      /**
       * The repository-relative paths the commit changed against its first parent (ADR-0004).
       * Called only when a path filter needs them.
       */
      readonly changedFiles: () => Promise<readonly string[]>;
    }
  | {
      readonly kind: 'pull_request';
      /** The short name of the branch the pull request targets, such as `main`. */
      readonly baseRef: string;
      /**
       * The repository-relative paths in GitHub's three-dot diff: the head against the merge base
       * of base and head. Called only when a path filter needs them.
       */
      readonly changedFiles: () => Promise<readonly string[]>;
    };

/**
 * Whether the workflow's parsed `on:` value starts it for `event`. The whole block is validated
 * first, so a `TriggerError` depends only on the workflow, never on the branch or the files.
 */
export async function workflowStarts(on: unknown, event: TriggerEvent): Promise<boolean> {
  validateTriggers(on);
  if (typeof on === 'string') {
    return on === event.kind;
  }
  if (Array.isArray(on)) {
    return on.includes(event.kind);
  }
  // Validation leaves a mapping here; the check narrows its type.
  if (!isMapping(on) || !Object.hasOwn(on, event.kind)) {
    return false;
  }
  const filters = on[event.kind];
  // An entry with no filters starts every push and pull request Hugi considers.
  return isMapping(filters) ? filtersStart(event, filters) : true;
}
