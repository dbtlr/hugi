import type { ActionStep } from '../lane/step-plan';

export type ReadRepoFile = (path: string) => Promise<string | undefined>;

export type ActionResolution = Pick<ActionStep, 'index' | 'name' | 'uses'> &
  (
    | {
        readonly kind: 'tools';
        readonly tools: readonly [string, ...string[]];
        readonly notes: readonly string[];
      }
    | { readonly kind: 'noop'; readonly reason: string }
  );

export type ToolchainResolution = {
  /** Deduplicated mise specs, in first-use order. */
  readonly tools: readonly string[];
  readonly actions: readonly ActionResolution[];
  readonly notes: readonly string[];
};
