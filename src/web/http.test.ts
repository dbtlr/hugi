import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeRunRecord } from '../runs/record';
import { sampleRecord, sampleRunningRecord } from '../runs/testing';
import { answerRunPageRequest, CONTENT_SECURITY_POLICY } from './http';
import type { RunPageContext } from './http';
import { loadRunPage } from './run-data';

const ID = '2026-11-19T100000Z-aaaaaaaaa-abc123';
const PORT = 8470;
const ORIGIN = 'https://hugi.example.ts.net';
const STARTED = Date.parse('2026-11-19T10:00:00.000Z');

let root: string;
let runsDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hugi-web-http-'));
  runsDir = join(root, 'runs');
  await mkdir(join(runsDir, ID), { recursive: true });
  await writeRunRecord(join(runsDir, ID), sampleRecord({ detail: 'step 1 (Build) exited 3' }));
  await writeFile(join(runsDir, ID, '01-build.log'), 'compiling\nerror: boom\n');
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

type Harness = { context: RunPageContext; loads: string[]; errors: string[] };

function harness(overrides: Partial<RunPageContext> = {}): Harness {
  const loads: string[] = [];
  const errors: string[] = [];
  const context: RunPageContext = {
    loadRun: async (runId) => {
      loads.push(runId);
      return loadRunPage(runsDir, runId);
    },
    log: { error: (message) => void errors.push(message) },
    now: () => new Date(STARTED + 60_000),
    origin: ORIGIN,
    port: PORT,
    ...overrides,
  };
  return { context, errors, loads };
}

function request(path: string, init: { method?: string; host?: string } = {}): Request {
  return new Request(`http://127.0.0.1:${PORT}${path}`, {
    headers: { host: init.host ?? `127.0.0.1:${PORT}` },
    method: init.method ?? 'GET',
  });
}

