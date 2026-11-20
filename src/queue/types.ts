/**
 * The poller's vocabulary: a snapshot of what one poll read from GitHub and the enrolled
 * repositories, and the queue derived from it. The queue holds candidates, each a commit with one
 * lane that still lacks a verdict (ADR-0005), plus what the caller must report.
 */
import type { DeclaredLane } from '../declaration/read';
import type { CommitStatusState } from '../github/client';
import type { PullRequestRef } from '../lane/step-plan';

/** The event a commit is considered for: a push to the default branch, or an open pull request. */
export type CommitEvent =
  | { readonly kind: 'push'; readonly branch: string }
  | { readonly kind: 'pull_request'; readonly pullRequest: PullRequestRef };

/** Whether a declared lane runs for the commit's event, decided by its trigger and its job's `if:`. */
export type LaneDecision =
  | { readonly kind: 'runs'; readonly lane: DeclaredLane }
  /** The workflow's `on:` or the job's `if:` leaves the lane out: no run and no status. */
  | { readonly kind: 'left-out'; readonly lane: DeclaredLane };

/** The latest state of each status context on the commit the outcome belongs to. */
export type CommitStatuses = ReadonlyMap<string, CommitStatusState>;

/**
 * Why a read failed. A read that failed for a reason the poller does not expect, such as a bug or
 * repository content that trips one, is marked `unexpected`, so the caller logs it loudly.
 */
export type ReadFailure = { readonly cause: string; readonly unexpected?: true };

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
    }
  /** The commit's source or statuses could not be read; it is considered again at the next poll. */
  | ({ readonly kind: 'failed' } & ReadFailure);

/** One commit a poll considered. */
export type CommitSnapshot = {
  /** `owner/name`. */
  readonly repository: string;
  /** The commit the outcome belongs to: the default branch head, or the pull request's head. */
  readonly commit: string;
  readonly event: CommitEvent;
  readonly read: CommitRead;
};

/** An open pull request whose reads failed, with why. */
export type PullRequestReadFailure = { readonly number: number } & ReadFailure;

/** One enrolled repository as a poll read it, or why its reads failed. */
export type RepositorySnapshot =
  | {
      readonly kind: 'read';
      readonly repository: string;
      /** The default branch head; a failed read of it is its `failed` read, and the pull requests are still read. */
      readonly defaultBranch: CommitSnapshot;
      /** The open pull requests the allowlist admits. */
      readonly pullRequests: readonly CommitSnapshot[];
      /** The admitted pull requests whose reads failed; each is skipped for this poll alone. */
      readonly pullRequestFailures: readonly PullRequestReadFailure[];
    }
  /** A repository-level read failed: the repository, its default branch, or its pull-request listing. */
  | ({ readonly kind: 'failed'; readonly repository: string } & ReadFailure);

/** Every enrolled repository, in configuration order. */
export type Snapshot = readonly RepositorySnapshot[];

/**
 * A run in flight, of the at most two ADR-0003 allows at once: never queued again and never
 * cancelled, even after its pull request moves. It is known by the status it posts, which is what
 * GitHub identifies, so it keeps out every lane of its commit that would post under that name.
 */
export type RunInFlight = {
  readonly repository: string;
  /** The commit its outcome belongs to. */
  readonly commit: string;
  /** The commit status its verdict is posted as, its candidate's `statusName`. */
  readonly statusName: string;
};

/** A commit with one lane that lacks a verdict, ready to run. */
export type Candidate = {
  readonly repository: string;
  /** The commit the lane's status belongs to: the default branch head, or the pull request's head. */
  readonly commit: string;
  readonly event: CommitEvent;
  /** The declared lane, with where its tools come from (`tools`). */
  readonly lane: DeclaredLane;
  /** The commit status the lane's verdict is posted as. */
  readonly statusName: string;
};

/** A refused declaration whose failure status the caller posts on `commit`. */
export type DeclarationReport = {
  readonly repository: string;
  readonly commit: string;
  readonly cause: string;
};

/**
 * A read that failed, skipped for this poll. With `pullRequest`, only that pull request is
 * skipped; with `defaultBranch`, only the default branch head is; with neither, the whole
 * repository is. The repository's other commits still yield.
 */
export type RepositoryFailure = {
  readonly repository: string;
  readonly pullRequest?: number;
  /** The default branch whose head's read failed. */
  readonly defaultBranch?: string;
} & ReadFailure;

/** What the poll derives: the candidates in run order, and what the caller must report. */
export type Queue = {
  readonly candidates: readonly Candidate[];
  readonly declarationReports: readonly DeclarationReport[];
  readonly failures: readonly RepositoryFailure[];
};
