import { describe, expect, test } from 'bun:test';

import type { CommitStatusState } from '../github/client';
import { laneStatusName } from '../github/status-name';
import type { LaneRef } from '../lane/step-plan';
import { deriveQueue } from './derive';
import type { CommitRead, CommitSnapshot, RepositorySnapshot } from './types';

const CI = '.github/workflows/ci.yml';
const PLATFORM: LaneRef = { job: 'platform', matrix: {}, workflow: CI };
const TEST_MAC: LaneRef = { job: 'test', matrix: { os: 'macos-latest' }, workflow: CI };

const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

function statuses(states: Record<string, CommitStatusState> = {}) {
  return new Map(Object.entries(states));
}

function lanes(states: Record<string, CommitStatusState> = {}, ...refs: LaneRef[]): CommitRead {
  const declared = refs.length === 0 ? [PLATFORM, TEST_MAC] : refs;
  return {
    kind: 'lanes',
    lanes: declared.map((lane) => ({ kind: 'runs', lane })),
    statuses: statuses(states),
  };
}

function push(repository: string, read: CommitRead, commit = MAIN): CommitSnapshot {
  return { commit, event: { branch: 'main', kind: 'push' }, read, repository };
}

function pull(repository: string, number: number, read: CommitRead, commit = HEAD): CommitSnapshot {
  return {
    commit,
    event: {
      kind: 'pull_request',
      pullRequest: { baseRef: 'main', headRef: `feature-${number}`, headSha: commit, number },
    },
    read,
    repository,
  };
}

function repo(
  repository: string,
  defaultBranch: CommitRead,
  ...pullRequests: CommitSnapshot[]
): RepositorySnapshot {
  return {
    defaultBranch: push(repository, defaultBranch),
    kind: 'read',
    pullRequestFailures: [],
    pullRequests,
    repository,
  };
}

const NOTHING: CommitRead = { kind: 'no-declaration' };

/** Each candidate as `repository@commit-prefix status-name`, in queue order. */
function names(snapshot: RepositorySnapshot[], inFlight?: Parameters<typeof deriveQueue>[1]) {
  return deriveQueue(snapshot, inFlight).candidates.map(
    (candidate) =>
      `${candidate.repository}@${candidate.commit.slice(0, 1)} ${candidate.statusName}`,
  );
}

describe('a lane is a candidate until its status has a verdict', () => {
  test('a new commit: lanes without statuses are candidates, in declaration order', () => {
    const queue = deriveQueue([repo('o/r', lanes())]);
    expect(queue.candidates).toEqual([
      {
        commit: MAIN,
        event: { branch: 'main', kind: 'push' },
        lane: PLATFORM,
        repository: 'o/r',
        statusName: 'hugi / platform',
      },
      {
        commit: MAIN,
        event: { branch: 'main', kind: 'push' },
        lane: TEST_MAC,
        repository: 'o/r',
        statusName: 'hugi / test (macos-latest)',
      },
    ]);
  });

  test.each(['success', 'failure', 'error'] as const)('a %s status settles the lane', (state) => {
    expect(names([repo('o/r', lanes({ 'hugi / platform': state }))])).toEqual([
      'o/r@a hugi / test (macos-latest)',
    ]);
  });

  test('a pending status with nothing in flight is queued again, as after a restart', () => {
    const pending = lanes({
      'hugi / platform': 'pending',
      'hugi / test (macos-latest)': 'pending',
    });
    expect(names([repo('o/r', pending)])).toEqual([
      'o/r@a hugi / platform',
      'o/r@a hugi / test (macos-latest)',
    ]);
  });

  test('a status of another context settles nothing', () => {
    expect(names([repo('o/r', lanes({ 'ci/legacy': 'success' }, PLATFORM))])).toEqual([
      'o/r@a hugi / platform',
    ]);
  });

  test('a lane its trigger or if: leaves out is no candidate', () => {
    const read: CommitRead = {
      kind: 'lanes',
      lanes: [
        { kind: 'left-out', lane: PLATFORM },
        { kind: 'runs', lane: TEST_MAC },
      ],
      statuses: statuses(),
    };
    expect(names([repo('o/r', read)])).toEqual(['o/r@a hugi / test (macos-latest)']);
  });

  test('a skip instruction, no current merge, and no declaration yield nothing', () => {
    const queue = deriveQueue([
      repo('o/r', { kind: 'skipped' }, pull('o/r', 3, { cause: 'conflict', kind: 'no-merge' })),
      repo('o/s', NOTHING),
    ]);
    expect(queue).toEqual({
      candidates: [],
      declarationReports: [],
      failures: [],
    });
  });
});

