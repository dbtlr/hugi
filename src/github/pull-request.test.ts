import { expect, test } from 'bun:test';

import { messageOf } from '../errors';
import { PullRequestReadError, readPullRequest } from './pull-request';
import type { Fetch } from './pull-request';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);

/** The fields Hugi reads from GitHub's single-pull-request response, plus one it ignores. */
const BODY = {
  base: { ref: 'main', sha: 'c'.repeat(40) },
  head: { label: 'someone:feature', ref: 'feature', sha: HEAD },
  merge_commit_sha: MERGE,
  mergeable: true,
  number: 7,
  state: 'open',
  title: 'Add a feature',
};

type Call = { readonly url: string; readonly headers: Readonly<Record<string, string>> };

/** A fetch that records each call and answers with `status` and `body`. */
function serving(status: number, body: unknown = BODY) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ headers: init.headers, url });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, fetch };
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

test('a pull request is read anonymously from the single-pull-request endpoint', async () => {
  const { calls, fetch } = serving(200);
  await readPullRequest('example/project', 7, fetch);
  expect(calls).toEqual([
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'hugi',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      url: 'https://api.github.com/repos/example/project/pulls/7',
    },
  ]);
});

test('the facts are the state, the merge, and the head and base, with the head branch unowned', async () => {
  const { fetch } = serving(200);
  expect(await readPullRequest('example/project', 7, fetch)).toEqual({
    baseRef: 'main',
    headRef: 'feature',
    headSha: HEAD,
    mergeCommitSha: MERGE,
    mergeable: true,
    number: 7,
    state: 'open',
  });
});

test('a merge GitHub has not computed reads as null mergeable and no merge commit', async () => {
  const { fetch } = serving(200, { ...BODY, merge_commit_sha: null, mergeable: null });
  expect(await readPullRequest('example/project', 7, fetch)).toMatchObject({
    mergeCommitSha: null,
    mergeable: null,
  });
});

test.each([
  [404, /pull request 7 does not exist in example\/project/u],
  [403, /GitHub's anonymous rate limit/u],
  [429, /GitHub's anonymous rate limit/u],
  [500, /GitHub's API answered 500/u],
])('an answer of %i is a read error that names the cause', async (status, message) => {
  const { fetch } = serving(status, { message: 'whatever' });
  const failure = await failureOf(readPullRequest('example/project', 7, fetch));
  expect(failure).toBeInstanceOf(PullRequestReadError);
  expect(messageOf(failure)).toMatch(message);
});

const unreachable: Fetch = async () => {
  throw new TypeError('getaddrinfo ENOTFOUND api.github.com');
};

test('a network failure is a read error that names it', async () => {
  const failure = await failureOf(readPullRequest('example/project', 7, unreachable));
  expect(failure).toBeInstanceOf(PullRequestReadError);
  expect(messageOf(failure)).toContain('ENOTFOUND');
});

test.each([
  ['a body that is not JSON', '<html>'],
  ['a missing head', { ...BODY, head: undefined }],
  ['a head sha that is not a full sha', { ...BODY, head: { ...BODY.head, sha: 'abc' } }],
  ['a mergeable that is not true, false, or null', { ...BODY, mergeable: 'yes' }],
  ['a merge commit sha that is a number', { ...BODY, merge_commit_sha: 7 }],
  ['an unknown state', { ...BODY, state: 'merged' }],
  ['another pull request', { ...BODY, number: 8 }],
])('%s is a malformed answer', async (_name, body) => {
  const { fetch } = serving(200, body);
  const failure = await failureOf(readPullRequest('example/project', 7, fetch));
  expect(failure).toBeInstanceOf(PullRequestReadError);
  expect(messageOf(failure)).toContain('malformed');
});
