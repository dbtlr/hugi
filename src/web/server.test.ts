import { afterEach, expect, test } from 'bun:test';
import { connect } from 'node:net';

import { rejectionOf } from '../runs/testing';
import type { RunPageListener } from '../service/start';
import type { RunPageData } from './run-data';
import { openRunPageServer } from './server';

const ID = '2026-11-19T100000Z-aaaaaaaaa-abc123';
const open: RunPageListener[] = [];

afterEach(() => {
  for (const listener of open.splice(0)) {
    listener.close();
  }
});

async function start(
  loadRun: (runId: string) => Promise<RunPageData>,
  port = 0,
  errors: string[] = [],
) {
  const listener = await openRunPageServer({
    loadRun,
    log: { error: (message) => void errors.push(message) },
    now: () => new Date(),
    origin: 'https://hugi.example.ts.net',
    port,
  });
  open.push(listener);
  return listener;
}

test('the page listens on 127.0.0.1 and answers a run path', async () => {
  const listener = await start(async () => ({ kind: 'not-found' }));
  expect(listener.hostname).toBe('127.0.0.1');
  const response = await fetch(`http://127.0.0.1:${listener.port}/runs/${ID}`);
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('a port another listener holds cannot be opened', async () => {
  const first = await start(async () => ({ kind: 'not-found' }));
  const refusal = await rejectionOf(start(async () => ({ kind: 'not-found' }), first.port));
  expect(refusal.message).toContain('in use');
});

test('closing drops an open connection instead of waiting for it', async () => {
  const inFlight = Promise.withResolvers<void>();
  const listener = await start(async () => {
    inFlight.resolve();
    // The run is never read, so only closing can end the request.
    return Promise.withResolvers<RunPageData>().promise;
  });
  const pending = (async () => {
    try {
      await fetch(`http://127.0.0.1:${listener.port}/runs/${ID}`);
      return 'answered';
    } catch {
      return 'dropped';
    }
  })();
  await inFlight.promise;
  listener.close();
  expect(await pending).toBe('dropped');
});

/** Send `text` as it is to the listener and resolve with the status line it answers. */
function statusLineOf(port: number, text: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  let answer = '';
  const socket = connect(port, '127.0.0.1', () => void socket.end(text));
  socket.on('data', (chunk) => {
    answer += chunk.toString();
  });
  socket.on('close', () => resolve(answer.split('\r\n')[0] ?? ''));
  return promise;
}

test.each([
  ['a Host with a space', 'GET /runs/x HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n', 421],
  ['a Host with a slash', 'GET /runs/x HTTP/1.1\r\nHost: x/y\r\nConnection: close\r\n\r\n', 421],
  ['an HTTP/1.0 request with no Host', 'GET /runs/x HTTP/1.0\r\n\r\n', 421],
  ['a CONNECT to the page itself', 'CONNECT PAGE HTTP/1.1\r\nHost: PAGE\r\nConnection: close\r\n\r\n', 404],
])('%s is answered without a logged error', async (_name, text, status) => {
  const errors: string[] = [];
  const listener = await start(async () => ({ kind: 'not-found' }), 0, errors);
  const line = await statusLineOf(
    listener.port,
    text.replaceAll('PAGE', `127.0.0.1:${listener.port}`),
  );
  expect(line).toStartWith(`HTTP/1.1 ${status} `);
  expect(errors).toEqual([]);
});
