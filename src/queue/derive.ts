/**
 * Derive the run queue from one poll's snapshot (ADR-0005, "Where the outcome belongs"). Pure:
 * the queue depends only on what was read and on the runs in flight, so a restart, which has
 * nothing in flight, derives the same queue again from GitHub's state.
 */
import type { CommitStatusState } from '../github/client';
import { DECLARATION_STATUS, laneStatusName } from '../github/status-name';
import type { LaneRef } from '../lane/step-plan';
import type {
  Candidate,
  CommitSnapshot,
  CommitStatuses,
  DeclarationReport,
  Queue,
  RepositoryFailure,
  RepositorySnapshot,
  RunInFlight,
  Snapshot,
} from './types';

/** A status in one of these states carries a verdict; `pending` settles nothing. */
const VERDICTS: ReadonlySet<CommitStatusState> = new Set(['success', 'failure', 'error']);

function hasVerdict(statuses: CommitStatuses, name: string): boolean {
  const state = statuses.get(name);
  return state !== undefined && VERDICTS.has(state);
}

/** Two lanes are one when their job ids and complete rows are equal; the workflow path is not part of it. */
function sameLane(left: LaneRef, right: LaneRef): boolean {
  const keys = Object.keys(left.matrix);
  return (
    left.job === right.job &&
    keys.length === Object.keys(right.matrix).length &&
    keys.every((key) => Object.hasOwn(right.matrix, key) && right.matrix[key] === left.matrix[key])
  );
}

function isInFlight(commit: CommitSnapshot, lane: LaneRef, inFlight: readonly RunInFlight[]) {
  return inFlight.some(
    (run) =>
      run.repository === commit.repository &&
      run.commit === commit.commit &&
      sameLane(run.lane, lane),
  );
}

/** What one commit adds to the queue. */
type CommitYield = {
  readonly candidates: Candidate[];
  readonly declarationReports: DeclarationReport[];
};

function commitYield(commit: CommitSnapshot, inFlight: readonly RunInFlight[]): CommitYield {
  const result: CommitYield = { candidates: [], declarationReports: [] };
  const { read, repository } = commit;
  // A hugi status with a verdict settles every lane without one; verdicts already posted stand.
  if (
    (read.kind !== 'refused' && read.kind !== 'lanes') ||
    hasVerdict(read.statuses, DECLARATION_STATUS)
  ) {
    return result;
  }
  if (read.kind === 'refused') {
    result.declarationReports.push({ cause: read.cause, commit: commit.commit, repository });
    return result;
  }
  for (const decision of read.lanes) {
    const { lane } = decision;
    const statusName = laneStatusName(lane);
    if (
      decision.kind === 'runs' &&
      !hasVerdict(read.statuses, statusName) &&
      !isInFlight(commit, lane, inFlight)
    ) {
      result.candidates.push({
        commit: commit.commit,
        event: commit.event,
        lane,
        repository,
        statusName,
      });
    }
  }
  return result;
}

/** Every default branch head in configuration order, then every pull request by repository and number. */
function inRunOrder(snapshot: Snapshot): CommitSnapshot[] {
  const read = snapshot.flatMap((repository) => (repository.kind === 'read' ? [repository] : []));
  return [
    ...read.map((repository) => repository.defaultBranch),
    ...read.flatMap((repository) =>
      repository.pullRequests.toSorted((left, right) => numberOf(left) - numberOf(right)),
    ),
  ];
}

function numberOf(commit: CommitSnapshot): number {
  return commit.event.kind === 'pull_request' ? commit.event.pullRequest.number : 0;
}

/**
 * The first of each group of values with the same key. Two snapshots can share a head commit, as
 * one branch opened as two pull requests or a pull request whose head is the default branch head;
 * its status is one, so it gets one candidate per lane and one declaration report, and the first
 * in run order, a default branch's, wins.
 */
function firstByKey<Value>(values: readonly Value[], key: (value: Value) => string): Value[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const each = key(value);
    if (seen.has(each)) {
      return false;
    }
    seen.add(each);
    return true;
  });
}

/** The reads that failed in one repository's snapshot. */
function failuresOf(repository: RepositorySnapshot): RepositoryFailure[] {
  const failed = ({ cause, unexpected }: { cause: string; unexpected?: true }) => ({
    cause,
    repository: repository.repository,
    ...(unexpected === undefined ? {} : { unexpected }),
  });
  if (repository.kind === 'failed') {
    return [failed(repository)];
  }
  const { defaultBranch } = repository;
  return [
    ...(defaultBranch.read.kind === 'failed' && defaultBranch.event.kind === 'push'
      ? [{ ...failed(defaultBranch.read), defaultBranch: defaultBranch.event.branch }]
      : []),
    ...repository.pullRequestFailures.map((failure) => ({
      ...failed(failure),
      pullRequest: failure.number,
    })),
  ];
}

/**
 * The queue a snapshot yields: each lane that runs for its commit's event and has no verdict
 * there, except the runs in flight, once per commit and status name, plus each refused
 * declaration to report, once per commit, and each read that failed.
 */
export function deriveQueue(snapshot: Snapshot, inFlight: readonly RunInFlight[] = []): Queue {
  const yields = inRunOrder(snapshot).map((commit) => commitYield(commit, inFlight));
  return {
    candidates: firstByKey(
      yields.flatMap((each) => each.candidates),
      (candidate) => JSON.stringify([candidate.repository, candidate.commit, candidate.statusName]),
    ),
    declarationReports: firstByKey(
      yields.flatMap((each) => each.declarationReports),
      (report) => JSON.stringify([report.repository, report.commit]),
    ),
    failures: snapshot.flatMap(failuresOf),
  };
}
