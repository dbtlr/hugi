import type { ActionStep } from '../lane/step-plan';

export type ReadRepoFile = (path: string) => Promise<string | undefined>;

/**
 * What a `jdx/mise-action` step does in the guest (ADR-0007), from its inputs with v5.3.0's
 * defaults filled in. Inputs the step does not honour are absent: they were no-ops or refused.
 */
export type MiseActionSettings = {
  readonly install: boolean;
  /** Tool names `mise install` takes after its own arguments; empty installs everything. */
  readonly installArgs: readonly string[];
  readonly env: boolean;
  readonly exportPath: boolean;
  readonly addShimsToPath: boolean;
  readonly reshim: boolean;
  readonly experimental: boolean;
  readonly monorepo: boolean;
  /** Relative to the workspace, normalized; absent for the workspace itself. */
  readonly workingDirectory?: string;
  /** The `MISE_LOG_LEVEL` the step exports; absent when `log_level` is empty. */
  readonly logLevel?: string;
  /** The `MISE_ENV` the step exports. */
  readonly miseEnv?: string;
  /** The version the guest's mise must report, without a leading `v`. */
  readonly version?: string;
};

export type ActionResolution = Pick<ActionStep, 'index' | 'name' | 'uses'> &
  (
    | {
        readonly kind: 'tools';
        readonly tools: readonly [string, ...string[]];
        readonly notes: readonly string[];
      }
    | { readonly kind: 'noop'; readonly reason: string }
    /** A `jdx/mise-action` step, which the VM runner runs at its own place (ADR-0007). */
    | { readonly kind: 'mise-action'; readonly settings: MiseActionSettings }
  );

/** The resolution of a `jdx/mise-action` step. */
export type MiseActionResolution = Extract<ActionResolution, { readonly kind: 'mise-action' }>;

export type ToolchainResolution = {
  /** Deduplicated mise specs, in first-use order. */
  readonly tools: readonly string[];
  readonly actions: readonly ActionResolution[];
  readonly notes: readonly string[];
};