describe('routing', () => {
  test('a run path answers its page', async () => {
    const { context } = harness();
    const response = await answerRunPageRequest(request(`/runs/${ID}`), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Step 1 (Build) exited 3.');
  });

  test('a query string is ignored', async () => {
    const { context } = harness();
    expect((await answerRunPageRequest(request(`/runs/${ID}?x=1`), context)).status).toBe(200);
  });

  test.each([
    ['the root', '/'],
    ['the runs list', '/runs'],
    ['a trailing slash', `/runs/${ID}/`],
    ['a step log path', `/runs/${ID}/01-build.log`],
    ['a prefix of an id', '/runs/2026-11-19T100000Z'],
    ['an id that is not a run directory name', '/runs/not-a-run'],
    ['a parent directory', '/runs/..'],
    ['an encoded slash', `/runs/${ID}%2F01-build.log`],
  ])('%s is 404 before anything on disk is read', async (_name, path) => {
    const { context, loads } = harness();
    const response = await answerRunPageRequest(request(path), context);
    expect(response.status).toBe(404);
    expect(loads).toEqual([]);
  });

  test('an id of the right form with no run is 404', async () => {
    const { context, loads } = harness();
    const other = '2026-11-19T100000Z-bbbbbbbbb-zzz999';
    expect((await answerRunPageRequest(request(`/runs/${other}`), context)).status).toBe(404);
    expect(loads).toEqual([other]);
  });

  test.each(['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'])(
    '%s on a run path is 405 with Allow, before the run is looked up',
    async (method) => {
      const { context, loads } = harness();
      const response = await answerRunPageRequest(request(`/runs/${ID}`, { method }), context);
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      expect(loads).toEqual([]);
    },
  );

  test('another method on another path is 404', async () => {
    const { context } = harness();
    expect((await answerRunPageRequest(request('/nope', { method: 'POST' }), context)).status).toBe(
      404,
    );
  });

  test('HEAD answers the GET headers with no body', async () => {
    const { context } = harness();
    const response = await answerRunPageRequest(
      request(`/runs/${ID}`, { method: 'HEAD' }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe('');
  });
});

describe('the Host check', () => {
  test.each([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LOCALHOST:${PORT}`, 'hugi.example.ts.net'])(
    '%s is answered',
    async (host) => {
      const { context } = harness();
      expect((await answerRunPageRequest(request(`/runs/${ID}`, { host }), context)).status).toBe(
        200,
      );
    },
  );

  test('the url host with its port is answered when the url has one', async () => {
    const { context } = harness({ origin: 'http://valhalla:9000' });
    const response = await answerRunPageRequest(
      request(`/runs/${ID}`, { host: 'valhalla:9000' }),
      context,
    );
    expect(response.status).toBe(200);
  });

  test.each([
    ['another host', 'evil.example'],
    ['a loopback host without the port', '127.0.0.1'],
    ['a loopback host on another port', 'localhost:8471'],
    ['the url host with a port it does not have', 'hugi.example.ts.net:8470'],
    ['no host', ''],
  ])('%s is 421, before the path is looked at', async (_name, host) => {
    const { context, loads } = harness();
    const response = await answerRunPageRequest(request(`/runs/${ID}`, { host }), context);
    expect(response.status).toBe(421);
    expect(loads).toEqual([]);
  });
});

describe('headers', () => {
  test.each([
    ['a run page', `/runs/${ID}`, 'GET', `127.0.0.1:${PORT}`],
    ['a 404', '/nope', 'GET', `127.0.0.1:${PORT}`],
    ['a 405', `/runs/${ID}`, 'POST', `127.0.0.1:${PORT}`],
    ['a 421', `/runs/${ID}`, 'GET', 'evil.example'],
  ])('%s carries the content type and the security headers', async (_name, path, method, host) => {
    const { context } = harness();
    const response = await answerRunPageRequest(request(path, { host, method }), context);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('the policy is the one the README states', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });
});

describe('answers from the runs directory', () => {
  test('a refused record is 500 with the reason, its path relative to the runs directory', async () => {
    await writeFile(join(runsDir, ID, 'run.json'), 'garbage');
    const { context } = harness();
    const response = await answerRunPageRequest(request(`/runs/${ID}`), context);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).toContain(`The run record ${ID}/run.json is not valid JSON`);
    expect(text).not.toContain(root);
  });

  test('an orphan is 200', async () => {
    await rm(join(runsDir, ID, 'run.json'));
    const { context } = harness();
    expect((await answerRunPageRequest(request(`/runs/${ID}`), context)).status).toBe(200);
  });

  test('a running run started under 6 hours ago asks for a reload every 30 seconds', async () => {
    await writeRunRecord(join(runsDir, ID), sampleRunningRecord());
    const { context } = harness({ now: () => new Date(STARTED + 6 * 3_600_000 - 1000) });
    const response = await answerRunPageRequest(request(`/runs/${ID}`), context);
    expect(response.headers.get('refresh')).toBe('30');
  });

  test('a running run started 6 hours ago or more is not reloaded', async () => {
    await writeRunRecord(join(runsDir, ID), sampleRunningRecord());
    const { context } = harness({ now: () => new Date(STARTED + 6 * 3_600_000) });
    const response = await answerRunPageRequest(request(`/runs/${ID}`), context);
    expect(response.status).toBe(200);
    expect(response.headers.has('refresh')).toBe(false);
  });

  test('a finished run is not reloaded', async () => {
    const { context } = harness();
    expect(
      (await answerRunPageRequest(request(`/runs/${ID}`), context)).headers.has('refresh'),
    ).toBe(false);
  });

  test('an unexpected error is logged and answered 500 with no detail', async () => {
    const { context, errors } = harness({
      loadRun: async () => {
        throw new Error('disk on fire at /secret/path');
      },
    });
    const response = await answerRunPageRequest(request(`/runs/${ID}`), context);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain('disk on fire');
    expect(text).not.toContain('/secret/path');
    expect(response.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(errors).toEqual([
      `The run page could not answer GET /runs/${ID}: disk on fire at /secret/path`,
    ]);
  });
});
