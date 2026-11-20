import { describe, expect, spyOn, test } from 'bun:test';

import type { CommitStatusState } from '../github/client';
import { StatusPostError } from '../github/statuses';
import type { LaneStatus, StatusReporter, StatusTarget } from '../github/statuses';
import type { LaneRef } from '../lane/step-plan';
import type {
  Candidate,
  CommitRead,
  CommitSnapshot,
  RepositoryFailure,
  RepositorySnapshot,
  Snapshot,
} from '../queue/types';
import { systemClock } from '../vm/clock';
import {
  failureChanges,
  FIRST_WAIT_MS,
  laneKey,
  LONGEST_WAIT_MS,
  nextCandidate,
  nextWait,
  noLongerQueued,
  readFailureKey,
  runCoordinator,
} from './loop';
import type { CoordinatorEvent } from './loop';
import type { CandidateHooks, CandidateOutcome } from './run-candidate';

const REPOSITORY = 'example/project';
const CI = '.github/workflows/ci.yml';
const MINUTE = 60_000;
const INTERVAL_MS = MINUTE;
const sha = (digit: string) => digit.repeat(40);
const HEAD = sha('a');
const PR_HEAD = sha('b');
const MERGE = sha('d');
const RUN_ID = '2026-11-20T100000Z-aaaaaaaaa-Abc123';
/** The wall time when the fake clock reads 0. */
const WALL_ORIGIN = Date.parse('2026-11-20T10:00:00.000Z');

const laneOf = (job: string): LaneRef => ({ job, matrix: {}, workflow: CI });
const nameOf = (job: string) => `hugi / ${job}`;

function lanesRead(jobs: string[], statuses: Record<string, CommitStatusState> = {}): CommitRead {
  return {
    kind: 'lanes',
    lanes: jobs.map((job) => ({ kind: 'runs', lane: { ...laneOf(job), tools: 'workflow' } })),
    statuses: new Map(Object.entries(statuses)),
  };
}

function pushAt(read: CommitRead, commit = HEAD): CommitSnapshot {
  return { commit, event: { branch: 'main', kind: 'push' }, read, repository: REPOSITORY };
}

function pullAt(read: CommitRead, commit = PR_HEAD): CommitSnapshot {
  const pullRequest = { baseRef: 'main', headRef: 'feature', headSha: commit, number: 7 };
  return { commit, event: { kind: 'pull_request', pullRequest }, read, repository: REPOSITORY };
}

function repository(
  defaultBranch: CommitSnapshot,
  pullRequests: CommitSnapshot[] = [],
): RepositorySnapshot {
  return {
    defaultBranch,
    kind: 'read',
    pullRequestFailures: [],
    pullRequests,
    repository: REPOSITORY,
  };
}

/** One poll that read the default branch head with these lanes and statuses. */
const pushPoll = (jobs: string[], statuses?: Record<string, CommitStatusState>): Snapshot => [
  repository(pushAt(lanesRead(jobs, statuses))),
];

const failedPoll = (cause = 'GitHub answered 502', unexpected = false): Snapshot => [
  {
    cause,
    kind: 'failed',
    repository: REPOSITORY,
    ...(unexpected ? { unexpected: true as const } : {}),
  },
];

type Post =
  | { kind: 'lane'; target: StatusTarget; lane: LaneRef; status: LaneStatus }
  | {
      kind: 'refusal';
      target: StatusTarget;
      cause: string;
    };

type Run = (candidate: Candidate, hooks: CandidateHooks) => Promise<CandidateOutcome>;

type Setup = {
  /** The polls in order; once they are used up the loop is stopped. */
  readonly polls: (Snapshot | (() => Snapshot))[];
  /** How each candidate's run ends, by job; a passing run with a run id by default. */
  readonly runs?: Record<string, Run>;
  /** How long a run takes on the fake clock. */
  readonly runMs?: number;
  /** How long a poll takes on the fake clock. */
  readonly pollMs?: number;
  /** Whether a post fails, by attempt. */
  readonly failPost?: (post: Post, attempt: number) => Error | undefined;
};

