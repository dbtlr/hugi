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
 * any case settles the name GitHub treats as the same context. A name is settled when any of its
 * entries carries a verdict, whatever order GitHub lists its case variants in.
 */
function verdictsOf(statuses: CommitStatuses): ReadonlySet<string> {
  const settled = new Set<string>();
  for (const [name, state] of statuses) {
    if (VERDICTS.has(state)) {
      settled.add(statusNameKey(name));
    }
  }
  return settled;
}

/** The key that identifies one commit status: its repository, commit, and name. */
function statusKey(repository: string, commit: string, statusName: string): string {
  return JSON.stringify([repository, commit, statusNameKey(statusName)]);
}

/** Whether the commit's hugi status carries a verdict, which settles every lane without one. */
function declarationSettled(statuses: CommitStatuses): boolean {
  return verdictsOf(statuses).has(statusNameKey(DECLARATION_STATUS));
}

/** The refused declaration to report for a commit, unless a verdict already settles it. */
function declarationReports(commit: CommitSnapshot): DeclarationReport[] {
  const { read } = commit;
  if (read.kind !== 'refused' || declarationSettled(read.statuses)) {
    return [];
  }
  return [{ cause: read.cause, commit: commit.commit, repository: commit.repository }];
}

/** The snapshot's lanes that run and have neither a verdict nor a run in flight. */
function laneCandidates(commit: CommitSnapshot, inFlight: ReadonlySet<string>): Candidate[] {
  const { read, repository } = commit;
  // A hugi status with a verdict settles every lane without one; verdicts already posted stand.
  if (read.kind !== 'lanes' || declarationSettled(read.statuses)) {
    return [];
  }
  const verdicts = verdictsOf(read.statuses);
  return read.lanes.flatMap((decision) => {
    const { lane } = decision;
    const statusName = laneStatusName(lane);
    const runs =
      decision.kind === 'runs' &&
      !verdicts.has(statusNameKey(statusName)) &&
      !inFlight.has(statusKey(repository, commit.commit, statusName));
    return runs
      ? [{ commit: commit.commit, event: commit.event, lane, repository, statusName }]
      : [];
  });
}

/**
 * Whether the snapshot read its commit and so takes part in deciding it. A read that failed, or a
 * pull request with no current merge, learned nothing about the commit, so it leaves the commit to
 * the snapshots that read it.
 */
function decides(commit: CommitSnapshot): boolean {
  return commit.read.kind !== 'failed' && commit.read.kind !== 'no-merge';
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

/** The key that identifies one commit: its repository and sha. */
function commitKey(commit: CommitSnapshot): string {
  return JSON.stringify([commit.repository, commit.commit]);
}

/**
 * The queue a snapshot yields: each lane that runs for its commit's event and has no verdict
 * there, except the runs in flight, plus each refused declaration to report, and each read that
 * failed. A commit status is identified by its repository, commit, and name, compared ignoring
 * case, so that is what settles, excludes, and deduplicates a lane, whatever its keys.
 *
 * Two snapshots can carry one commit: a pull request whose head is the default branch head, or
 * one branch opened as two pull requests. The commit's statuses are one, but each event selects
 * its own lanes, so each lane is decided, not the commit (ADR-0005). Of the snapshots that read
 * the commit, the first in run order, a default branch's, then the lowest pull request's, decides
 * whether the commit is refused: if it is, the commit yields its one declaration report and no
 * candidates; if it carries a skip instruction, which every snapshot of the commit shares, the
 * commit yields nothing. Otherwise every snapshot that reads lanes adds its candidates in run
 * order, and a lane two of them select runs once, for the first; a later snapshot that refuses
 * the declaration adds nothing. A snapshot whose read failed or found no current merge read
 * nothing, so it decides nothing: a conflicted pull request does not hold back another that
 * shares its head.
 */
export function deriveQueue(snapshot: Snapshot, inFlight: readonly RunInFlight[] = []): Queue {
  const running = new Set(
    inFlight.map((run) => statusKey(run.repository, run.commit, run.statusName)),
  );
  const reads = inRunOrder(snapshot).filter(decides);
  const firsts = new Map<string, CommitSnapshot>();
  for (const commit of reads) {
    if (!firsts.has(commitKey(commit))) {
      firsts.set(commitKey(commit), commit);
    }
  }
  const candidates: Candidate[] = [];
  const reports: DeclarationReport[] = [];
  for (const commit of reads) {
    const first = firsts.get(commitKey(commit));
    if (first === commit) {
      reports.push(...declarationReports(commit));
    }
    const kind = first?.read.kind;
    if (kind !== 'refused' && kind !== 'skipped') {
      candidates.push(...laneCandidates(commit, running));
    }
  }
  return {
    candidates: firstByKey(candidates, (candidate) =>
      statusKey(candidate.repository, candidate.commit, candidate.statusName),
    ),
    declarationReports: reports,
    failures: snapshot.flatMap(failuresOf),
  };
}