describe('a hugi status with a verdict settles the commit', () => {
  test('a refused declaration without one yields one report and no candidates', () => {
    const refused: CommitRead = { cause: 'lanes[0]: bad', kind: 'refused', statuses: statuses() };
    const queue = deriveQueue([repo('o/r', NOTHING, pull('o/r', 4, refused))]);
    expect(queue.candidates).toEqual([]);
    expect(queue.declarationReports).toEqual([
      { cause: 'lanes[0]: bad', commit: HEAD, repository: 'o/r' },
    ]);
  });

  test('a refused declaration with one is settled: no report and no candidates', () => {
    const refused: CommitRead = {
      cause: 'lanes[0]: bad',
      kind: 'refused',
      statuses: statuses({ hugi: 'failure' }),
    };
    const queue = deriveQueue([repo('o/r', refused)]);
    expect(queue.declarationReports).toEqual([]);
    expect(queue.candidates).toEqual([]);
  });

  test('a later accepted declaration on the same head runs none of its lanes', () => {
    expect(names([repo('o/r', lanes({ hugi: 'failure' }))])).toEqual([]);
  });

  test('a pending hugi status settles nothing', () => {
    expect(names([repo('o/r', lanes({ hugi: 'pending' }, PLATFORM))])).toEqual([
      'o/r@a hugi / platform',
    ]);
  });
});

describe('ordering', () => {
  test('every default branch first, in configuration order, then pull requests by number', () => {
    const snapshot = [
      repo('o/r', lanes({}, PLATFORM), pull('o/r', 9, lanes({}, PLATFORM), 'c'.repeat(40))),
      repo(
        'o/s',
        lanes({}, PLATFORM),
        pull('o/s', 5, lanes({}, PLATFORM), 'e'.repeat(40)),
        pull('o/s', 2, lanes({}, PLATFORM), 'd'.repeat(40)),
      ),
    ];
    expect(names(snapshot)).toEqual([
      'o/r@a hugi / platform',
      'o/s@a hugi / platform',
      'o/r@c hugi / platform',
      'o/s@d hugi / platform',
      'o/s@e hugi / platform',
    ]);
  });
});