const passing =
  (job: string): Run =>
  async (candidate, hooks) => {
    const target = { repository: candidate.repository, sha: candidate.commit };
    await hooks.started({ lane: laneOf(job), runId: RUN_ID, target, vmId: 'vm1' });
    return {
      kind: 'finished',
      lane: laneOf(job),
      status: { runId: RUN_ID, state: 'success' },
      target,
    };
  };

const noVerdict: Run = async (candidate) => ({
  cause: 'the VM failed to boot',
  kind: 'finished',
  lane: candidate.lane,
  status: undefined,
  target: { repository: candidate.repository, sha: candidate.commit },
});

const dropped: Run = async () => ({ kind: 'dropped', reason: 'the head moved' });

const postError = (status = 502) =>
  new StatusPostError(REPOSITORY, 'POST /repos/example/project/statuses/x', 'GitHub answered 502', {
    status,
  });

async function coordinate(setup: Setup) {
  const controller = new AbortController();
  let now = 0;
  const timeline: string[] = [];
  const pollStarts: number[] = [];
  const runs: { job: string; at: number }[] = [];
  const posts: Post[] = [];
  const logs: { level: 'info' | 'warn' | 'error'; message: string }[] = [];
  const events: CoordinatorEvent[] = [];
  let pollIndex = 0;
  let attempt = 0;
  const record = (post: Post) => {
    attempt += 1;
    posts.push(post);
    timeline.push(
      post.kind === 'lane' ? `post ${post.status.state} ${post.lane.job}` : 'post hugi',
    );
    const error = setup.failPost?.(post, attempt);
    if (error !== undefined) {
      throw error;
    }
  };
  const reporter: StatusReporter = {
    reportLane: async (target, lane, status) => record({ kind: 'lane', lane, status, target }),
    reportRefusal: async (target, cause) => record({ cause, kind: 'refusal', target }),
  };
  await runCoordinator(
    { pollIntervalSeconds: INTERVAL_MS / 1000 },
    {
      clock: {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
          return true;
        },
      },
      log: {
        error: (message) => logs.push({ level: 'error', message }),
        info: (message) => logs.push({ level: 'info', message }),
        warn: (message) => logs.push({ level: 'warn', message }),
      },
      now: () => new Date(WALL_ORIGIN + now),
      poll: async () => {
        pollStarts.push(now);
        timeline.push('poll');
        const next = setup.polls[pollIndex];
        pollIndex += 1;
        now += setup.pollMs ?? 0;
        if (next === undefined) {
          controller.abort();
          return [];
        }
        return typeof next === 'function' ? next() : next;
      },
      report: (event) => {
        events.push(event);
      },
      reporter,
      runCandidate: async (candidate, hooks) => {
        const job = candidate.lane.job;
        runs.push({ at: now, job });
        timeline.push(`run ${job}`);
        const outcome = await (setup.runs?.[job] ?? passing(job))(candidate, hooks);
        now += setup.runMs ?? 0;
        return outcome;
      },
      signal: controller.signal,
    },
  );
  const logged = (level: 'info' | 'warn' | 'error') =>
    logs.filter((each) => each.level === level).map((each) => each.message);
  return { events, logged, pollStarts, posts, runs, timeline };
}

const finalPostsOf = (posts: Post[]) =>
  posts.filter((post) => post.kind === 'lane' && post.status.state === 'success');

const candidateOf = (job: string): Candidate => ({
  commit: HEAD,
  event: { branch: 'main', kind: 'push' },
  lane: { ...laneOf(job), tools: 'workflow' },
  repository: REPOSITORY,
  statusName: nameOf(job),
});

