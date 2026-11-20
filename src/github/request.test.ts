import { describe, expect, test } from 'bun:test';

import type { Fetch } from './pull-request';
import { requestJson } from './request';

class TestError extends Error {
  override readonly name = 'TestError';
  readonly status: number | undefined;
  constructor(message: string, detail: { status?: number } = {}) {
    super(message);
    this.status = detail.status;
  }
}

function call(fetch: Fetch, timeoutMs = 30) {
  return requestJson({
    bearer: 't',
    fail: (message, detail) => new TestError(message, detail),
    fetch,
    method: 'GET',
    path: '/x',
    timeoutMs,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<TestError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TestError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a TestError');
}

/** Never answers unless its signal aborts. */
const hangs: Fetch = (_url, init) => {
  const { promise, reject } = Promise.withResolvers<Response>();
  init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  return promise;
};

/** Answers at once, but its body never ends unless the signal aborts. */
const stalls: Fetch = async (_url, init) =>
  new Response(
    new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    }),
  );

describe('a request that takes too long', () => {
  test('is aborted through the fetch signal and reported as a timeout', async () => {
    const error = await failureOf(call(hangs));
    expect(error.message).toContain('did not answer within');
    expect(error.status).toBeUndefined();
  });

  test('a body that stalls is a timeout, not a malformed answer', async () => {
    const error = await failureOf(call(stalls));
    expect(error.message).toContain('did not answer within');
    expect(error.message).not.toContain('malformed');
  });
});

describe('a refused request', () => {
  test('keeps GitHub status as a field, not only in the message', async () => {
    const error = await failureOf(
      call(async () => new Response('{"message":"nope"}', { status: 422 })),
    );
    expect(error.status).toBe(422);
    expect(error.message).toContain('422');
  });

  test('a success whose body cannot be read keeps the status GitHub answered with', async () => {
    const error = await failureOf(call(async () => new Response('{"tok', { status: 201 })));
    expect(error.status).toBe(201);
    expect(error.message).toContain('malformed');
  });

  test('a network failure has no status', async () => {
    const error = await failureOf(
      call(async () => {
        throw new Error('reset');
      }),
    );
    expect(error.status).toBeUndefined();
  });
});
