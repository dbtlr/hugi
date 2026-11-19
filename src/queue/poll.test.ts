/* Workflow expression delimiters are literal input to the lane reader. */
/* eslint-disable no-template-curly-in-string */
import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import { stringify } from 'yaml';

import { createGitHubReader } from '../github/client';
import type { CommitStatusState, GitHubReader } from '../github/client';
import type { Fetch, PullRequestFacts } from '../github/pull-request';
// The spies need the modules' namespaces to count how often a workflow is parsed and triggered.
// eslint-disable-next-line import/no-namespace
import * as laneParse from '../lane/parse';
import { NoCurrentMergeError, NotAFileError, SourceError } from '../source/host-source';
// eslint-disable-next-line import/no-namespace
import * as trigger from '../trigger';
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
    push: { branches: ['main'] },
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

/** What a test sees of the sources a poll opens: each commit opened, and each file read. */
type Seen = { opened: string[]; reads: string[]; changed: string[] };

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
  seen: Seen = { changed: [], opened: [], reads: [] },
): Pick<PollDeps, 'openPush' | 'openPullRequest'> {
  // The source reads a pull request's head message from git, as the host source does.
  const messages = new Map(
    world.repos.flatMap((repo) =>
      (repo.pulls ?? []).map((pull) => [pull.head, pull.message ?? 'Change things'] as const),
    ),
  );
  const at = (commit: string): CommitSource => {
    const fixture = world.commits[commit];
    if (fixture === undefined) {
      throw new SourceError(`The commit "${commit}" does not exist in the repository.`);
    }
    seen.opened.push(commit);
    return {
      changedFiles: async () => {
        seen.changed.push(commit);
        return fixture.changed ?? [];
      },
      commitMessage: async (head) => messages.get(head) ?? 'Change things',
      readFile: async (path) => {
        seen.reads.push(path);
        const text = fixture.files[path];
        if (text === DIRECTORY) {
          throw new NotAFileError(`${path} is a tree, not a file, at ${commit}.`);
        }
        return text;
      },
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

/** A file the source holds as a directory, which reads as `NotAFileError`. */
const DIRECTORY = '<directory>';

/** Poll the world; `deps` replaces any of the dependencies built from it. */
async function poll(
  world: World,
  allowlist = ['ada'],
  inFlight: RunInFlight[] = [],
  deps: (built: PollDeps) => Partial<PollDeps> = () => ({}),
) {
  const seen: Seen = { changed: [], opened: [], reads: [] };
  const built: PollDeps = {
    github: createGitHubReader({ fetch: github(world), token: async () => 'ghs_token' }),
    ...sources(world, seen),
  };
  const snapshot = await pollRepositories(
    { allowlist, repositories: world.repos.map((repo) => repo.name) },
    { ...built, ...deps(built) },
  );
  return { ...seen, queue: deriveQueue(snapshot, inFlight), snapshot };
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
    // release runs only for a push; site's path filter applies to pull requests alone.
    expect(named(queue)).toEqual([
      'o/r@1 hugi / platform',
      'o/r@1 hugi / release',
      'o/r@1 hugi / test (macos-latest)',
      'o/r@1 hugi / site',
    ]);
    expect(queue.candidates[0]).toEqual({
      commit: sha('1'),
      event: { branch: 'main', kind: 'push' },
      lane: { job: 'platform', matrix: {}, workflow: '.github/workflows/ci.yml' },
      repository: 'o/r',
      statusName: 'hugi / platform',
    });
  });

  test('a declaration naming a workflow whose on: GitHub would refuse is reported, and runs nothing', async () => {
    const badDocs = stringify({
      jobs: { site: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] } },
      on: { push: { branches: ['main'], 'branches-ignore': ['x'] } },
    });
    const { queue } = await poll({
      commits: { [sha('1')]: { files: { ...DECLARED, '.github/workflows/docs.yml': badDocs } } },
      repos: [{ head: sha('1'), name: 'o/r' }],
    });
    expect(queue.candidates).toEqual([]);
    expect(queue.declarationReports).toHaveLength(1);
    expect(queue.declarationReports[0]).toMatchObject({ commit: sha('1'), repository: 'o/r' });
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
    expect(named(queue)).toEqual(['o/r@1 hugi / test (macos-latest)', 'o/r@1 hugi / site']);
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

  test("whose head commit's message, read from git at the head, carries a skip instruction yields nothing", async () => {
    const { queue, reads } = await poll(
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
    expect(reads).toEqual(['.github/hugi.yaml']);
  });

  test("superseded: only the new head's lanes are queued, and the old head's run in flight stays out", async () => {
    const oldHeadRun: RunInFlight = {
      commit: sha('3'),
      repository: 'o/r',
      statusName: 'hugi / platform',
    };
    const { queue } = await poll(
      pullsWorld([{ author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 }]),
      ['ada'],
      [oldHeadRun],
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

test("a default branch head whose source cannot be read is reported, and the repository's pull requests are still read", async () => {
  const { queue } = await poll({
    commits: { [sha('2')]: { files: DECLARED }, [sha('8')]: { files: DECLARED } },
    repos: [
      {
        head: sha('1'),
        name: 'o/gone',
        pulls: [{ author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 }],
      },
      { head: sha('2'), name: 'o/r' },
    ],
  });
  expect(queue.failures).toEqual([
    {
      cause: `The commit "${sha('1')}" does not exist in the repository.`,
      defaultBranch: 'main',
      repository: 'o/gone',
    },
  ]);
  expect(new Set(named(queue).map((name) => name.split(' ')[0]))).toEqual(
    new Set(['o/gone@4', 'o/r@2']),
  );
});

test('a pull request whose read fails is skipped alone, and named in the failure', async () => {
  const { queue } = await poll({
    commits: {
      [sha('1')]: { files: DECLARED },
      [sha('5')]: { files: {} },
      [sha('8')]: { files: DECLARED },
    },
    repos: [
      {
        failing: `${API}/repos/o/r/pulls/44`,
        head: sha('1'),
        name: 'o/r',
        pulls: [
          { author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 },
          { author: 'ada', head: sha('6'), merge: { sha: sha('8') }, number: 45 },
        ],
      },
    ],
  });
  expect(queue.failures).toEqual([
    {
      cause: "GitHub's API answered 502 for GET /repos/o/r/pulls/44.",
      pullRequest: 44,
      repository: 'o/r',
    },
  ]);
  expect(new Set(queue.candidates.map((candidate) => candidate.commit[0]))).toEqual(
    new Set(['1', '6']),
  );
});

/** `opened`, with `readFile` throwing a plain error when it is at `commit`. */
async function brokenAt(commit: string, source: Promise<CommitSource>): Promise<CommitSource> {
  const opened = await source;
  return opened.sha === commit
    ? {
        ...opened,
        readFile: async () => {
          throw new Error('a bug in the reader');
        },
      }
    : opened;
}

/** The world's sources, with `readFile` at `commit` throwing a plain error. */
function throwingAt(commit: string) {
  return (built: PollDeps): Partial<PollDeps> => ({
    openPullRequest: async (repository, facts) =>
      brokenAt(commit, built.openPullRequest(repository, facts)),
    openPush: async (repository, head) => brokenAt(commit, built.openPush(repository, head)),
  });
}

/** Two repositories, the first with two pull requests, every commit declaring lanes. */
const twoRepositories = (): World => ({
  commits: {
    [sha('1')]: { files: DECLARED },
    [sha('2')]: { files: DECLARED },
    [sha('8')]: { files: DECLARED },
    [sha('9')]: { files: DECLARED },
  },
  repos: [
    {
      head: sha('1'),
      name: 'o/r',
      pulls: [
        { author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 },
        { author: 'ada', head: sha('5'), merge: { sha: sha('9') }, number: 45 },
      ],
    },
    { head: sha('2'), name: 'o/s' },
  ],
});

/** A workflow whose one macOS job runs only when `docs/**` changed. */
const pathFiltered = (job: string) =>
  stringify({
    jobs: { [job]: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] } },
    on: { pull_request: { paths: ['docs/**'] }, push: { paths: ['docs/**'] } },
  });

describe('an error no read expects', () => {
  test('while reading one pull request skips it alone, marked unexpected', async () => {
    const { queue } = await poll(twoRepositories(), ['ada'], [], throwingAt(sha('8')));
    expect(queue.failures).toEqual([
      { cause: 'a bug in the reader', pullRequest: 44, repository: 'o/r', unexpected: true },
    ]);
    expect(new Set(named(queue).map((name) => name.split(' ')[0]))).toEqual(
      new Set(['o/r@1', 'o/s@2', 'o/r@5']),
    );
  });

  test('while reading the default branch head skips it alone, marked unexpected', async () => {
    const { queue } = await poll(twoRepositories(), ['ada'], [], throwingAt(sha('1')));
    expect(queue.failures).toEqual([
      { cause: 'a bug in the reader', defaultBranch: 'main', repository: 'o/r', unexpected: true },
    ]);
    expect(new Set(named(queue).map((name) => name.split(' ')[0]))).toEqual(
      new Set(['o/s@2', 'o/r@4', 'o/r@5']),
    );
  });

  test('in a repository-level read skips that repository, marked unexpected', async () => {
    const { queue } = await poll(twoRepositories(), ['ada'], [], (built) => ({
      github: {
        ...built.github,
        openPullRequests: async (repository) => {
          if (repository === 'o/r') {
            throw new TypeError('listing is not iterable');
          }
          return built.github.openPullRequests(repository);
        },
      } satisfies GitHubReader,
    }));
    expect(queue.failures).toEqual([
      { cause: 'listing is not iterable', repository: 'o/r', unexpected: true },
    ]);
    expect(named(queue).map((name) => name.split(' ')[0])).toContain('o/s@2');
  });

  test('a default branch head whose message is not text skips that head alone, marked unexpected', async () => {
    const { queue } = await poll(twoRepositories(), ['ada'], [], (built) => ({
      github: {
        ...built.github,
        defaultBranchHead: async (repository) => {
          const head = { ...(await built.github.defaultBranchHead(repository)) };
          if (repository === 'o/r') {
            Object.defineProperty(head, 'message', { value: 42 });
          }
          return head;
        },
      } satisfies GitHubReader,
    }));
    expect(queue.failures).toEqual([
      expect.objectContaining({ defaultBranch: 'main', repository: 'o/r', unexpected: true }),
    ]);
    expect(new Set(named(queue).map((name) => name.split(' ')[0]))).toEqual(
      new Set(['o/s@2', 'o/r@4', 'o/r@5']),
    );
  });

  test.each([
    ['opening the default branch head', 'openPush', { defaultBranch: 'main' }],
    ['opening a pull request', 'openPullRequest', { pullRequest: 44 }],
  ] as const)(
    'a thrown value with no string form while %s is described by a fixed text',
    async (_label, dependency, scope) => {
      const { queue } = await poll(twoRepositories(), ['ada'], [], (built) => ({
        [dependency]: async (repository: string, at: never) => {
          if (dependency === 'openPush' || (at as PullRequestFacts).number === 44) {
            if (repository === 'o/r') {
              throw Object.create(null);
            }
          }
          return (built[dependency] as (repository: string, at: never) => Promise<CommitSource>)(
            repository,
            at,
          );
        },
      }));
      expect(queue.failures).toEqual([
        {
          cause: 'an error that cannot be described',
          repository: 'o/r',
          unexpected: true,
          ...scope,
        },
      ]);
    },
  );

  test('a thrown value with no string form in a repository-level read skips that repository', async () => {
    const { queue } = await poll(twoRepositories(), ['ada'], [], (built) => ({
      github: {
        ...built.github,
        openPullRequests: async (repository) => {
          if (repository === 'o/r') {
            throw Object.create(null);
          }
          return built.github.openPullRequests(repository);
        },
      } satisfies GitHubReader,
    }));
    expect(queue.failures).toEqual([
      { cause: 'an error that cannot be described', repository: 'o/r', unexpected: true },
    ]);
    expect(named(queue).map((name) => name.split(' ')[0])).toContain('o/s@2');
  });
});

/** The commits whose candidates the queue holds, as `repository@sha-digit`. */
const candidateCommits = (queue: Awaited<ReturnType<typeof poll>>['queue']) =>
  new Set(named(queue).map((name) => name.split(' ')[0]));

/** `value` passed off as whatever a dependency should return, as a broken dependency would. */
function malformed(value: unknown, key = 'value') {
  // A key typed as any string makes `Reflect.get` answer `any`, which no type check can refuse.
  return Reflect.get({ value }, key);
}

/** The world's GitHub reader, with `defaultBranchHead` for `o/r` answering `head`. */
function headOfOR(head: () => unknown) {
  return (built: PollDeps): Partial<PollDeps> => ({
    github: {
      ...built.github,
      defaultBranchHead: async (repository) =>
        repository === 'o/r' ? malformed(head()) : built.github.defaultBranchHead(repository),
    },
  });
}

describe('a poll is total: a malformed value from a dependency fails only its scope', () => {
  test.each([
    ['null', () => null],
    ['undefined', () => undefined],
    [
      'an object whose sha cannot be read',
      () => ({
        branch: 'main',
        message: 'Tidy',
        get sha(): string {
          throw new Error('no sha');
        },
      }),
    ],
    [
      'an object whose branch cannot be read',
      () => ({
        get branch(): string {
          throw new Error('no branch');
        },
        message: 'Tidy',
        sha: sha('1'),
      }),
    ],
    ['an object whose sha is not text', () => ({ branch: 'main', message: 'Tidy', sha: 7 })],
  ])('a default branch head that is %s fails its repository alone', async (_label, head) => {
    const { queue, snapshot } = await poll(twoRepositories(), ['ada'], [], headOfOR(head));
    expect(snapshot[0]).toMatchObject({ kind: 'failed', repository: 'o/r', unexpected: true });
    expect(queue.failures).toEqual([
      expect.objectContaining({ repository: 'o/r', unexpected: true }),
    ]);
    expect(candidateCommits(queue)).toEqual(new Set(['o/s@2']));
  });

  test('a listed pull request whose number cannot be read fails its repository alone', async () => {
    const { queue } = await poll(twoRepositories(), ['ada'], [], (built) => ({
      github: {
        ...built.github,
        openPullRequests: async (repository) => {
          const pulls = await built.github.openPullRequests(repository);
          if (repository !== 'o/r') {
            return pulls;
          }
          for (const pull of pulls.filter(({ number }) => number === 44)) {
            Object.defineProperty(pull, 'number', {
              get: () => {
                throw new Error('no number');
              },
            });
          }
          return pulls;
        },
      } satisfies GitHubReader,
    }));
    expect(queue.failures).toEqual([{ cause: 'no number', repository: 'o/r', unexpected: true }]);
    expect(candidateCommits(queue)).toEqual(new Set(['o/s@2']));
  });

  test.each([
    ['null', () => null],
    ['a plain object', () => ({ 'hugi / platform': 'success' })],
    ['a map with a state GitHub never reports', () => new Map([['hugi / platform', 'done']])],
    ['a map with a name that is not text', () => new Map([[7, 'success']])],
  ])(
    'commit statuses that are %s fail that commit alone, and the queue derives',
    async (_label, statuses) => {
      const { queue } = await poll(twoRepositories(), ['ada'], [], (built) => ({
        github: {
          ...built.github,
          commitStatuses: async (repository, commit) =>
            commit === sha('1')
              ? malformed(statuses())
              : built.github.commitStatuses(repository, commit),
        } satisfies GitHubReader,
      }));
      expect(queue.failures).toEqual([
        expect.objectContaining({ defaultBranch: 'main', repository: 'o/r', unexpected: true }),
      ]);
      expect(candidateCommits(queue)).toEqual(new Set(['o/s@2', 'o/r@4', 'o/r@5']));
    },
  );

  test("commit statuses that are null on a pull request's head fail that pull request alone", async () => {
    const { queue } = await poll(twoRepositories(), ['ada'], [], (built) => ({
      github: {
        ...built.github,
        commitStatuses: async (repository, commit) =>
          commit === sha('4') ? malformed(null) : built.github.commitStatuses(repository, commit),
      } satisfies GitHubReader,
    }));
    expect(queue.failures).toEqual([
      expect.objectContaining({ pullRequest: 44, repository: 'o/r', unexpected: true }),
    ]);
    expect(candidateCommits(queue)).toEqual(new Set(['o/r@1', 'o/s@2', 'o/r@5']));
  });
});

describe('a commit shared by two snapshots', () => {
  test('a conflicted pull request does not hold back a mergeable one with the same head', async () => {
    const { queue } = await poll(
      pullsWorld([
        { author: 'ada', head: sha('4'), merge: 'conflict', number: 1 },
        { author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 2 },
      ]),
    );
    expect(queue.candidates.length).toBeGreaterThan(0);
    expect(
      new Set(
        queue.candidates.map((candidate) =>
          candidate.event.kind === 'pull_request' ? candidate.event.pullRequest.number : 0,
        ),
      ),
    ).toEqual(new Set([2]));
  });

  test('a default branch head whose read failed leaves its commit to a pull request with that head', async () => {
    const { queue } = await poll({
      commits: { [sha('8')]: { changed: ['docs/index.md'], files: DECLARED } },
      repos: [
        {
          head: sha('4'),
          name: 'o/r',
          pulls: [{ author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 }],
        },
      ],
    });
    expect(queue.failures).toEqual([expect.objectContaining({ defaultBranch: 'main' })]);
    expect(queue.candidates.length).toBeGreaterThan(0);
    expect(queue.candidates.every((candidate) => candidate.event.kind === 'pull_request')).toBe(
      true,
    );
  });
});

test('a declared workflow path that is a directory refuses the declaration and polls on', async () => {
  const { queue } = await poll({
    commits: {
      [sha('1')]: { files: { ...DECLARED, '.github/workflows/docs.yml': DIRECTORY } },
    },
    repos: [{ head: sha('1'), name: 'o/r' }],
  });
  expect(queue.failures).toEqual([]);
  expect(queue.declarationReports).toEqual([
    {
      cause: expect.stringContaining('docs.yml does not exist at the commit'),
      commit: sha('1'),
      repository: 'o/r',
    },
  ]);
});

test('three admitted pull requests all yield candidates', async () => {
  const { queue } = await poll(
    pullsWorld([
      { author: 'ada', head: sha('4'), merge: { sha: sha('8') }, number: 44 },
      { author: 'ada', head: sha('5'), merge: { sha: sha('8') }, number: 45 },
      { author: 'ada', head: sha('6'), merge: { sha: sha('8') }, number: 46 },
    ]),
  );
  expect(named(queue).filter((name) => name.endsWith('platform'))).toEqual([
    'o/r@4 hugi / platform',
    'o/r@5 hugi / platform',
    'o/r@6 hugi / platform',
  ]);
});

describe("a commit's reads", () => {
  test('read the changed files at most once, however many workflows filter by path', async () => {
    const { changed, queue } = await poll({
      commits: {
        [sha('1')]: {
          changed: ['docs/index.md'],
          files: {
            '.github/hugi.yaml': stringify({
              lanes: ['a', 'b', 'c'].map((job) => ({ jobs: [job], workflow: `${job}.yml` })),
            }),
            ...Object.fromEntries(
              ['a', 'b', 'c'].map((job) => [`.github/workflows/${job}.yml`, pathFiltered(job)]),
            ),
          },
        },
      },
      repos: [{ head: sha('1'), name: 'o/r' }],
    });
    expect(named(queue)).toHaveLength(3);
    expect(changed).toEqual([sha('1')]);
  });

  test('read, parse, and trigger each workflow once, however many lanes it holds', async () => {
    const loads = spyOn(laneParse, 'loadWorkflow');
    const starts = spyOn(trigger, 'workflowStarts');
    try {
      const { queue, reads } = await poll({
        commits: { [sha('1')]: { files: DECLARED } },
        repos: [{ head: sha('1'), name: 'o/r' }],
      });
      expect(named(queue)).toHaveLength(4);
      expect(reads.toSorted()).toEqual(Object.keys(DECLARED).toSorted());
      // Once in the declaration reader and once to decide the lanes, for each of the two workflows.
      expect(loads).toHaveBeenCalledTimes(4);
      expect(starts).toHaveBeenCalledTimes(2);
    } finally {
      loads.mockRestore();
      starts.mockRestore();
    }
  });

  test.each([
    ['in another job', false],
    ['in the declared job itself', true],
  ])(
    'of a large workflow with 256 declared lanes, its bulk %s, take well under a second',
    async (_label, inDeclaredJob) => {
      const rows = Array.from({ length: 256 }, (_, index) => index);
      // Steps whose plan is costly to build: each has an if: and expressions to expand, so
      // building every lane's plan, rather than deciding its if: alone, takes about a second.
      const padding = Array.from({ length: 2000 }, (_, index) => ({
        env: { N: '${{ matrix.n }}' },
        if: "github.event_name == 'push'",
        name: `pad ${index} \${{ matrix.n }}`,
        run: `echo \${{ matrix.n }} ${'x'.repeat(200)}`,
      }));
      const build = {
        'runs-on': 'macos-latest',
        steps: [{ run: 'echo ${{ matrix.n }}' }, ...(inDeclaredJob ? padding : [])],
        strategy: { matrix: { n: rows } },
      };
      const large = stringify({
        jobs: {
          build,
          ...(inDeclaredJob ? {} : { pad: { 'runs-on': 'ubuntu-latest', steps: padding } }),
        },
        on: { pull_request: null, push: { branches: ['main'] } },
      });
      expect(large.length).toBeGreaterThan(600 * 1024);
      const started = performance.now();
      const { queue } = await poll({
        commits: {
          [sha('1')]: {
            files: {
              '.github/hugi.yaml': stringify({ lanes: [{ jobs: ['build'], workflow: 'ci.yml' }] }),
              '.github/workflows/ci.yml': large,
            },
          },
        },
        repos: [{ head: sha('1'), name: 'o/r' }],
      });
      const elapsed = performance.now() - started;
      expect(queue.candidates).toHaveLength(256);
      expect(elapsed).toBeLessThan(500);
    },
  );
});