describe('cadence', () => {
  test('polls start poll_interval apart', async () => {
    const { pollStarts } = await coordinate({ polls: [[], [], []] });
    expect(pollStarts).toEqual([0, INTERVAL_MS, 2 * INTERVAL_MS, 3 * INTERVAL_MS]);
  });

  test('a run that outlasts the interval is followed by a poll at once', async () => {
    const { pollStarts } = await coordinate({ polls: [pushPoll(['build']), []], runMs: 90_000 });
    expect(pollStarts).toEqual([0, 90_000, 90_000 + INTERVAL_MS]);
  });

  test("until the interval has passed, the next candidate comes from the last poll's queue", async () => {
    const { timeline } = await coordinate({
      polls: [pushPoll(['build', 'test', 'lint'])],
      runMs: 20_000,
    });
    expect(timeline.filter((each) => each === 'poll' || each.startsWith('run'))).toEqual([
      'poll',
      'run build',
      'run test',
      'run lint',
      'poll',
    ]);
  });

  test('once the interval has passed, the loop polls again before the next candidate', async () => {
    const { timeline } = await coordinate({
      polls: [pushPoll(['build', 'test']), pushPoll(['test'])],
      runMs: 70_000,
    });
    expect(timeline.filter((each) => each === 'poll' || each.startsWith('run'))).toEqual([
      'poll',
      'run build',
      'poll',
      'run test',
      'poll',
    ]);
  });

  test('the first candidate runs even when the poll took longer than the interval', async () => {
    const { runs } = await coordinate({ pollMs: 2 * INTERVAL_MS, polls: [pushPoll(['build'])] });
    expect(runs.map((each) => each.job)).toEqual(['build']);
  });
});

describe('a run with no verdict', () => {
  test('waits 5 minutes, doubling after each further run, up to an hour', () => {
    const waits: number[] = [];
    let wait;
    for (let run = 0; run < 6; run += 1) {
      wait = nextWait(wait, 1000);
      waits.push(wait.until - 1000);
    }
    expect(waits).toEqual([
      FIRST_WAIT_MS,
      2 * FIRST_WAIT_MS,
      4 * FIRST_WAIT_MS,
      8 * FIRST_WAIT_MS,
      LONGEST_WAIT_MS,
      LONGEST_WAIT_MS,
    ]);
  });

  test('makes the lane wait while the others run', async () => {
    const polls = Array.from({ length: 16 }, () => pushPoll(['build', 'test']));
    const { runs } = await coordinate({ polls, runs: { build: noVerdict } });
    expect(runs.filter((each) => each.job === 'build').map((each) => each.at)).toEqual([
      0,
      5 * MINUTE,
      15 * MINUTE,
    ]);
    expect(runs.filter((each) => each.job === 'test')).toHaveLength(16);
  });

  test('posts no final status', async () => {
    const { posts } = await coordinate({
      polls: [pushPoll(['build'])],
      runs: { build: noVerdict },
    });
    expect(posts).toEqual([]);
  });

  test('a run that throws is logged as an error and the lane waits', async () => {
    const { logged, runs } = await coordinate({
      polls: [pushPoll(['build']), pushPoll(['build'])],
      runs: {
        build: async () => {
          throw new TypeError('a bug');
        },
      },
    });
    expect(runs).toHaveLength(1);
    expect(logged('error')).toEqual([expect.stringContaining('a bug')]);
  });
});

test('a lane that stays waiting is logged at each run', async () => {
  const polls = Array.from({ length: 3 }, () => pushPoll(['build', 'test']));
  const { logged } = await coordinate({ polls, runs: { build: noVerdict } });
  const waiting = logged('info').filter(
    (message) => message.startsWith('hugi / build on') && message.includes('waits until'),
  );
  expect(waiting).toHaveLength(2);
  // The wait ends 5 minutes after the run, as the wall clock shows it.
  expect(waiting[0]).toContain('waits until 2026-11-20T10:05:00.000Z after 1 runs');
});

test('a dropped candidate posts nothing and runs again at the next poll', async () => {
  const { posts, runs } = await coordinate({
    polls: [pushPoll(['build']), pushPoll(['build'])],
    runs: { build: dropped },
  });
  expect(posts).toEqual([]);
  expect(runs).toHaveLength(2);
});

