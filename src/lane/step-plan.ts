/**
 * The step plan: one lane of a workflow file, read at a commit, as the ordered
 * steps a run executes. The lane reader produces it; toolchain resolution and
 * the VM runner consume it. Every `${{ }}` expression is already expanded and
 * every read-time condition (such as `runner.os == 'macOS'`) already decided,
 * so a step in the plan only waits on run-time state: whether an earlier step
 * failed.
 */

/** Which lane to read: a job in a workflow file, with its matrix values fixed. */
export type LaneRef = {
  /** Workflow path relative to the repository root, e.g. `.github/workflows/ci.yml`. */
  readonly workflow: string;
  /** The job's key under `jobs:`. */
  readonly job: string;
  /** One value per matrix axis; empty for a job with no matrix. */
  readonly matrix: Readonly<Record<string, string>>;
};

/** The event a run stands in for, as the workflow's `github.*` context sees it. */
export type EventContext = {
  /** `owner/name` on GitHub. */
  readonly repository: string;
  readonly sha: string;
  readonly event: 'push' | 'pull_request';
  readonly refType: 'branch' | 'tag';
  readonly refName: string;
};

/** Guest paths the reader substitutes for `github.workspace` and `runner.temp`. */
export type RunnerPaths = {
  readonly workspace: string;
  readonly temp: string;
};

/**
 * When a step runs, from the run-time half of its `if:`.
 * `success` (the default) runs only while no earlier step has failed,
 * `always` runs regardless, `failure` runs only after an earlier step failed.
 */
export type StepWhen = 'success' | 'always' | 'failure';

type StepBase = {
  /** 1-based position in the job's `steps:` list, kept for log names. */
  readonly index: number;
  /** The step's `name:`, else its `uses:`, else `step <index>`. */
  readonly name: string;
  readonly when: StepWhen;
  /** The step's own `env:`, expanded; layered over the plan's env. */
  readonly env: Readonly<Record<string, string>>;
  readonly continueOnError: boolean;
  readonly timeoutMinutes?: number;
};

/** A `run:` step, executed in the guest as written. */
export type RunStep = StepBase & {
  readonly kind: 'run';
  readonly script: string;
  readonly shell: 'bash' | 'sh';
  /** Relative to the workspace; absent means the workspace itself. */
  readonly workingDirectory?: string;
};

/** A `uses:` step. Toolchain resolution maps it to tools or a no-op; the runner never executes it. */
export type ActionStep = StepBase & {
  readonly kind: 'action';
  /** `owner/repo[/path]@ref`, as written. */
  readonly uses: string;
  readonly with: Readonly<Record<string, string>>;
};

export type PlanStep = RunStep | ActionStep;

export type StepPlan = {
  readonly lane: LaneRef;
  /** The job's display name with its expressions expanded, e.g. `bun / macos-latest`. */
  readonly name: string;
  /** The job's `timeout-minutes`, or GitHub's default of 360. */
  readonly timeoutMinutes: number;
  /** Workflow-level then job-level `env:`, expanded. */
  readonly env: Readonly<Record<string, string>>;
  /** Every step whose read-time condition holds, in workflow order. */
  readonly steps: readonly PlanStep[];
};
