import { describe, expect, test } from 'bun:test';

import { messageOf } from '../errors';
import type { LaneRef } from '../lane/step-plan';
import { GitHubAppError } from './app-auth';
import type { Fetch } from './pull-request';
import {
  createStatusReporter,
  DESCRIPTION_LIMIT,
  describeStatus,
  StatusPostError,
} from './statuses';

const REPO = 'example/project';
const SHA = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const WORKFLOW = '.github/workflows/ci.yml';

const BUILD: LaneRef = { job: 'build', matrix: {}, workflow: WORKFLOW };
const TEST_ROW: LaneRef = {
  job: 'test',
  matrix: { os: 'macos-15', xcode: 16 },
  workflow: WORKFLOW,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('not a mapping');
  }
  return Object.fromEntries(Object.entries(value));
}

/** The StatusPostError a promise rejects with. */
async function failureOf(promise: Promise<unknown>): Promise<StatusPostError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StatusPostError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a StatusPostError');
}

/** The length in characters, a surrogate pair counting as one. */
function characters(text: string): number {
  return text.match(/./gsu)?.length ?? 0;
}

type Post = { url: string; method: string; authorization: string; body: Record<string, unknown> };

function recorder(answer: () => Response = () => Response.json({}, { status: 201 })) {
  const posts: Post[] = [];
  const invalidated: string[] = [];
  const fetch: Fetch = async (url, init) => {
    posts.push({
      authorization: init.headers.Authorization ?? '',
      body: asRecord(JSON.parse(init.body ?? '{}')),
      method: init.method ?? 'GET',
      url,
    });
    return answer();
  };
  const reporter = createStatusReporter({
    fetch,
    invalidate: (repository) => invalidated.push(repository),
    token: (repository) => async () => `token-for-${repository}`,
  });
  return { invalidated, posts, reporter };
}

test('the description limit is the 140 characters GitHub accepts', () => {
  expect(DESCRIPTION_LIMIT).toBe(140);
});

describe('posting a lane status', () => {
  test('pending, success and failure go to the commit under the lane name', async () => {
    const { posts, reporter } = recorder();
    const target = { repository: REPO, sha: SHA };
    await reporter.reportLane(target, BUILD, { state: 'pending' });
    await reporter.reportLane(target, BUILD, {
      state: 'success',
      targetUrl: 'https://logs.example/1',
    });
    await reporter.reportLane(target, BUILD, { cause: 'step "Test" exited 1', state: 'failure' });
    expect(posts.map((post) => `${post.method} ${post.url}`)).toEqual(
      Array(3).fill(`POST https://api.github.com/repos/${REPO}/statuses/${SHA}`),
    );
    expect(posts.map((post) => post.authorization)).toEqual(
      Array(3).fill(`Bearer token-for-${REPO}`),
    );
    expect(posts.map((post) => post.body)).toEqual([
      { context: 'hugi / build', description: 'Running', state: 'pending' },
      {
        context: 'hugi / build',
        description: 'Passed',
        state: 'success',
        target_url: 'https://logs.example/1',
      },
      { context: 'hugi / build', description: 'Failed: step "Test" exited 1', state: 'failure' },
    ]);
  });

  test('a matrix row is named by its values', async () => {
    const { posts, reporter } = recorder();
    await reporter.reportLane({ repository: REPO, sha: SHA }, TEST_ROW, { state: 'pending' });
    expect(posts[0]!.body.context).toBe('hugi / test (macos-15, 16)');
  });

  test('a pull request lane goes on the head sha and records the merge commit', async () => {
    const { posts, reporter } = recorder();
    await reporter.reportLane({ mergeSha: MERGE, repository: REPO, sha: SHA }, BUILD, {
      state: 'success',
    });
    expect(posts[0]!.url).toBe(`https://api.github.com/repos/${REPO}/statuses/${SHA}`);
    expect(posts[0]!.body.description).toBe('Passed (merge bbbbbbbbbbbb)');
  });
});

describe('posting a refused declaration', () => {
  test('is one failure named hugi with the cause', async () => {
    const { posts, reporter } = recorder();
    await reporter.reportRefusal({ repository: REPO, sha: SHA }, 'job "x" is not in ci.yml');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      context: 'hugi',
      description: 'Declaration refused: job "x" is not in ci.yml',
      state: 'failure',
    });
  });
});