describe('posting', () => {
  test('a run posts pending with its run id when its VM is about to boot, then its verdict', async () => {
    const { posts } = await coordinate({ polls: [pushPoll(['build'])] });
    expect(posts.map((post) => post.kind === 'lane' && post.status)).toEqual([
      { runId: RUN_ID, state: 'pending' },
      { runId: RUN_ID, state: 'success' },
    ]);
    expect(posts[1]).toMatchObject({
      lane: laneOf('build'),
      target: { repository: REPOSITORY, sha: HEAD },
    });
  });

  test('a pending status that cannot be posted is logged, and the run goes ahead', async () => {
    const { logged, posts } = await coordinate({
      failPost: (post) =>
        post.kind === 'lane' && post.status.state === 'pending' ? postError() : undefined,
      polls: [pushPoll(['build'])],
    });
    expect(posts.at(-1)).toMatchObject({ status: { state: 'success' } });
    expect(logged('warn')).toEqual([expect.stringContaining('pending')]);
  });

  test('a refused declaration is posted on its commit', async () => {
    const refused: CommitRead = {
      cause: 'lanes[0] names no job',
      kind: 'refused',
      statuses: new Map(),
    };
    const { posts } = await coordinate({ polls: [[repository(pushAt(refused))]] });
    expect(posts).toEqual([
      {
        cause: 'lanes[0] names no job',
        kind: 'refusal',
        target: { repository: REPOSITORY, sha: HEAD },
      },
    ]);
  });

  test("a declaration the merge refuses is posted, and the commit's other lanes do not run", async () => {
    const refused: Run = async (candidate) => ({
      cause: 'the base declares a missing job',
      kind: 'declaration-refused',
      target: { mergeSha: MERGE, repository: REPOSITORY, sha: candidate.commit },
    });
    const { posts, runs } = await coordinate({
      polls: [[repository(pushAt(lanesRead([])), [pullAt(lanesRead(['build', 'test']))])]],
      runs: { build: refused },
    });
    expect(runs.map((each) => each.job)).toEqual(['build']);
    expect(posts).toEqual([
      {
        cause: 'the base declares a missing job',
        kind: 'refusal',
        target: { mergeSha: MERGE, repository: REPOSITORY, sha: PR_HEAD },
      },
    ]);
  });
});

describe('an unposted verdict', () => {
  test('is posted again at each poll instead of running the lane again, and logged once', async () => {
    const { logged, posts, runs } = await coordinate({
      // The pending post is attempt 1; the final post and its first retry fail.
      failPost: (post, attempt) =>
        attempt <= 3 && post.kind === 'lane' && post.status.state === 'success'
          ? postError()
          : undefined,
      polls: [
        pushPoll(['build']),
        pushPoll(['build']),
        pushPoll(['build']),
        pushPoll(['build'], { 'hugi / build': 'success' }),
      ],
    });
    expect(runs).toHaveLength(1);
    expect(finalPostsOf(posts)).toHaveLength(3);
    expect(logged('warn')).toHaveLength(1);
    expect(logged('info')).toContain(
      `posted the success status of hugi / build on ${REPOSITORY}@${HEAD.slice(0, 12)}`,
    );
  });

  test('is dropped once a poll reads its commit and no longer finds the lane', async () => {
    const { posts } = await coordinate({
      failPost: (post) =>
        post.kind === 'lane' && post.status.state === 'success' ? postError() : undefined,
      polls: [
        pushPoll(['build']),
        pushPoll(['build'], { 'hugi / build': 'failure' }),
        pushPoll(['build'], { 'hugi / build': 'failure' }),
      ],
    });
    expect(finalPostsOf(posts)).toHaveLength(1);
  });

  test('is kept, and posted again, while the poll fails to read its commit', async () => {
    const failedHead = pushAt({ cause: 'git fetch timed out', kind: 'failed' });
    const { posts, runs } = await coordinate({
      failPost: (post, attempt) =>
        attempt <= 4 && post.kind === 'lane' && post.status.state === 'success'
          ? postError()
          : undefined,
      polls: [pushPoll(['build']), failedPoll(), [repository(failedHead)], pushPoll(['build'])],
    });
    // The final post and its retries at the two polls that cannot read the commit fail; the
    // fourth poll's retry posts it.
    expect(finalPostsOf(posts)).toHaveLength(4);
    expect(runs).toHaveLength(1);
  });

  test('makes its lane wait', async () => {
    const { events } = await coordinate({
      failPost: (post) =>
        post.kind === 'lane' && post.status.state === 'success' ? postError() : undefined,
      polls: [pushPoll(['build']), pushPoll(['build'])],
    });
    expect(events.filter((event) => event.kind === 'poll-ended')).toEqual([
      { failures: 0, kind: 'poll-ended', queued: 1, waiting: 0 },
      { failures: 0, kind: 'poll-ended', queued: 1, waiting: 1 },
    ]);
  });
});