describe('the runs in flight', () => {
  test('is not queued, while its sibling lanes are', () => {
    const inFlight = [{ commit: MAIN, repository: 'o/r', statusName: 'hugi / platform' }];
    expect(names([repo('o/r', lanes({ 'hugi / platform': 'pending' }))], inFlight)).toEqual([
      'o/r@a hugi / test (macos-latest)',
    ]);
  });

  test('is matched by repository, commit, and status name: the same name elsewhere is queued', () => {
    const name = 'hugi / test (macos-latest)';
    expect(
      names(
        [repo('o/r', lanes({}, TEST_MAC))],
        [{ commit: MAIN, repository: 'o/other', statusName: name }],
      ),
    ).toEqual(['o/r@a hugi / test (macos-latest)']);
    expect(
      names(
        [repo('o/r', lanes({}, TEST_MAC))],
        [{ commit: HEAD, repository: 'o/r', statusName: name }],
      ),
    ).toEqual(['o/r@a hugi / test (macos-latest)']);
    expect(
      names(
        [repo('o/r', lanes({}, TEST_MAC))],
        [{ commit: MAIN, repository: 'o/r', statusName: 'hugi / test (macos-15)' }],
      ),
    ).toEqual(['o/r@a hugi / test (macos-latest)']);
  });

  test('of another lane with the same status name keeps this lane out, so one name never has two runs', () => {
    // The run started from one event's declaration; the commit's other event declares the name
    // with other keys, as a pull request whose head is the default branch head can.
    const running = { ...TEST_MAC, matrix: { os: 'a, b' } };
    const declared = { ...TEST_MAC, matrix: { os: 'a', xcode: 'b' } };
    const inFlight = [{ commit: MAIN, repository: 'o/r', statusName: laneStatusName(running) }];
    expect(names([repo('o/r', lanes({}, declared))], inFlight)).toEqual([]);
  });

  test('of a row whose value has another type but the same name keeps the lane out', () => {
    const inFlight = [
      {
        commit: MAIN,
        repository: 'o/r',
        statusName: laneStatusName({ ...TEST_MAC, matrix: { n: '1' } }),
      },
    ];
    expect(names([repo('o/r', lanes({}, { ...TEST_MAC, matrix: { n: 1 } }))], inFlight)).toEqual(
      [],
    );
  });

  test('is matched ignoring case', () => {
    const inFlight = [{ commit: MAIN, repository: 'o/r', statusName: 'HUGI / Platform' }];
    expect(names([repo('o/r', lanes({}, PLATFORM))], inFlight)).toEqual([]);
  });

  test("of a superseded head stays out of the queue; the new head's lanes are queued", () => {
    const oldHead = 'f'.repeat(40);
    const inFlight = [{ commit: oldHead, repository: 'o/r', statusName: 'hugi / platform' }];
    const queue = deriveQueue(
      [repo('o/r', NOTHING, pull('o/r', 4, lanes({}, PLATFORM)))],
      inFlight,
    );
    expect(queue.candidates.map((candidate) => candidate.commit)).toEqual([HEAD]);
  });

  test('two runs in flight, as ADR-0003 allows, are each kept out of the queue', () => {
    const inFlight = [
      { commit: MAIN, repository: 'o/r', statusName: 'hugi / platform' },
      { commit: MAIN, repository: 'o/r', statusName: 'hugi / test (macos-latest)' },
    ];
    expect(names([repo('o/r', lanes())], inFlight)).toEqual([]);
  });
});

describe('status names compare ignoring case, as GitHub compares contexts', () => {
  test('a verdict on a name in other case settles the lane', () => {
    expect(names([repo('o/r', lanes({ 'HUGI / PLATFORM': 'success' }))])).toEqual([
      'o/r@a hugi / test (macos-latest)',
    ]);
  });

  test('a verdict on the declaration status in other case settles the commit', () => {
    expect(names([repo('o/r', lanes({ HUGI: 'failure' }))])).toEqual([]);
    const refused: CommitRead = {
      cause: 'bad',
      kind: 'refused',
      statuses: statuses({ Hugi: 'error' }),
    };
    expect(deriveQueue([repo('o/r', refused)]).declarationReports).toEqual([]);
  });

  test('a pending status in other case settles nothing', () => {
    expect(names([repo('o/r', lanes({ 'HUGI / PLATFORM': 'pending' }, PLATFORM))])).toEqual([
      'o/r@a hugi / platform',
    ]);
  });

  test.each([
    [
      'pending first',
      [
        ['hugi / platform', 'pending'],
        ['HUGI / PLATFORM', 'success'],
      ],
    ],
    [
      'verdict first',
      [
        ['HUGI / PLATFORM', 'success'],
        ['hugi / platform', 'pending'],
      ],
    ],
  ] as const)(
    'a name is settled when any entry in any case carries a verdict, %s',
    (_label, entries) => {
      const read: CommitRead = {
        kind: 'lanes',
        lanes: [{ kind: 'runs', lane: PLATFORM }],
        statuses: new Map<string, CommitStatusState>(entries),
      };
      expect(names([repo('o/r', read)])).toEqual([]);
    },
  );

  test('two lanes of one commit whose names differ only in case are queued once', () => {
    const upper = { ...PLATFORM, job: 'PLATFORM' };
    expect(names([repo('o/r', lanes({}, PLATFORM, upper))])).toEqual(['o/r@a hugi / platform']);
  });
});

