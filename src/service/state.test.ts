import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isServiceStateError, readServiceState, SERVICE_STATE_FILE, writeServiceState } from './state';
import type { ServiceState } from './state';

let scratch: string;
let dir: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'hugi-service-state-'));
  dir = join(scratch, 'hugi');
});
afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

const full: ServiceState = {
  lastPoll: { endedAt: '2026-11-19T10:00:30.000Z', failures: 2 },
  pid: 4242,
  queue: { candidates: 3, waiting: 1 },
  run: {
    commit: 'a'.repeat(40),
    repository: 'dbtlr/hugi',
    startedAt: '2026-11-19T10:00:40.000Z',
    statusName: 'hugi / test (macos-15)',
    vm: 'hugi-svc-abc',
  },
  start: { kind: 'running' },
  startedAt: '2026-11-19T10:00:00.000Z',
};

test('a state written is read back, and the directory is private to the user', async () => {
  await writeServiceState(dir, full);
  expect(await readServiceState(dir)).toEqual(full);
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(dir, SERVICE_STATE_FILE))).mode & 0o777).toBe(0o600);
});

test('a refused start with only the required fields round-trips', async () => {
  const refused: ServiceState = {
    pid: 7,
    start: { at: '2026-11-19T10:00:00.000Z', kind: 'refused', reason: 'tart not found' },
    startedAt: '2026-11-19T10:00:00.000Z',
  };
  await writeServiceState(dir, refused);
  expect(await readServiceState(dir)).toEqual(refused);
});

test('writing leaves no temporary file behind and replaces the old state whole', async () => {
  await writeServiceState(dir, full);
  await writeServiceState(dir, { ...full, pid: 1 });
  expect(await readdir(dir)).toEqual([SERVICE_STATE_FILE]);
  const read = await readServiceState(dir);
  expect(read).toEqual({ ...full, pid: 1 });
});

test('an absent state reads as absent', async () => {
  expect(await readServiceState(dir)).toBeUndefined();
});

test.each([
  ['not JSON', '{nope'],
  ['an array', '[]'],
  ['a missing pid', JSON.stringify({ ...full, pid: undefined })],
  ['a non-integer pid', JSON.stringify({ ...full, pid: 1.5 })],
  ['a startedAt that is not ISO', JSON.stringify({ ...full, startedAt: 'yesterday' })],
  ['an unknown start kind', JSON.stringify({ ...full, start: { kind: 'hmm' } })],
  [
    'a refused start with no reason',
    JSON.stringify({ ...full, start: { at: full.startedAt, kind: 'refused' } }),
  ],
  ['a negative failure count', JSON.stringify({ ...full, lastPoll: { endedAt: full.startedAt, failures: -1 } })],
  ['a queue with a string count', JSON.stringify({ ...full, queue: { candidates: '3', waiting: 0 } })],
  ['a run missing its vm', JSON.stringify({ ...full, run: { ...full.run, vm: undefined } })],
])('%s is reported as unreadable, with a message', async (_name, text) => {
  await writeServiceState(dir, full);
  await writeFile(join(dir, SERVICE_STATE_FILE), text);
  const read = await readServiceState(dir);
  expect(isServiceStateError(read)).toBe(true);
  expect(isServiceStateError(read) && read.message).toContain(SERVICE_STATE_FILE);
});

test('a state path that cannot be read is an error, not a throw', async () => {
  await writeServiceState(dir, full);
  await rm(join(dir, SERVICE_STATE_FILE));
  await writeFile(join(dir, SERVICE_STATE_FILE), '');
  expect(isServiceStateError(await readServiceState(dir))).toBe(true);
});