describe('read failures', () => {
  test('are logged once while they last, and again when they clear', async () => {
    const { logged } = await coordinate({
      polls: [failedPoll(), failedPoll(), pushPoll([]), pushPoll([])],
    });
    expect(logged('warn')).toEqual([`cannot read ${REPOSITORY}: GitHub answered 502`]);
    expect(logged('info')).toEqual([`cleared: cannot read ${REPOSITORY}: GitHub answered 502`]);
  });

  test('an unexpected failure is logged as an error', async () => {
    const { logged } = await coordinate({ polls: [failedPoll('a bug', true)] });
    expect(logged('error')).toEqual([`cannot read ${REPOSITORY}: a bug`]);
    expect(logged('warn')).toEqual([]);
  });

  test('a poll that rejects is logged as an error once, and the loop goes on', async () => {
    const { logged, runs } = await coordinate({
      polls: [
        () => {
          throw new Error('a bug');
        },
        () => {
          throw new Error('a bug');
        },
        pushPoll(['build']),
      ],
    });
    expect(logged('error')).toEqual(['the poll failed: a bug']);
    expect(runs).toHaveLength(1);
  });

  test('a poll that rejects counts as a failed read in the poll-ended event', async () => {
    const { events } = await coordinate({
      polls: [
        () => {
          throw new Error('a bug');
        },
      ],
    });
    expect(events[0]).toEqual({ failures: 1, kind: 'poll-ended', queued: 0, waiting: 0 });
  });

  test('are counted in the poll-ended event', async () => {
    const { events } = await coordinate({ polls: [failedPoll()] });
    expect(events[0]).toEqual({ failures: 1, kind: 'poll-ended', queued: 0, waiting: 0 });
  });
});

test('a run is reported as started, with its run and VM ids once known, and as ended', async () => {
  const { events } = await coordinate({ polls: [pushPoll(['build'])] });
  const lane = { commit: HEAD, repository: REPOSITORY, statusName: nameOf('build') };
  expect(events.filter((event) => event.kind !== 'poll-ended')).toEqual([
    { kind: 'run-started', ...lane },
    { kind: 'run-started', ...lane, runId: RUN_ID, vmId: 'vm1' },
    { ending: 'passed', kind: 'run-ended', ...lane },
  ]);
});

test('stopping takes no more work and ends once the run in flight has ended', async () => {
  const controller = new AbortController();
  const { promise: inFlight, resolve: release } = Promise.withResolvers<void>();
  const started: string[] = [];
  const order: string[] = [];
  const reporter: StatusReporter = { reportLane: async () => {}, reportRefusal: async () => {} };
  const coordinator = (async () => {
    await runCoordinator(
      { pollIntervalSeconds: 60 },
      {
        clock: { now: () => 0, sleep: async () => true },
        log: { error: () => {}, info: () => {}, warn: () => {} },
        now: () => new Date(),
        poll: async () => pushPoll(['build', 'test']),
        report: () => {},
        reporter,
        runCandidate: async (each) => {
          started.push(each.lane.job);
          controller.abort();
          await inFlight;
          return noVerdict(each, { started: async () => {} });
        },
        signal: controller.signal,
      },
    );
    order.push('stopped');
  })();
  await Bun.sleep(5);
  order.push('run ended');
  release();
  await coordinator;
  expect(order).toEqual(['run ended', 'stopped']);
  expect(started).toEqual(['build']);
});

