/**
 * The coordinator loop behind `hugi serve`: poll, report refused declarations, run one candidate
 * at a time, and post each lane's status (README, "Running the coordinator"). The queue is derived
 * from GitHub's state at each poll; what the loop keeps between polls lives in memory only, so a
 * restart clears it: the waits after runs with no verdict, the verdicts it could not post, and
 * the failures it has logged. Every collaborator is injected, so the loop runs on a fake clock.
 */
import type { HugiConfig } from '../config/schema';
import { messageOf } from '../errors';
import { DECLARATION_STATUS, statusNameKey } from '../github/status-name';
import { StatusPostError } from '../github/statuses';
import type { LaneStatus, StatusReporter, StatusTarget } from '../github/statuses';
import type { LaneRef } from '../lane/step-plan';
import { deriveQueue } from '../queue/derive';
import type { Candidate, Queue, RepositoryFailure, RunInFlight, Snapshot } from '../queue/types';
import type { Clock } from '../vm/tart';
import type { CandidateOutcome, RunCandidate } from './run-candidate';

/** The first wait after a run with no verdict; it doubles after each further one. */
export const FIRST_WAIT_MS = 5 * 60_000;

/** The longest a lane waits after runs with no verdict. */
export const LONGEST_WAIT_MS = 60 * 60_000;

/** A lane the loop keeps state for: one commit status. */
export type LaneIdentity = Pick<Candidate, 'commit' | 'repository' | 'statusName'>;

/** How a run ended, as the service state records it. */
export type RunEnding =
  | 'passed'
  | 'failed'
  | 'no-verdict'
  | 'dropped'
  | 'declaration-refused'
  | 'error';

/** What the loop tells the service state. */
export type CoordinatorEvent =
  | {
      readonly kind: 'poll-ended';
      /** The reads the poll could not complete. */
      readonly failures: number;
      /** The candidates the poll queued. */
      readonly queued: number;
      /** Those of them that wait: after a run with no verdict, or to post their verdict. */
      readonly waiting: number;
    }
  /** Sent when a candidate is taken, and again with its run and VM ids once its VM is about to boot. */
  | (LaneIdentity & {
      readonly kind: 'run-started';
      readonly runId?: string;
      readonly vmId?: string;
    })
  | (LaneIdentity & { readonly kind: 'run-ended'; readonly ending: RunEnding });

export type CoordinatorLog = {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
};

export type CoordinatorDeps = {
  /** One poll of every enrolled repository (`pollRepositories` bound to its deps). */
  readonly poll: () => Promise<Snapshot>;
  readonly runCandidate: RunCandidate;
  readonly reporter: StatusReporter;
  /**
   * The clock the interval and the waits are measured on: monotonic in production, so a step of
   * the wall clock neither stalls polling nor cuts a wait short.
   */
  readonly clock: Clock;
  /** The wall clock, only to show in the log when a wait ends. */
  readonly now: () => Date;
  /** Aborts when the service is asked to stop; the run in flight is interrupted through its own wiring. */
  readonly signal: AbortSignal;
  readonly log: CoordinatorLog;
  /** Records the service state; a failure is logged and the loop goes on. */
  readonly report: (event: CoordinatorEvent) => void | Promise<void>;
};

export type CoordinatorConfig = Pick<HugiConfig, 'pollIntervalSeconds'>;

/** The key of one commit status: repository, commit, and name compared as GitHub compares them. */
export function laneKey(lane: LaneIdentity): string {
  return JSON.stringify([lane.repository, lane.commit, statusNameKey(lane.statusName)]);
}

/** A lane's wait after runs with no verdict: how many there were, and when it may run again. */
export type NoVerdictWait = { readonly runs: number; readonly until: number };