describe('one commit in two snapshots', () => {
  test('a pull request whose head is the default branch head adds nothing; the push candidate wins', () => {
    const queue = deriveQueue([
      repo('o/r', lanes({}, PLATFORM), pull('o/r', 4, lanes({}, PLATFORM), MAIN)),
    ]);
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0]!.event).toEqual({ branch: 'main', kind: 'push' });
  });

  test('one branch opened as two pull requests queues each lane once, for the lower number', () => {
    const queue = deriveQueue([
      repo('o/r', NOTHING, pull('o/r', 9, lanes()), pull('o/r', 4, lanes())),
    ]);
    expect(names([repo('o/r', NOTHING, pull('o/r', 9, lanes()), pull('o/r', 4, lanes()))])).toEqual(
      ['o/r@b hugi / platform', 'o/r@b hugi / test (macos-latest)'],
    );
    expect(
      queue.candidates.map((candidate) =>
        candidate.event.kind === 'pull_request' ? candidate.event.pullRequest.number : 0,
      ),
    ).toEqual([4, 4]);
  });

  test('a refused declaration on a shared head is reported once', () => {
    const refused: CommitRead = { cause: 'lanes[0]: bad', kind: 'refused', statuses: statuses() };
    const queue = deriveQueue([
      repo('o/r', NOTHING, pull('o/r', 4, refused), pull('o/r', 9, refused)),
    ]);
    expect(queue.declarationReports).toEqual([
      { cause: 'lanes[0]: bad', commit: HEAD, repository: 'o/r' },
    ]);
  });

  test('a refused merge declaration on a pull request whose head is the default branch head adds nothing', () => {
    const refused: CommitRead = { cause: 'lanes[0]: bad', kind: 'refused', statuses: statuses() };
    const queue = deriveQueue([repo('o/r', lanes({}, PLATFORM), pull('o/r', 4, refused, MAIN))]);
    expect(queue.declarationReports).toEqual([]);
    expect(
      queue.candidates.map((candidate) => [candidate.statusName, candidate.event.kind]),
    ).toEqual([['hugi / platform', 'push']]);
  });

  test('a refused push declaration decides the commit: one report, and no pull request candidates', () => {
    const refused: CommitRead = { cause: 'lanes[0]: bad', kind: 'refused', statuses: statuses() };
    const queue = deriveQueue([repo('o/r', refused, pull('o/r', 4, lanes({}, PLATFORM), MAIN))]);
    expect(queue.declarationReports).toEqual([
      { cause: 'lanes[0]: bad', commit: MAIN, repository: 'o/r' },
    ]);
    expect(queue.candidates).toEqual([]);
  });

  test('a pull request whose head is the default branch head adds no lane the push leaves out', () => {
    const snapshot = [
      repo('o/r', lanes({}, PLATFORM), pull('o/r', 4, lanes({}, PLATFORM, TEST_MAC), MAIN)),
    ];
    expect(names(snapshot)).toEqual(['o/r@a hugi / platform']);
  });

  test('of two pull requests sharing a head, the lower number decides it wholly', () => {
    const refused: CommitRead = { cause: 'lanes[0]: bad', kind: 'refused', statuses: statuses() };
    const queue = deriveQueue([
      repo('o/r', NOTHING, pull('o/r', 9, refused), pull('o/r', 4, lanes({}, PLATFORM))),
    ]);
    expect(queue.declarationReports).toEqual([]);
    expect(queue.candidates.map((candidate) => candidate.statusName)).toEqual(['hugi / platform']);
  });

  test('a pull request with no current merge does not claim its head: a mergeable one sharing it decides', () => {
    const noMerge: CommitRead = { cause: 'Pull request 1 has a merge conflict.', kind: 'no-merge' };
    const queue = deriveQueue([
      repo('o/r', NOTHING, pull('o/r', 1, noMerge), pull('o/r', 2, lanes({}, PLATFORM))),
    ]);
    expect(
      queue.candidates.map((candidate) =>
        candidate.event.kind === 'pull_request' ? candidate.event.pullRequest.number : 0,
      ),
    ).toEqual([2]);
  });

  test('a default branch head whose read failed does not claim it: a pull request sharing it decides', () => {
    const failed: CommitRead = { cause: 'git fetch failed', kind: 'failed' };
    const queue = deriveQueue([repo('o/r', failed, pull('o/r', 4, lanes({}, PLATFORM), MAIN))]);
    expect(queue.candidates.map((candidate) => [candidate.commit, candidate.event.kind])).toEqual([
      [MAIN, 'pull_request'],
    ]);
  });

  test('a failed pull request read does not claim its head: the next one sharing it decides wholly', () => {
    const failed: CommitRead = { cause: 'boom', kind: 'failed', unexpected: true };
    const refused: CommitRead = { cause: 'lanes[0]: bad', kind: 'refused', statuses: statuses() };
    const queue = deriveQueue([
      repo(
        'o/r',
        NOTHING,
        pull('o/r', 1, failed),
        pull('o/r', 2, refused),
        pull('o/r', 3, lanes({}, PLATFORM)),
      ),
    ]);
    expect(queue.declarationReports).toEqual([
      { cause: 'lanes[0]: bad', commit: HEAD, repository: 'o/r' },
    ]);
    expect(queue.candidates).toEqual([]);
  });

  test('a skipped read claims its commit', () => {
    const queue = deriveQueue([
      repo('o/r', { kind: 'skipped' }, pull('o/r', 4, lanes({}, PLATFORM), MAIN)),
    ]);
    expect(queue.candidates).toEqual([]);
  });

  test('the same commit in two repositories is two commits', () => {
    expect(names([repo('o/r', lanes({}, PLATFORM)), repo('o/s', lanes({}, PLATFORM))])).toEqual([
      'o/r@a hugi / platform',
      'o/s@a hugi / platform',
    ]);
  });
});