test('a backward step of the wall clock does not change the poll cadence', async () => {
  const controller = new AbortController();
  // The longest the test waits: three polls 50 ms apart take well under this.
  const giveUp = setTimeout(() => controller.abort(), 2000);
  const wall = Date.now;
  const stepped = spyOn(Date, 'now');
  const starts: number[] = [];
  const reporter: StatusReporter = { reportLane: async () => {}, reportRefusal: async () => {} };
  try {
    await runCoordinator(
      { pollIntervalSeconds: 0.05 },
      {
        clock: systemClock,
        log: { error: () => {}, info: () => {}, warn: () => {} },
        now: () => new Date(Date.now()),
        poll: async () => {
          starts.push(performance.now());
          if (starts.length === 1) {
            const back = wall() - 2 * 60 * MINUTE;
            stepped.mockReturnValue(back);
          }
          if (starts.length === 3) {
            controller.abort();
          }
          return [];
        },
        report: () => {},
        reporter,
        runCandidate: async (candidate) => noVerdict(candidate, { started: async () => {} }),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(giveUp);
    stepped.mockRestore();
  }
  expect(starts).toHaveLength(3);
  expect((starts[2] ?? 0) - (starts[0] ?? 0)).toBeLessThan(1000);
});

describe('decisions', () => {
  test('the next candidate is the first in queue order that is not waiting', () => {
    const queue = [candidateOf('build'), candidateOf('test'), candidateOf('lint')];
    expect(nextCandidate(queue, (each) => each.lane.job === 'build')?.lane.job).toBe('test');
    expect(nextCandidate(queue, () => true)).toBeUndefined();
  });

  test('a lane is keyed by its repository, commit, and status name as GitHub compares it', () => {
    const lane = { commit: HEAD, repository: REPOSITORY, statusName: 'hugi / Build' };
    expect(laneKey(lane)).toBe(laneKey({ ...lane, statusName: 'hugi / build' }));
    expect(laneKey(lane)).not.toBe(laneKey({ ...lane, commit: PR_HEAD }));
  });

  test('a failed read is one failure per scope and cause', () => {
    const failure: RepositoryFailure = {
      cause: 'timed out',
      pullRequest: 7,
      repository: REPOSITORY,
    };
    expect(readFailureKey(failure)).toBe(readFailureKey({ ...failure }));
    expect(readFailureKey(failure)).not.toBe(readFailureKey({ ...failure, pullRequest: 8 }));
    expect(readFailureKey(failure)).not.toBe(readFailureKey({ ...failure, cause: 'refused' }));
    expect(readFailureKey(failure)).not.toBe(
      readFailureKey({ cause: 'timed out', defaultBranch: 'main', repository: REPOSITORY }),
    );
  });

  test('failure changes are the failures that appeared and those that cleared', () => {
    const one = { message: 'one', unexpected: false };
    const two = { message: 'two', unexpected: true };
    expect(failureChanges(new Map([['1', one]]), new Map([['2', two]]))).toEqual({
      appeared: [two],
      cleared: [one],
    });
    expect(failureChanges(new Map([['1', one]]), new Map([['1', one]]))).toEqual({
      appeared: [],
      cleared: [],
    });
  });

  test('a lane is no longer queued only when the poll read its commit and left it out', () => {
    const lane = { commit: PR_HEAD, repository: REPOSITORY, statusName: nameOf('build') };
    const read = [repository(pushAt(lanesRead([])), [pullAt(lanesRead([]))])];
    expect(noLongerQueued(read, [], lane)).toBe(true);
    expect(noLongerQueued(read, [{ ...candidateOf('build'), commit: PR_HEAD }], lane)).toBe(false);
    const noMerge = [
      repository(pushAt(lanesRead([])), [pullAt({ cause: 'conflict', kind: 'no-merge' })]),
    ];
    expect(noLongerQueued(noMerge, [], lane)).toBe(false);
    expect(noLongerQueued(failedPoll(), [], lane)).toBe(false);
    expect(noLongerQueued([repository(pushAt(lanesRead([])))], [], lane)).toBe(false);
  });
});