/** The wait after one more run with no verdict: 5 minutes, doubled for each earlier one, at most an hour. */
export function nextWait(previous: NoVerdictWait | undefined, now: number): NoVerdictWait {
  const runs = (previous?.runs ?? 0) + 1;
  return { runs, until: now + Math.min(FIRST_WAIT_MS * 2 ** (runs - 1), LONGEST_WAIT_MS) };
}

/** The first candidate, in queue order, that is not waiting. */
export function nextCandidate(
  pending: readonly Candidate[],
  waiting: (candidate: Candidate) => boolean,
): Candidate | undefined {
  return pending.find((candidate) => !waiting(candidate));
}

/** A failure as the log shows it. */
export type LoggedFailure = { readonly message: string; readonly unexpected: boolean };

/** A failed read's identity: what was read (repository, pull request, or branch) and why it failed. */
export function readFailureKey(failure: RepositoryFailure): string {
  return JSON.stringify([
    failure.repository,
    failure.pullRequest ?? null,
    failure.defaultBranch ?? null,
    failure.cause,
  ]);
}

function readFailureScope(failure: RepositoryFailure): string {
  if (failure.pullRequest !== undefined) {
    return `${failure.repository} pull request #${failure.pullRequest}`;
  }
  if (failure.defaultBranch !== undefined) {
    return `${failure.repository} branch ${failure.defaultBranch}`;
  }
  return failure.repository;
}

/** The failures that appeared since the last poll, and those that cleared. */
export function failureChanges(
  previous: ReadonlyMap<string, LoggedFailure>,
  current: ReadonlyMap<string, LoggedFailure>,
): { readonly appeared: LoggedFailure[]; readonly cleared: LoggedFailure[] } {
  return {
    appeared: [...current].filter(([key]) => !previous.has(key)).map(([, failure]) => failure),
    cleared: [...previous].filter(([key]) => !current.has(key)).map(([, failure]) => failure),
  };
}

/**
 * Whether the poll read the commit: some event of it read its declaration, or found the skip
 * instruction. A failed read, or a pull request with no current merge, learned nothing about it.
 */
export function readsCommit(snapshot: Snapshot, repository: string, commit: string): boolean {
  return snapshot.some(
    (each) =>
      each.kind === 'read' &&
      [each.defaultBranch, ...each.pullRequests].some(
        (read) =>
          read.repository === repository &&
          read.commit === commit &&
          read.read.kind !== 'failed' &&
          read.read.kind !== 'no-merge',
      ),
  );
}

/** Whether the poll read the lane's commit and no longer queues the lane. */
export function noLongerQueued(
  snapshot: Snapshot,
  candidates: readonly Candidate[],
  lane: LaneIdentity,
): boolean {
  const key = laneKey(lane);
  return (
    readsCommit(snapshot, lane.repository, lane.commit) &&
    !candidates.some((candidate) => laneKey(candidate) === key)
  );
}

/**
 * Whether the poll read the repository completely (its default branch head and every admitted
 * pull request's head) and the commit is none of those heads: the head moved on, or the pull
 * request closed. A repository or pull request that could not be read decides nothing.
 */
export function commitGone(snapshot: Snapshot, repository: string, commit: string): boolean {
  return snapshot.some(
    (each) =>
      each.kind === 'read' &&
      each.repository === repository &&
      each.pullRequestFailures.length === 0 &&
      ![each.defaultBranch, ...each.pullRequests].some((read) => read.commit === commit),
  );
}

/** Why the loop no longer keeps state for a lane, or `undefined` while it still does. */
export function whyForgotten(
  snapshot: Snapshot,
  candidates: readonly Candidate[],
  lane: LaneIdentity,
): string | undefined {
  if (noLongerQueued(snapshot, candidates, lane)) {
    return 'the lane is no longer a candidate';
  }
  if (commitGone(snapshot, lane.repository, lane.commit)) {
    return 'the commit is no longer a branch or pull request head';
  }
  return undefined;
}

