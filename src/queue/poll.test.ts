/* Workflow expression delimiters are literal input to the lane reader. */
/* eslint-disable no-template-curly-in-string */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { stringify } from 'yaml';

import { createGitHubReader } from '../github/client';
import type { CommitStatusState } from '../github/client';
import type { Fetch, PullRequestFacts } from '../github/pull-request';
import { NoCurrentMergeError, SourceError } from '../source/host-source';
import { deriveQueue } from './derive';
import { pollRepositories } from './poll';
import type { CommitSource, PollDeps } from './poll';
import type { RunInFlight } from './types';

const API = 'https://api.github.com';

type Fields = Record<string, unknown>;
type RecordedBranch = Fields & { commit: Fields & { commit: Fields } };
type RecordedPull = Fields & { base: Fields; head: Fields; user: Fields };
type RecordedStatus = Fields & { statuses: Fields[] };

/** A recorded GitHub API response from `src/github/fixtures/`, parsed into its documented shape. */
async function recorded<Shape>(name: string): Promise<Shape> {
  return JSON.parse(
    await Bun.file(join(import.meta.dir, '..', 'github', 'fixtures', `${name}.json`)).text(),
  );
}

const RECORDED = {
  branch: await recorded<RecordedBranch>('branch-main'),
  commit: await recorded<Fields>('git-commit-44'),
  pull: await recorded<RecordedPull>('pull-44'),
  pulls: await recorded<RecordedPull[]>('pulls-page-1'),
  repository: await recorded<Fields>('repository'),
  status: await recorded<RecordedStatus>('status-page-1'),
};

/** `base` with `fields` set over it. */
function edited(base: Fields | undefined, fields: Fields): Fields {
  return { ...base, ...fields };
}

const sha = (digit: string) => digit.repeat(40);

const CI = stringify({
  jobs: {
    platform: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] },
    release: {
      if: "github.event_name == 'push'",
      'runs-on': 'macos-latest',
      steps: [{ run: 'true' }],
    },
    test: {
      'runs-on': '${{ matrix.os }}',
      steps: [{ run: 'true' }],
      strategy: { matrix: { os: ['ubuntu-latest', 'macos-latest'] } },
    },
  },
  on: { pull_request: null, push: { branches: ['main'] } },
});

const DOCS = stringify({
  jobs: { site: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] } },
  on: {
    pull_request: { paths: ['docs/**'] },
    push: { branches: ['main'], 'branches-ignore': ['x'] },
  },
});

const DECLARATION = stringify({
  lanes: [
    { jobs: ['platform', 'release'], workflow: 'ci.yml' },
    { jobs: ['test'], matrix: { os: 'macos-latest' }, workflow: 'ci.yml' },
    { jobs: ['site'], workflow: 'docs.yml' },
  ],
});

/** A commit with Hugi's lanes declared, as a source reads it. */
const DECLARED = {
  '.github/hugi.yaml': DECLARATION,
  '.github/workflows/ci.yml': CI,
  '.github/workflows/docs.yml': DOCS,
};

type CommitFixture = { files: Record<string, string>; changed?: string[] };

type PullFixture = {
  number: number;
  author: string | null;
  head: string;
  message?: string;
  /** The merge commit, or why there is none. */
  merge: { sha: string } | 'conflict';
};

type RepoFixture = {
  name: string;
  head: string;
  message?: string;
  pulls?: PullFixture[];
  /** Any response that should fail, by URL. */
  failing?: string;
};

type World = {
  repos: RepoFixture[];
  commits: Record<string, CommitFixture>;
  statuses?: Record<string, Record<string, CommitStatusState>>;
};

/** The recorded combined status, holding `states` for `commit`. */
function statusesOf(commit: string, states: Record<string, CommitStatusState>) {
  const [recordedStatus] = RECORDED.status.statuses;
  return edited(RECORDED.status, {
    sha: commit,
    statuses: Object.entries(states).map(([context, state]) =>
      edited(recordedStatus, { context, state }),
    ),
  });
}

