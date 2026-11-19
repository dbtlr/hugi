/**
 * The poller's vocabulary: a snapshot of what one poll read from GitHub and the enrolled
 * repositories, and the queue derived from it. The queue holds candidates, each a commit with one
 * lane that still lacks a verdict (ADR-0005), plus what the caller must report.
 */
import type { CommitStatusState } from '../github/client';
import type { LaneRef, PullRequestRef } from '../lane/step-plan';

/** The event a commit is considered for: a push to the default branch, or an open pull request. */
export type CommitEvent =
  | { readonly kind: 'push'; readonly branch: string }
  | { readonly kind: 'pull_request'; readonly pullRequest: PullRequestRef };

/** Whether a declared lane runs for the commit's event, decided by its trigger and its job's `if:`. */
export type LaneDecision =
  | { readonly kind: 'runs'; readonly lane: LaneRef }
  /** The workflow's `on:` or the job's `if:` leaves the lane out: no run and no status. */
  | { readonly kind: 'left-out'; readonly lane: LaneRef }
  /** The workflow's `on:` is one GitHub would refuse, so the lane does not run; `cause` says why. */
  | { readonly kind: 'refused-trigger'; readonly lane: LaneRef; readonly cause: string };

/** The latest state of each status context on the commit the outcome belongs to. */
export type CommitStatuses = ReadonlyMap<string, CommitStatusState>;

/** What one poll learned about a commit. */
export type CommitRead =
  /** The commit's message carries a skip instruction, so it starts no lane. */
  | { readonly kind: 'skipped' }
  /** The pull request has no current merge commit; it is considered again at the next poll. */
  | { readonly kind: 'no-merge'; readonly cause: string }
  /** The commit has no lane declaration, so it has no lanes. */
  | { readonly kind: 'no-declaration' }
  | { readonly kind: 'refused'; readonly cause: string; readonly statuses: CommitStatuses }
  | {
      readonly kind: 'lanes';
      readonly lanes: readonly LaneDecision[];
      readonly statuses: CommitStatuses;
    };

/** One commit a poll considered. */
export type CommitSnapshot = {
  /** `owner/name`. */
  readonly repository: string;
  /** The commit the outcome belongs to: the default branch head, or the pull request's head. */
  readonly commit: string;
  readonly event: CommitEvent;
  readonly read: CommitRead;
};

/** One enrolled repository as a poll read it, or why its reads failed. */
export type RepositorySnapshot =
  | {
      readonly kind: 'read';
      readonly repository: string;
      readonly defaultBranch: CommitSnapshot;
      /** The open pull requests the allowlist admits. */
      readonly pullRequests: readonly CommitSnapshot[];
    }
  | { readonly kind: 'failed'; readonly repository: string; readonly cause: string };

/** Every enrolled repository, in configuration order. */
export type Snapshot = readonly RepositorySnapshot[];

/** The run in flight: never queued again and never cancelled, even after its pull request moves. */
export type RunInFlight = {
  readonly repository: string;
  /** The commit its outcome belongs to. */
  readonly commit: string;
  readonly lane: LaneRef;
};

/** A commit with one lane that lacks a verdict, ready to run. */
export type Candidate = {
  readonly repository: string;
  /** The commit the lane's status belongs to: the default branch head, or the pull request's head. */
  readonly commit: string;
  readonly event: CommitEvent;
  readonly lane: LaneRef;
  /** The commit status the lane's verdict is posted as. */
  readonly statusName: string;
};

/** A refused declaration whose failure status the caller posts on `commit`. */
export type DeclarationReport = {
  readonly repository: string;
  readonly commit: string;
  readonly cause: string;
};

/** A lane left out because its workflow's `on:` is one GitHub would refuse. */
export type RefusedTrigger = {
  readonly repository: string;
  readonly commit: string;
  readonly lane: LaneRef;
  readonly cause: string;
};

/** A repository skipped for this poll because its reads failed. */
export type RepositoryFailure = { readonly repository: string; readonly cause: string };

/** What the poll derives: the candidates in run order, and what the caller must report. */
export type Queue = {
  readonly candidates: readonly Candidate[];
  readonly declarationReports: readonly DeclarationReport[];
  readonly refusedTriggers: readonly RefusedTrigger[];
  readonly failures: readonly RepositoryFailure[];
};
