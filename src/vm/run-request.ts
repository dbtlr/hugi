/**
 * What the VM runner takes and returns. A run clones the golden image, boots
 * it, checks out the source at the commit (shallow, as `actions/checkout`
 * does), installs the lane's tools, executes the plan's `run:` steps, collects
 * logs, and deletes the VM on every exit path.
 */
import type { EventContext, StepPlan } from '../lane/step-plan';

/** Where the guest gets the source. Neither form carries a credential (ADR-0002). */
export type SourceLocation =
  /** A public repository, fetched inside the guest over HTTPS. */
  | { readonly kind: 'remote'; readonly cloneUrl: string }
  /** A git repository on the host, mounted read-only into the guest and fetched from there. */
  | { readonly kind: 'local'; readonly path: string };

export type RunRequest = {
  readonly plan: StepPlan;
  readonly event: EventContext;
  readonly source: SourceLocation;
  /** The tart image to clone, e.g. `hugi-golden`. */
  readonly image: string;
  /** mise tool specs (`bun@1.4.4`) activated for every step; empty when the image's defaults suffice. */
  readonly tools: readonly string[];
  /** Host directory that receives the per-step logs. */
  readonly logDir: string;
};

export type StepOutcome = 'success' | 'failure' | 'skipped' | 'timeout';

export type StepResult = {
  readonly index: number;
  readonly name: string;
  readonly outcome: StepOutcome;
  readonly exitCode?: number;
  readonly seconds: number;
  /** Host path of the step's combined stdout and stderr; absent for a skipped step and a step the VM was lost under. */
  readonly logFile?: string;
  /** Why the step failed when its exit code does not say: an invalid `GITHUB_ENV`, a lost VM. */
  readonly error?: string;
};

/**
 * `passed` and `step-failed` are verdicts on the code, and so is `timeout`, the
 * job timeout. A failed tool install counts as a failing step: the lane's own
 * pins chose the tools; as after any failed step, the plan's `success` steps
 * are skipped while its `always` and `failure` steps still run. A job timeout
 * skips every remaining step, `always` steps included (unlike GitHub, which
 * still runs them). `infrastructure` (the VM failed to clone or boot, exited or
 * stopped answering mid-run, or the source could not be fetched before the
 * job deadline) and `interrupted` (Hugi was stopped) yield no verdict, because
 * the failure lies outside the lane's steps.
 */
export type RunReason = 'passed' | 'step-failed' | 'timeout' | 'infrastructure' | 'interrupted';

export type RunResult = {
  /** `none` exactly when the reason is `infrastructure` or `interrupted`. */
  readonly verdict: 'pass' | 'fail' | 'none';
  readonly reason: RunReason;
  readonly steps: readonly StepResult[];
  readonly timings: {
    readonly cloneSeconds: number;
    readonly bootSeconds: number;
    readonly totalSeconds: number;
  };
  /** One line naming what went wrong, for every reason but `passed`. */
  readonly detail?: string;
};