/** Answer GitHub's API from the recorded responses, reshaped to the world's state. */
function github(world: World): Fetch {
  const routes = new Map<string, unknown>();
  for (const repo of world.repos) {
    const base = `${API}/repos/${repo.name}`;
    routes.set(base, { ...RECORDED.repository, default_branch: 'main', full_name: repo.name });
    const { commit: branchCommit } = RECORDED.branch;
    routes.set(`${base}/branches/main`, {
      ...RECORDED.branch,
      commit: {
        ...branchCommit,
        commit: { ...branchCommit.commit, message: repo.message ?? 'Tidy' },
        sha: repo.head,
      },
    });
    const [listed] = RECORDED.pulls;
    routes.set(
      `${base}/pulls?state=open&per_page=100`,
      (repo.pulls ?? []).map((pull) =>
        edited(listed, {
          base: edited(listed?.base, { ref: 'main' }),
          head: edited(listed?.head, { ref: `topic-${pull.number}`, sha: pull.head }),
          number: pull.number,
          user: pull.author === null ? null : edited(listed?.user, { login: pull.author }),
        }),
      ),
    );
    for (const pull of repo.pulls ?? []) {
      const merge = pull.merge === 'conflict' ? null : pull.merge.sha;
      routes.set(`${base}/pulls/${pull.number}`, {
        ...RECORDED.pull,
        base: { ...RECORDED.pull.base, ref: 'main' },
        head: { ...RECORDED.pull.head, ref: `topic-${pull.number}`, sha: pull.head },
        merge_commit_sha: merge,
        mergeable: merge !== null,
        number: pull.number,
      });
      routes.set(`${base}/git/commits/${pull.head}`, {
        ...RECORDED.commit,
        message: pull.message ?? 'Change things',
        sha: pull.head,
      });
    }
  }
  return async (url) => {
    const failing = world.repos.some((repo) => repo.failing === url);
    const status = /\/commits\/([0-9a-f]{40})\/status\?per_page=100$/u.exec(url)?.[1];
    if (!failing && status !== undefined) {
      return Response.json(statusesOf(status, world.statuses?.[status] ?? {}));
    }
    if (failing || !routes.has(url)) {
      return new Response('{"message":"Server Error"}', { status: failing ? 502 : 404 });
    }
    return Response.json(routes.get(url));
  };
}

/** Sources read from the world's commits, as the host source would read them. */
function sources(
  world: World,
  opened: string[] = [],
): Pick<PollDeps, 'openPush' | 'openPullRequest'> {
  const at = (commit: string): CommitSource => {
    const fixture = world.commits[commit];
    if (fixture === undefined) {
      throw new SourceError(`The commit "${commit}" does not exist in the repository.`);
    }
    opened.push(commit);
    return {
      changedFiles: async () => fixture.changed ?? [],
      readFile: async (path) => fixture.files[path],
      sha: commit,
    };
  };
  return {
    openPullRequest: async (_repository, facts: PullRequestFacts) => {
      if (facts.mergeable === false || facts.mergeCommitSha === null) {
        throw new NoCurrentMergeError(
          'conflict',
          `Pull request ${facts.number} has a merge conflict.`,
        );
      }
      return at(facts.mergeCommitSha);
    },
    openPush: async (_repository, commit) => at(commit),
  };
}

async function poll(world: World, allowlist = ['ada'], inFlight?: RunInFlight) {
  const opened: string[] = [];
  const snapshot = await pollRepositories(
    { allowlist, repositories: world.repos.map((repo) => repo.name) },
    {
      github: createGitHubReader({ fetch: github(world), token: async () => 'ghs_token' }),
      ...sources(world, opened),
    },
  );
  return { opened, queue: deriveQueue(snapshot, inFlight), snapshot };
}

/** Each candidate as `repository@sha-digit status-name`. */
function named(queue: Awaited<ReturnType<typeof poll>>['queue']) {
  return queue.candidates.map(
    (candidate) => `${candidate.repository}@${candidate.commit[0]} ${candidate.statusName}`,
  );
}