/** A final status the loop could not post, kept to post again at each poll. */
type UnpostedVerdict = LaneIdentity & {
  readonly target: StatusTarget;
  readonly lane: LaneRef;
  readonly status: LaneStatus;
};

type Waiting = LaneIdentity & { readonly wait: NoVerdictWait };

const EMPTY_QUEUE: Queue = { candidates: [], declarationReports: [], failures: [] };

/** With one lane at a time, nothing is in flight when the loop polls. */
const NOTHING_IN_FLIGHT: readonly RunInFlight[] = [];

function describeLane(lane: LaneIdentity): string {
  return `${lane.statusName} on ${lane.repository}@${lane.commit.slice(0, 12)}`;
}

function endingOf(outcome: CandidateOutcome): RunEnding {
  if (outcome.kind !== 'finished') {
    return outcome.kind;
  }
  if (outcome.status === undefined) {
    return 'no-verdict';
  }
  return outcome.status.state === 'success' ? 'passed' : 'failed';
}

/**
 * Run the coordinator until `deps.signal` aborts. Polls start at least `pollIntervalSeconds`
 * apart. After each poll the loop posts the verdicts it could not post before and the refused
 * declarations, then runs the first candidate that is not waiting; until the interval has passed
 * since the poll started, it takes the next one from the same queue. It resolves once the signal
 * has aborted and the run in flight, if any, has ended.
 */