test('a default branch head whose read failed is reported, and the pull requests still yield', () => {
  const failed: CommitRead = { cause: 'git fetch failed', kind: 'failed', unexpected: true };
  const queue = deriveQueue([repo('o/r', failed, pull('o/r', 4, lanes({}, PLATFORM)))]);
  expect(queue.failures).toEqual([
    { cause: 'git fetch failed', defaultBranch: 'main', repository: 'o/r', unexpected: true },
  ]);
  expect(queue.candidates.map((candidate) => candidate.commit)).toEqual([HEAD]);
});

test('a repository whose reads failed is reported, and the others still yield candidates', () => {
  const queue = deriveQueue([
    { cause: 'GitHub answered 502', kind: 'failed', repository: 'o/broken' },
    repo('o/r', lanes({}, PLATFORM)),
  ]);
  expect(queue.failures).toEqual([{ cause: 'GitHub answered 502', repository: 'o/broken' }]);
  expect(queue.candidates.map((candidate) => candidate.repository)).toEqual(['o/r']);
});

test('a pull request whose reads failed is reported by number, and its siblings still yield', () => {
  const snapshot: RepositorySnapshot = {
    defaultBranch: push('o/r', lanes({}, PLATFORM)),
    kind: 'read',
    pullRequestFailures: [
      { cause: 'GitHub answered 502', number: 4 },
      { cause: 'boom', number: 6, unexpected: true },
    ],
    pullRequests: [pull('o/r', 5, lanes({}, PLATFORM), 'c'.repeat(40))],
    repository: 'o/r',
  };
  const queue = deriveQueue([snapshot]);
  expect(queue.failures).toEqual([
    { cause: 'GitHub answered 502', pullRequest: 4, repository: 'o/r' },
    { cause: 'boom', pullRequest: 6, repository: 'o/r', unexpected: true },
  ]);
  expect(queue.candidates.map((candidate) => candidate.commit[0])).toEqual(['a', 'c']);
});