describe('descriptions', () => {
  test('a long cause is cut to the limit and keeps the merge sha', () => {
    const text = describeStatus({ cause: 'x'.repeat(500), mergeSha: MERGE, state: 'failure' });
    expect(characters(text)).toBe(DESCRIPTION_LIMIT);
    expect(text.endsWith('… (merge bbbbbbbbbbbb)')).toBe(true);
    expect(text.startsWith('Failed: xxx')).toBe(true);
  });

  test('a cause exactly filling the room is not cut', () => {
    const room = DESCRIPTION_LIMIT - 'Failed: '.length;
    const text = describeStatus({ cause: 'y'.repeat(room), state: 'failure' });
    expect(text).toBe(`Failed: ${'y'.repeat(room)}`);
    expect(describeStatus({ cause: 'y'.repeat(room + 1), state: 'failure' })).toHaveLength(
      DESCRIPTION_LIMIT,
    );
  });

  test('replaces a character outside the BMP, which GitHub refuses, in the cause and the headline', () => {
    const text = describeStatus({
      cause: 'boom 😀 𝐀',
      headline: 'Refused 😀',
      mergeSha: MERGE,
      state: 'failure',
    });
    expect(text).toBe('Refused \uFFFD: boom \uFFFD \uFFFD (merge bbbbbbbbbbbb)');
  });

  test('a description of non-BMP characters is at most 140 UTF-16 units, with no surrogate', () => {
    const text = describeStatus({ cause: '😀'.repeat(300), mergeSha: MERGE, state: 'failure' });
    expect(text.length).toBe(DESCRIPTION_LIMIT);
    expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  test('a long headline gives way, so the merge sha is always kept', () => {
    const text = describeStatus({
      cause: 'x',
      headline: 'H'.repeat(500),
      mergeSha: MERGE,
      state: 'failure',
    });
    expect(text).toBe(`${'H'.repeat(39)}…: x (merge bbbbbbbbbbbb)`);
    expect(describeStatus({ headline: 'H'.repeat(500), mergeSha: MERGE, state: 'failure' })).toBe(
      `${'H'.repeat(39)}… (merge bbbbbbbbbbbb)`,
    );
  });

  test('collapses whitespace and newlines in the cause', () => {
    expect(describeStatus({ cause: 'a\n\n  b\tc', state: 'failure' })).toBe('Failed: a b c');
  });

  test('a blank cause adds nothing', () => {
    expect(describeStatus({ cause: ' \n', state: 'failure' })).toBe('Failed');
  });
});

describe('a failed post', () => {
  test('is one typed error naming the repository and endpoint', async () => {
    const { reporter } = recorder(
      () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 }),
    );
    const error = await failureOf(
      reporter.reportLane({ repository: REPO, sha: SHA }, BUILD, { state: 'pending' }),
    );
    expect(error.repository).toBe(REPO);
    expect(error.endpoint).toBe(`POST /repos/${REPO}/statuses/${SHA}`);
    expect(error.message).toContain('403');
    expect(error.message).toContain('Resource not accessible by integration');
  });

  test('a network failure is the same typed error', async () => {
    const reporter = createStatusReporter({
      fetch: async () => {
        throw new Error('connection reset');
      },
      invalidate: () => undefined,
      token: () => async () => 't',
    });
    const error = await failureOf(reporter.reportRefusal({ repository: REPO, sha: SHA }, 'bad'));
    expect(error.message).toContain('connection reset');
  });

  test('a token that cannot be minted is the same typed error', async () => {
    const reporter = createStatusReporter({
      fetch: async () => Response.json({}),
      invalidate: () => undefined,
      token: () => async () => {
        throw new Error('no key');
      },
    });
    const error = await failureOf(
      reporter.reportLane({ repository: REPO, sha: SHA }, BUILD, { state: 'pending' }),
    );
    expect(error.message).toContain('no key');
    expect(messageOf(error.cause)).toBe('no key');
    expect(error.status).toBeUndefined();
  });

  test('a token failure from GitHub keeps its status', async () => {
    const reporter = createStatusReporter({
      fetch: async () => Response.json({}),
      invalidate: () => undefined,
      token: (repository) => async () => {
        throw new GitHubAppError(repository, 'GET /x', 'not installed', { status: 404 });
      },
    });
    const error = await failureOf(
      reporter.reportLane({ repository: REPO, sha: SHA }, BUILD, { state: 'pending' }),
    );
    expect(error.status).toBe(404);
    expect(error.cause).toBeInstanceOf(GitHubAppError);
  });

  test.each([401, 403, 422, 500])(
    'a refused post keeps GitHub status %d, and only a 401 drops the cached token',
    async (status) => {
      const { invalidated, reporter } = recorder(() => new Response('{}', { status }));
      const error = await failureOf(
        reporter.reportLane({ repository: REPO, sha: SHA }, BUILD, { state: 'pending' }),
      );
      expect(error.status).toBe(status);
      expect(invalidated).toEqual(status === 401 ? [REPO] : []);
    },
  );

  test('a network failure keeps its error as the cause and has no status', async () => {
    const reporter = createStatusReporter({
      fetch: async () => {
        throw new Error('connection reset');
      },
      invalidate: () => undefined,
      token: () => async () => 't',
    });
    const error = await failureOf(reporter.reportRefusal({ repository: REPO, sha: SHA }, 'bad'));
    expect(error.status).toBeUndefined();
    expect(messageOf(error.cause)).toBe('connection reset');
  });

  test('a sha that is not a full sha is refused before any request', async () => {
    const { posts, reporter } = recorder();
    const error = await failureOf(
      reporter.reportLane({ repository: REPO, sha: 'abc123' }, BUILD, { state: 'pending' }),
    );
    expect(error.message).toContain('not a full commit sha');
    expect(posts).toHaveLength(0);
  });
});