export async function runCoordinator(
  config: CoordinatorConfig,
  deps: CoordinatorDeps,
): Promise<void> {
  const intervalMs = config.pollIntervalSeconds * 1000;
  const { clock, log, reporter, signal } = deps;

  /** A time on `clock` as the wall clock would show it, for the log. */
  const wallTimeOf = (at: number) =>
    new Date(deps.now().getTime() + (at - clock.now())).toISOString();
  const waits = new Map<string, Waiting>();
  const unposted = new Map<string, UnpostedVerdict>();
  const postFailures = new Map<string, string>();
  let readFailures: ReadonlyMap<string, LoggedFailure> = new Map();

  const emit = async (event: CoordinatorEvent) => {
    try {
      await deps.report(event);
    } catch (error) {
      log.warn(`could not record the service state: ${messageOf(error)}`);
    }
  };

  /** Log a failure as a warning when Hugi expects it, and as an error when it does not. */
  const logFailure = (error: unknown, message: string) =>
    (error instanceof StatusPostError ? log.warn : log.error)(message);

  const isWaiting = (candidate: Candidate) => {
    const key = laneKey(candidate);
    return unposted.has(key) || (waits.get(key)?.wait.until ?? -Infinity) > clock.now();
  };

  /** Post a status; each distinct failure is logged once, and its clearing once. */
  const post = async (key: string, what: string, send: () => Promise<void>) => {
    try {
      await send();
    } catch (error) {
      const message = messageOf(error);
      if (postFailures.get(key) !== message) {
        postFailures.set(key, message);
        logFailure(error, `could not post ${what}: ${message}`);
      }
      return false;
    }
    if (postFailures.delete(key)) {
      log.info(`posted ${what}`);
    }
    return true;
  };

  const logReadFailures = (current: ReadonlyMap<string, LoggedFailure>) => {
    const { appeared, cleared } = failureChanges(readFailures, current);
    readFailures = current;
    for (const failure of appeared) {
      (failure.unexpected ? log.error : log.warn)(failure.message);
    }
    for (const failure of cleared) {
      log.info(`cleared: ${failure.message}`);
    }
  };

  /**
   * Read GitHub, log what changed among the failed reads, and derive the queue. `failures` counts
   * the reads that failed; a poll that threw read nothing, and counts as one.
   */
  const readQueue = async (): Promise<{ snapshot: Snapshot; queue: Queue; failures: number }> => {
    const current = new Map<string, LoggedFailure>();
    let snapshot: Snapshot = [];
    let queue = EMPTY_QUEUE;
    let threw = false;
    try {
      snapshot = await deps.poll();
      queue = deriveQueue(snapshot, NOTHING_IN_FLIGHT);
    } catch (error) {
      threw = true;
      current.set('poll', { message: `the poll failed: ${messageOf(error)}`, unexpected: true });
    }
    for (const failure of queue.failures) {
      current.set(readFailureKey(failure), {
        message: `cannot read ${readFailureScope(failure)}: ${failure.cause}`,
        unexpected: failure.unexpected === true,
      });
    }
    logReadFailures(current);
    return { failures: queue.failures.length + (threw ? 1 : 0), queue, snapshot };
  };

  /** Post each kept verdict again, or drop it once the poll shows the lane no longer needs it. */
  const retryUnposted = async (snapshot: Snapshot, candidates: readonly Candidate[]) => {
    const posted = new Set<string>();
    for (const [key, verdict] of unposted) {
      const forgotten = whyForgotten(snapshot, candidates, verdict);
      if (forgotten !== undefined) {
        unposted.delete(key);
        postFailures.delete(key);
        log.info(`dropped the unposted verdict of ${describeLane(verdict)}: ${forgotten}`);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one post at a time
      const sent = await post(
        key,
        `the ${verdict.status.state} status of ${describeLane(verdict)}`,
        () => reporter.reportLane(verdict.target, verdict.lane, verdict.status),
      );
      if (sent) {
        unposted.delete(key);
        posted.add(key);
      }
    }
    return posted;
  };

  /** Forget the waits of lanes the poll read and no longer queues, or whose commit is gone. */
  const pruneWaits = (snapshot: Snapshot, candidates: readonly Candidate[]) => {
    for (const [key, waiting] of waits) {
      if (whyForgotten(snapshot, candidates, waiting) !== undefined) {
        waits.delete(key);
      }
    }
  };

  const postRefusal = (target: StatusTarget, cause: string) =>
    post(
      laneKey({ ...target, commit: target.sha, statusName: DECLARATION_STATUS }),
      `the ${DECLARATION_STATUS} status on ${target.repository}@${target.sha.slice(0, 12)}`,
      () => reporter.reportRefusal(target, cause),
    );

  /** Steps 1 and 2: poll, post what is owed, and return the queue to run from. */
  const pollOnce = async (): Promise<Candidate[]> => {
    const { failures, queue, snapshot } = await readQueue();
    if (signal.aborted) {
      return [];
    }
    pruneWaits(snapshot, queue.candidates);
    const posted = await retryUnposted(snapshot, queue.candidates);
    for (const report of queue.declarationReports) {
      // oxlint-disable-next-line no-await-in-loop -- one post at a time
      await postRefusal({ repository: report.repository, sha: report.commit }, report.cause);
    }
    const candidates = queue.candidates.filter((candidate) => !posted.has(laneKey(candidate)));
    await emit({
      failures,
      kind: 'poll-ended',
      queued: candidates.length,
      waiting: candidates.filter(isWaiting).length,
    });
    return candidates;
  };

  const logWaiting = (pending: readonly Candidate[]) => {
    for (const candidate of pending.filter(isWaiting)) {
      const key = laneKey(candidate);
      const waiting = waits.get(key);
      log.info(
        unposted.has(key) || waiting === undefined
          ? `${describeLane(candidate)} waits to post its verdict`
          : `${describeLane(candidate)} waits until ${wallTimeOf(waiting.wait.until)} after ${waiting.wait.runs} runs with no verdict`,
      );
    }
  };

  const waitAfterNoVerdict = (candidate: Candidate, cause: string) => {
    const key = laneKey(candidate);
    const wait = nextWait(waits.get(key)?.wait, clock.now());
    const { commit, repository, statusName } = candidate;
    waits.set(key, { commit, repository, statusName, wait });
    log.info(
      `${describeLane(candidate)} has no verdict (${cause}); it runs again after ${wallTimeOf(wait.until)}`,
    );
  };

  /** Post what a run's outcome calls for and keep what the loop must remember. */
  const settle = async (candidate: Candidate, outcome: CandidateOutcome) => {
    const key = laneKey(candidate);
    if (outcome.kind === 'dropped') {
      log.info(`dropped ${describeLane(candidate)}: ${outcome.reason}`);
      return;
    }
    if (outcome.kind === 'declaration-refused') {
      log.info(
        `the merge refuses the lane declaration of ${describeLane(candidate)}: ${outcome.cause}`,
      );
      await postRefusal(outcome.target, outcome.cause);
      return;
    }
    const { lane, status, target } = outcome;
    if (status === undefined) {
      waitAfterNoVerdict(candidate, outcome.cause ?? 'no verdict');
      return;
    }
    waits.delete(key);
    log.info(`${describeLane(candidate)}: ${status.state}`);
    const sent = await post(key, `the ${status.state} status of ${describeLane(candidate)}`, () =>
      reporter.reportLane(target, lane, status),
    );
    if (!sent) {
      const { commit, repository, statusName } = candidate;
      unposted.set(key, { commit, lane, repository, status, statusName, target });
    }
  };

  /** Step 3: run one candidate and post its status. */
  const runOne = async (candidate: Candidate): Promise<CandidateOutcome | undefined> => {
    const { commit, repository, statusName } = candidate;
    const identity = { commit, repository, statusName };
    await emit({ kind: 'run-started', ...identity });
    let outcome: CandidateOutcome;
    try {
      outcome = await deps.runCandidate(candidate, {
        started: async (start) => {
          await emit({ kind: 'run-started', ...identity, runId: start.runId, vmId: start.vmId });
          try {
            await reporter.reportLane(start.target, start.lane, {
              runId: start.runId,
              state: 'pending',
            });
          } catch (error) {
            logFailure(
              error,
              `could not post the pending status of ${describeLane(candidate)}; the run goes ahead: ${messageOf(error)}`,
            );
          }
        },
      });
    } catch (error) {
      log.error(`the run of ${describeLane(candidate)} failed unexpectedly: ${messageOf(error)}`);
      waitAfterNoVerdict(candidate, 'the run failed unexpectedly');
      await emit({ ending: 'error', kind: 'run-ended', ...identity });
      return undefined;
    }
    await settle(candidate, outcome);
    await emit({ ending: endingOf(outcome), kind: 'run-ended', ...identity });
    return outcome;
  };

  /** Steps 3 and 4: run the queue's candidates until the interval has passed since the poll. */
  const runQueue = async (polledAt: number, queue: readonly Candidate[]) => {
    let pending = queue;
    do {
      const candidate = nextCandidate(pending, isWaiting);
      if (candidate === undefined) {
        return;
      }
      pending = pending.filter((each) => each !== candidate);
      logWaiting(pending);
      // oxlint-disable-next-line no-await-in-loop -- one lane at a time
      const outcome = await runOne(candidate);
      if (outcome?.kind === 'declaration-refused') {
        // The refusal settles every lane of the commit that has no verdict (ADR-0005).
        pending = pending.filter(
          (each) => each.repository !== candidate.repository || each.commit !== candidate.commit,
        );
      }
    } while (!signal.aborted && clock.now() - polledAt < intervalMs);
  };

  let polledAt: number | undefined;
  while (!signal.aborted) {
    if (polledAt !== undefined) {
      const due = polledAt + intervalMs - clock.now();
      if (due > 0) {
        // oxlint-disable-next-line no-await-in-loop -- the loop waits for its next poll
        await clock.sleep(due, signal);
      }
      if (signal.aborted) {
        return;
      }
    }
    polledAt = clock.now();
    // oxlint-disable-next-line no-await-in-loop -- one poll at a time
    const queue = await pollOnce();
    if (signal.aborted) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- one queue at a time
    await runQueue(polledAt, queue);
  }
}