describe('a push to the default branch', () => {
  test('a new commit: each lane its event selects is a candidate', async () => {
    const { queue } = await poll({
      commits: { [sha('1')]: { files: DECLARED } },
      repos: [{ head: sha('1'), name: 'o/r' }],
    });
    // release runs only for a push; site's push filter is refused, so it is reported, not run.
    expect(named(queue)).toEqual([
      'o/r@1 hugi / platform',
      'o/r@1 hugi / release',
      'o/r@1 hugi / test (macos-latest)',
    ]);
    expect(queue.candidates[0]).toEqual({
      commit: sha('1'),
      event: { branch: 'main', kind: 'push' },
      lane: { job: 'platform', matrix: {}, workflow: '.github/workflows/ci.yml' },
      repository: 'o/r',
      statusName: 'hugi / platform',
    });
    expect(queue.refusedTriggers).toEqual([
      {
        cause: 'on.push cannot have both branches and branches-ignore',
        commit: sha('1'),
        lane: { job: 'site', matrix: {}, workflow: '.github/workflows/docs.yml' },
        repository: 'o/r',
      },
    ]);
  });

  test('a lane with a verdict is settled, and a pending one is queued again after a restart', async () => {
    const { queue } = await poll({
      commits: { [sha('1')]: { files: DECLARED } },
      repos: [{ head: sha('1'), name: 'o/r' }],
      statuses: {
        [sha('1')]: {
          'hugi / platform': 'success',
          'hugi / release': 'failure',
          'hugi / test (macos-latest)': 'pending',
        },
      },
    });
    expect(named(queue)).toEqual(['o/r@1 hugi / test (macos-latest)']);
  });

  test('a skip instruction yields nothing and opens no source', async () => {
    const { opened, queue } = await poll({
      commits: { [sha('1')]: { files: DECLARED } },
      repos: [{ head: sha('1'), message: 'Bump\n\n[skip ci]', name: 'o/r' }],
    });
    expect(queue.candidates).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('a commit with no declaration yields nothing', async () => {
    const { queue } = await poll({
      commits: { [sha('1')]: { files: { '.github/workflows/ci.yml': CI } } },
      repos: [{ head: sha('1'), name: 'o/r' }],
    });
    expect(queue.candidates).toEqual([]);
  });
});

describe('a refused declaration', () => {
  const refused = {
    '.github/hugi.yaml': stringify({ lanes: [{ jobs: ['nope'], workflow: 'ci.yml' }] }),
    '.github/workflows/ci.yml': CI,
  };

  test('without a hugi verdict yields one report on the commit and no candidates', async () => {
    const { queue } = await poll({
      commits: { [sha('1')]: { files: refused } },
      repos: [{ head: sha('1'), name: 'o/r' }],
    });
    expect(queue.candidates).toEqual([]);
    expect(queue.declarationReports).toEqual([
      {
        cause: expect.stringContaining('lanes[0] job "nope"'),
        commit: sha('1'),
        repository: 'o/r',
      },
    ]);
  });

  test('with a hugi verdict is settled', async () => {
    const { queue } = await poll({
      commits: { [sha('1')]: { files: refused } },
      repos: [{ head: sha('1'), name: 'o/r' }],
      statuses: { [sha('1')]: { hugi: 'failure' } },
    });
    expect(queue).toEqual({
      candidates: [],
      declarationReports: [],
      failures: [],
      refusedTriggers: [],
    });
  });
});

/** One repository whose default branch has no declaration, with these pull requests. */
const pullsWorld = (pulls: PullFixture[], statuses: World['statuses'] = {}): World => ({
  commits: {
    [sha('1')]: { files: {} },
    [sha('4')]: { files: {} },
    [sha('5')]: { files: {} },
    [sha('8')]: { changed: ['docs/index.md'], files: DECLARED },
  },
  repos: [{ head: sha('1'), name: 'o/r', pulls }],
  statuses,
});

describe('a pull request', () => {
  test('runs at its merge commit; its candidates are its head with each lane its event selects', async () => {
    const { opened, queue } = await poll(
      pullsWorld([{ author: 'Ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 }]),
    );
    // The declaration and workflows are read at the merge; release is push-only; docs changed.
    expect(opened).toEqual([sha('1'), sha('8')]);
    expect(named(queue)).toEqual([
      'o/r@4 hugi / platform',
      'o/r@4 hugi / test (macos-latest)',
      'o/r@4 hugi / site',
    ]);
    expect(queue.candidates[0]!.event).toEqual({
      kind: 'pull_request',
      pullRequest: { baseRef: 'main', headRef: 'topic-44', headSha: sha('4'), number: 44 },
    });
  });

  test('a path filter its changed files miss leaves the lane out', async () => {
    const state = pullsWorld([
      { author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 },
    ]);
    state.commits[sha('8')] = { changed: ['src/main.ts'], files: DECLARED };
    expect(named((await poll(state)).queue)).toEqual([
      'o/r@4 hugi / platform',
      'o/r@4 hugi / test (macos-latest)',
    ]);
  });

  test('statuses are read on the head commit, not the merge commit', async () => {
    const { queue } = await poll(
      pullsWorld([{ author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 }], {
        [sha('4')]: { 'hugi / platform': 'success', 'hugi / site': 'error' },
        [sha('8')]: { 'hugi / test (macos-latest)': 'success' },
      }),
    );
    expect(named(queue)).toEqual(['o/r@4 hugi / test (macos-latest)']);
  });

  test('by an author the allowlist does not admit yields nothing and is never read', async () => {
    const { opened, queue } = await poll(
      pullsWorld([
        { author: 'mallory', head: sha('4'), merge: { sha: sha('8') }, number: 42 },
        { author: null, head: sha('5'), merge: { sha: sha('8') }, number: 7 },
      ]),
    );
    expect(queue.candidates).toEqual([]);
    expect(opened).toEqual([sha('1')]);
  });

  test('with no current merge yields no candidates this poll', async () => {
    const { queue, snapshot } = await poll(
      pullsWorld([{ author: 'ada', head: sha('4'), merge: 'conflict', number: 44 }]),
    );
    expect(queue.candidates).toEqual([]);
    expect(snapshot[0]).toMatchObject({
      pullRequests: [
        { read: { cause: 'Pull request 44 has a merge conflict.', kind: 'no-merge' } },
      ],
    });
  });

  test("whose head commit's message carries a skip instruction yields nothing", async () => {
    const { opened, queue } = await poll(
      pullsWorld([
        {
          author: 'ada',
          head: sha('4'),
          merge: { sha: sha('8') },
          message: 'Fix typo\n\nskip-checks: true',
          number: 44,
        },
      ]),
    );
    expect(queue.candidates).toEqual([]);
    expect(opened).toEqual([sha('1')]);
  });

  test("superseded: only the new head's lanes are queued, and the old head's run in flight stays out", async () => {
    const oldHeadRun: RunInFlight = {
      commit: sha('3'),
      lane: { job: 'platform', matrix: {}, workflow: '.github/workflows/ci.yml' },
      repository: 'o/r',
    };
    const { queue } = await poll(
      pullsWorld([{ author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 }]),
      ['ada'],
      oldHeadRun,
    );
    expect(queue.candidates.every((candidate) => candidate.commit === sha('4'))).toBe(true);
    expect(named(queue)).toContain('o/r@4 hugi / platform');
  });
});

test('default-branch candidates come first, then pull requests by repository and number', async () => {
  const { queue } = await poll({
    commits: {
      [sha('1')]: { files: DECLARED },
      [sha('2')]: { files: DECLARED },
      [sha('8')]: {
        files: {
          ...DECLARED,
          '.github/hugi.yaml': stringify({ lanes: [{ jobs: ['platform'], workflow: 'ci.yml' }] }),
        },
      },
    },
    repos: [
      {
        head: sha('1'),
        name: 'o/r',
        pulls: [
          { author: 'ada', head: sha('6'), merge: { sha: sha('8') }, number: 9 },
          { author: 'ada', head: sha('5'), merge: { sha: sha('8') }, number: 3 },
        ],
      },
      { head: sha('2'), name: 'o/s' },
    ],
  });
  expect(named(queue).filter((name) => name.endsWith('platform'))).toEqual([
    'o/r@1 hugi / platform',
    'o/s@2 hugi / platform',
    'o/r@5 hugi / platform',
    'o/r@6 hugi / platform',
  ]);
});

test('a repository whose reads fail is reported, and the others still yield candidates', async () => {
  const { queue } = await poll({
    commits: { [sha('1')]: { files: DECLARED }, [sha('2')]: { files: DECLARED } },
    repos: [
      {
        failing: `${API}/repos/o/broken/pulls?state=open&per_page=100`,
        head: sha('1'),
        name: 'o/broken',
      },
      { head: sha('2'), name: 'o/r' },
    ],
  });
  expect(queue.failures).toEqual([
    {
      cause: "GitHub's API answered 502 for GET /repos/o/broken/pulls.",
      repository: 'o/broken',
    },
  ]);
  expect(new Set(queue.candidates.map((candidate) => candidate.repository))).toEqual(
    new Set(['o/r']),
  );
});

test('a repository whose source cannot be read is reported like a failed API read', async () => {
  const { queue } = await poll({
    commits: { [sha('2')]: { files: DECLARED } },
    repos: [
      { head: sha('1'), name: 'o/gone' },
      { head: sha('2'), name: 'o/r' },
    ],
  });
  expect(queue.failures).toEqual([
    { cause: `The commit "${sha('1')}" does not exist in the repository.`, repository: 'o/gone' },
  ]);
  expect(queue.candidates.length).toBeGreaterThan(0);
});
