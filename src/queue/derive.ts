/**
 * Derive the run queue from one poll's snapshot (ADR-0005, "Where the outcome belongs"). Pure:
 * the queue depends only on what was read and on the runs in flight, so a restart, which has
 * nothing in flight, derives the same queue again from GitHub's state.
 */
import type { CommitStatusState } from '../github/client';
import { DECLARATION_STATUS, laneStatusName, statusNameKey } from '../github/status-name';
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

/**
 * The status names on a commit that carry a verdict, by `statusNameKey`, so a verdict posted in
 * any case settles the name GitHub treats as the same context.
 */
function verdictsOf(statuses: CommitStatuses): ReadonlySet<string> {
  const latest = new Map<string, CommitStatusState>();
  for (const [name, state] of statuses) {
    const key = statusNameKey(name);
    if (!latest.has(key)) {
      latest.set(key, state);
    }
  }
  return new Set([...latest].flatMap(([key, state]) => (VERDICTS.has(state) ? [key] : [])));
}

/** The key that identifies one commit status: its repository, commit, and name. */
function statusKey(repository: string, commit: string, statusName: string): string {
  return JSON.stringify([repository, commit, statusNameKey(statusName)]);
}

/** What one commit adds to the queue. */
type CommitYield = {
  readonly candidates: Candidate[];
  readonly declarationReports: DeclarationReport[];
};

function commitYield(commit: CommitSnapshot, inFlight: ReadonlySet<string>): CommitYield {
  const result: CommitYield = { candidates: [], declarationReports: [] };
  const { read, repository } = commit;
  if (read.kind !== 'refused' && read.kind !== 'lanes') {
    return result;
  }
  // A hugi status with a verdict settles every lane without one; verdicts already posted stand.
  const verdicts = verdictsOf(read.statuses);
  if (verdicts.has(statusNameKey(DECLARATION_STATUS))) {
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
      !verdicts.has(statusNameKey(statusName)) &&
      !inFlight.has(statusKey(repository, commit.commit, statusName))
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

/** The first of each group of values with the same key, in order. */
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
 * there, except the runs in flight, plus each refused declaration to report, and each read that
 * failed. A commit status is identified by its repository, commit, and name, compared ignoring
 * case, so that is what settles, excludes, and deduplicates a lane, whatever its keys.
 *
 * Two snapshots can carry one commit: a pull request whose head is the default branch head, or
 * one branch opened as two pull requests. The commit's statuses are one, so the first snapshot in
 * run order, a default branch's, then the lowest pull request's, decides the commit wholly, its
 * candidates and its declaration report alike, and the later ones add nothing (ADR-0005).
 */
export function deriveQueue(snapshot: Snapshot, inFlight: readonly RunInFlight[] = []): Queue {
  const running = new Set(
    inFlight.map((run) => statusKey(run.repository, run.commit, run.statusName)),
  );
  const commits = firstByKey(inRunOrder(snapshot), (commit) =>
    JSON.stringify([commit.repository, commit.commit]),
  );
  const yields = commits.map((commit) => commitYield(commit, running));
  return {
    candidates: firstByKey(
      yields.flatMap((each) => each.candidates),
      (candidate) => statusKey(candidate.repository, candidate.commit, candidate.statusName),
    ),
    declarationReports: yields.flatMap((each) => each.declarationReports),
    failures: snapshot.flatMap(failuresOf),
  };
}
