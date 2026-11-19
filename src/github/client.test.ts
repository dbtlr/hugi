import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { join } from 'node:path';

import { createGitHubReader, GitHubReadError } from './client';
import type { Fetch } from './pull-request';

/** A recorded GitHub API response from `fixtures/`, as JSON text. */
function recorded(name: string): Promise<string> {
  return Bun.file(join(import.meta.dir, 'fixtures', `${name}.json`)).text();
}

const API = 'https://api.github.com';
const REPO = 'example/project';
const TOKEN = 'ghs_fixedinstallationtoken';

type Answer = { status?: number; body: string; headers?: Record<string, string> };
type Call = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** A fetch that answers each URL from `routes` and records every call; an unknown URL is a 404. */
function serving(routes: Record<string, Answer>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ headers: init.headers, url });
    const answer = routes[url] ?? { body: '{"message":"Not Found"}', status: 404 };
    return new Response(answer.body, { headers: answer.headers, status: answer.status ?? 200 });
  };
  return { calls, fetch };
}

function reader(fetch: Fetch, timeoutMs?: number) {
  return createGitHubReader({
    fetch,
    token: async () => TOKEN,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function failureOf(promise: Promise<unknown>): Promise<GitHubReadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GitHubReadError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a GitHubReadError');
}

const PULLS = `${API}/repos/${REPO}/pulls?state=open&per_page=100`;
const PULLS_2 = `${API}/repositories/812345678/pulls?state=open&per_page=100&page=2`;
const STATUS = `${API}/repos/${REPO}/commits/${'4'.repeat(40)}/status?per_page=100`;
const STATUS_2 = `${API}/repositories/812345678/commits/${'4'.repeat(40)}/status?per_page=100&page=2`;

describe('the default branch head', () => {
  test('is read from the repository and its branch, with the installation token', async () => {
    const { calls, fetch } = serving({
      [`${API}/repos/${REPO}`]: { body: await recorded('repository') },
      [`${API}/repos/${REPO}/branches/main`]: { body: await recorded('branch-main') },
    });
    expect(await reader(fetch).defaultBranchHead(REPO)).toEqual({
      branch: 'main',
      message: 'Merge pull request #41 from example/tidy\n\nTidy the build',
      sha: '1'.repeat(40),
    });
    expect(calls.map((call) => call.url)).toEqual([
      `${API}/repos/${REPO}`,
      `${API}/repos/${REPO}/branches/main`,
    ]);
    expect(calls[0]!.headers).toEqual({
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${TOKEN}`,
      'User-Agent': 'hugi',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  test('a branch name is escaped into the path', async () => {
    const { calls, fetch } = serving({
      [`${API}/repos/${REPO}`]: { body: JSON.stringify({ default_branch: 'release/1.x' }) },
    });
    await failureOf(reader(fetch).defaultBranchHead(REPO));
    expect(calls[1]!.url).toBe(`${API}/repos/${REPO}/branches/release%2F1.x`);
  });
});

describe('open pull requests', () => {
  test('follow the Link header across pages', async () => {
    const { fetch } = serving({
      [PULLS]: {
        body: await recorded('pulls-page-1'),
        headers: { link: `<${PULLS_2}>; rel="next", <${PULLS_2}>; rel="last"` },
      },
      [PULLS_2]: {
        body: await recorded('pulls-page-2'),
        headers: { link: `<${PULLS}>; rel="prev", <${PULLS}>; rel="first"` },
      },
    });
    expect(await reader(fetch).openPullRequests(REPO)).toEqual([
      {
        authorLogin: 'Ada',
        baseRef: 'main',
        headRef: 'cache',
        headSha: '4'.repeat(40),
        number: 44,
      },
      {
        authorLogin: 'mallory',
        baseRef: 'main',
        headRef: 'main',
        headSha: '42'.repeat(20),
        number: 42,
      },
      // A deleted account leaves a null user.
      { authorLogin: null, baseRef: 'release', headRef: 'old', headSha: '7'.repeat(40), number: 7 },
    ]);
  });

  test('a next link off the API is refused, so the token never leaves GitHub', async () => {
    const { calls, fetch } = serving({
      [PULLS]: { body: '[]', headers: { link: '<https://evil.example/steal>; rel="next"' } },
    });
    const failure = await failureOf(reader(fetch).openPullRequests(REPO));
    expect(failure.message).toContain('malformed');
    expect(calls).toHaveLength(1);
  });

  test('a listing that pages without end is cut off with an error', async () => {
    const { calls, fetch } = serving({
      [PULLS]: { body: '[]', headers: { link: `<${PULLS}>; rel="next"` } },
    });
    const failure = await failureOf(reader(fetch).openPullRequests(REPO));
    expect(failure.message).toContain('more than');
    expect(calls.length).toBeGreaterThan(1);
  });

  test('an entry without a full head sha is malformed', async () => {
    const { fetch } = serving({
      [PULLS]: {
        body: JSON.stringify([
          { base: { ref: 'main' }, head: { ref: 'x', sha: 'abc' }, number: 1, user: null },
        ]),
      },
    });
    const failure = await failureOf(reader(fetch).openPullRequests(REPO));
    expect(failure.message).toContain('is malformed');
  });
});

describe('one pull request', () => {
  test("is read into the facts ADR-0005 checks, with the pull-request reader's parser", async () => {
    const { fetch } = serving({
      [`${API}/repos/${REPO}/pulls/44`]: { body: await recorded('pull-44') },
    });
    expect(await reader(fetch).pullRequest(REPO, 44)).toEqual({
      baseRef: 'main',
      headRef: 'cache',
      headSha: '4'.repeat(40),
      mergeCommitSha: `44${'0'.repeat(36)}44`,
      mergeable: true,
      number: 44,
      state: 'open',
    });
  });

  test('a body for another pull request is malformed', async () => {
    const { fetch } = serving({
      [`${API}/repos/${REPO}/pulls/45`]: { body: await recorded('pull-44') },
    });
    const failure = await failureOf(reader(fetch).pullRequest(REPO, 45));
    expect(failure.message).toContain('describes pull request 44');
  });
});

test("a commit's message is read from the git commit endpoint", async () => {
  const sha = '4'.repeat(40);
  const { fetch } = serving({
    [`${API}/repos/${REPO}/git/commits/${sha}`]: { body: await recorded('git-commit-44') },
  });
  expect(await reader(fetch).commitMessage(REPO, sha)).toBe(
    'Add a cache\n\nKeep fetched objects between runs.',
  );
});

describe("a commit's statuses", () => {
  test('are the combined status across pages, by context', async () => {
    const { fetch } = serving({
      [STATUS]: {
        body: await recorded('status-page-1'),
        headers: { link: `<${STATUS_2}>; rel="next"` },
      },
      [STATUS_2]: { body: await recorded('status-page-2') },
    });
    const statuses = await reader(fetch).commitStatuses(REPO, '4'.repeat(40));
    expect(Object.fromEntries(statuses)).toEqual({
      'ci/legacy': 'error',
      'hugi / platform': 'success',
      'hugi / test (macos-latest)': 'pending',
    });
  });

  test('keep the first, most recent, state of a context listed twice', async () => {
    const statuses = [
      { context: 'hugi / platform', state: 'failure' },
      { context: 'hugi / platform', state: 'pending' },
    ];
    const { fetch } = serving({ [STATUS]: { body: JSON.stringify({ statuses }) } });
    const read = await reader(fetch).commitStatuses(REPO, '4'.repeat(40));
    expect(read.get('hugi / platform')).toBe('failure');
  });

  test('a state GitHub does not document is malformed', async () => {
    const statuses = [{ context: 'hugi / platform', state: 'queued' }];
    const { fetch } = serving({ [STATUS]: { body: JSON.stringify({ statuses }) } });
    const failure = await failureOf(reader(fetch).commitStatuses(REPO, '4'.repeat(40)));
    expect(failure.message).toContain('is malformed');
  });
});

describe('a failed read is one error naming the repository and endpoint', () => {
  const endpoint = `GET /repos/${REPO}`;

  async function failing(answer: Answer | Fetch) {
    const fetch =
      typeof answer === 'function' ? answer : serving({ [`${API}/repos/${REPO}`]: answer }).fetch;
    return failureOf(reader(fetch, 50).defaultBranchHead(REPO));
  }

  test('an answer that is not 2xx', async () => {
    const failure = await failing({ body: '{}', status: 502 });
    expect(failure.repository).toBe(REPO);
    expect(failure.endpoint).toBe(endpoint);
    expect(failure.message).toBe(`GitHub's API answered 502 for ${endpoint}.`);
  });

  test.each([
    [429, {}],
    [403, { 'x-ratelimit-remaining': '0' }],
  ])('a used-up rate limit (%i), in the installation token’s words', async (status, headers) => {
    const failure = await failing({ body: '{}', headers, status });
    expect(failure.message).toBe(
      `The rate limit of Hugi's GitHub installation token is used up (status ${status}) at ${endpoint}; the repository is read again at a later poll.`,
    );
  });

  test('a 403 with requests left is not a rate limit', async () => {
    const failure = await failing({
      body: '{}',
      headers: { 'x-ratelimit-remaining': '4999' },
      status: 403,
    });
    expect(failure.message).toBe(`GitHub's API answered 403 for ${endpoint}.`);
  });

  test('a network failure', async () => {
    const failure = await failing(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    });
    expect(failure.message).toBe(
      `Cannot reach GitHub's API for ${endpoint}: getaddrinfo ENOTFOUND api.github.com`,
    );
  });

  test('an API that never answers times out', async () => {
    const failure = await failing(async (_url, init) => {
      await once(init.signal, 'abort');
      throw init.signal.reason;
    });
    expect(failure.message).toBe(`GitHub's API did not answer within 0.05 s for ${endpoint}.`);
  });

  test('a body that stalls past the time limit times out', async () => {
    const failure = await failing(async (_url, init) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"default_'));
          init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
        },
      });
      return new Response(body, { status: 200 });
    });
    expect(failure.message).toBe(`GitHub's API did not answer within 0.05 s for ${endpoint}.`);
  });

  test('a body that is not JSON', async () => {
    const failure = await failing({ body: '<html>' });
    expect(failure.message).toStartWith(`GitHub's answer for ${endpoint} is malformed: `);
  });

  test('a body without the documented field', async () => {
    const failure = await failing({ body: '{"name":"project"}' });
    expect(failure.message).toBe(
      `GitHub's answer for ${endpoint} is malformed: it has no default_branch.`,
    );
  });

  test('a token that cannot be had', async () => {
    const { calls, fetch } = serving({});
    const failure = await failureOf(
      createGitHubReader({
        fetch,
        token: async () => {
          throw new Error('the app key is missing');
        },
      }).defaultBranchHead(REPO),
    );
    expect(failure.message).toBe(
      `Cannot get a GitHub token for ${endpoint}: the app key is missing`,
    );
    expect(calls).toHaveLength(0);
  });
});
