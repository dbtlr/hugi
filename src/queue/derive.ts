/**
 * Derive the run queue from one poll's snapshot (ADR-0005, "Where the outcome belongs"). Pure:
 * the queue depends only on what was read and on the run in flight, so a restart, which has
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
  RefusedTrigger,
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

function isInFlight(commit: CommitSnapshot, lane: LaneRef, inFlight: RunInFlight | undefined) {
  return (
    inFlight !== undefined &&
    inFlight.repository === commit.repository &&
    inFlight.commit === commit.commit &&
    sameLane(inFlight.lane, lane)
  );
}

/** What one commit adds to the queue. */
type CommitYield = {
  readonly candidates: Candidate[];
  readonly declarationReports: DeclarationReport[];
  readonly refusedTriggers: RefusedTrigger[];
};

function commitYield(commit: CommitSnapshot, inFlight: RunInFlight | undefined): CommitYield {
  const result: CommitYield = { candidates: [], declarationReports: [], refusedTriggers: [] };
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
    if (decision.kind === 'refused-trigger') {
      result.refusedTriggers.push({
        cause: decision.cause,
        commit: commit.commit,
        lane,
        repository,
      });
      continue;
    }
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
 * The queue a snapshot yields: each lane that runs for its commit's event and has no verdict
 * there, except the run in flight, plus each refused declaration to report and each repository
 * whose reads failed.
 */
export function deriveQueue(snapshot: Snapshot, inFlight?: RunInFlight): Queue {
  const yields = inRunOrder(snapshot).map((commit) => commitYield(commit, inFlight));
  return {
    candidates: yields.flatMap((each) => each.candidates),
    declarationReports: yields.flatMap((each) => each.declarationReports),
    failures: snapshot.flatMap((repository) =>
      repository.kind === 'failed'
        ? [{ cause: repository.cause, repository: repository.repository }]
        : [],
    ),
    refusedTriggers: yields.flatMap((each) => each.refusedTriggers),
  };
}
