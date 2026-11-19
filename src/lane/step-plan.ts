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
  /**
   * One value per matrix axis plus any keys an `include` entry adds, typed as
   * the workflow wrote them; empty for a job with no matrix.
   */
  readonly matrix: Readonly<Record<string, string | number | boolean>>;
};

/** Upstream job facts the caller supplies; Hugi runs the lane alone, not its dependencies. */
export type UpstreamFacts = Readonly<
  Record<
    string,
    {
      readonly outputs: Readonly<Record<string, string>>;
      readonly result?: 'success' | 'failure' | 'skipped';
    }
  >
>;

type EventBase = {
  /** `owner/name` on GitHub. */
  readonly repository: string;
  /** The commit that runs: for a pull request, GitHub's merge commit, not the head. */
  readonly sha: string;
  readonly needs?: UpstreamFacts;
};

/** A push of a branch or a tag. */
export type PushEvent = EventBase & {
  readonly event: 'push';
  readonly refType: 'branch' | 'tag';
  readonly refName: string;
};

/** The pull request a `pull_request` run stands for, as GitHub's API reported it (ADR-0005). */
export type PullRequestRef = {
  readonly number: number;
  /** The head commit, whose second-parent place in the merge commit was checked. */
  readonly headSha: string;
  /** The head branch's name, without the fork owner. */
  readonly headRef: string;
  readonly baseRef: string;
};

/** A pull request, run at its merge commit (`sha`) with GitHub's `refs/pull/<n>/merge` ref. */
export type PullRequestEvent = EventBase & {
  readonly event: 'pull_request';
  readonly pullRequest: PullRequestRef;
};

/**
 * The event a run stands in for, as the workflow's `github.*` context and the runner's
 * environment see it. The caller owns matching the workflow's `on:` triggers to the event; the
 * reader does not check them. The event payload (`github.event.*`) is not supplied.
 */
export type EventContext = PushEvent | PullRequestEvent;

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
  /**
   * `default` is a step with no `shell:` (and no `defaults.run.shell`), which
   * GitHub runs on macOS as `bash -e {0}`; `bash` is an explicit `shell: bash`,
   * run as `bash --noprofile --norc -eo pipefail {0}`; `sh` is `sh -e {0}`.
   */
  readonly shell: 'default' | 'bash' | 'sh';
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
