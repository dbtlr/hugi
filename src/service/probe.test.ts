import { describe, expect, test } from 'bun:test';

import { createProbe, formatElapsed, formatRelative, serviceRows } from './probe';
import type { ProbeInput } from './probe';
import type { ServiceState } from './state';

const NOW = new Date('2026-11-19T10:10:00.000Z');

const state: ServiceState = {
  lastPoll: { endedAt: '2026-11-19T10:07:00.000Z', failures: 0 },
  pid: 42,
  queue: { candidates: 3, waiting: 1 },
  run: {
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    repository: 'dbtlr/hugi',
    startedAt: '2026-11-19T10:05:48.000Z',
    statusName: 'hugi / test (macos-15)',
    vm: 'hugi-svc-run1',
  },
  start: { kind: 'running' },
  startedAt: '2026-11-19T10:00:00.000Z',
};

function input(overrides: Partial<ProbeInput> = {}): ProbeInput {
  return {
    listVms: async () => [],
    lockHolder: 42,
    now: NOW,
    state,
    ...overrides,
  };
}

const STALE = ' (stale: the hugi serve that wrote it no longer runs)';

const listVms = async () => ['hugi-svc-run1', 'hugi-svc-old', 'hugi-run-x', 'golden'];

const byName = async (overrides: Partial<ProbeInput> = {}) =>
  Object.fromEntries((await serviceRows(input(overrides))).map((row) => [row.name, row.value]));

test('the rows come in the README order, leaving the log to Loom', async () => {
  expect((await serviceRows(input())).map((row) => row.name)).toEqual([
    'run',
    'queue',
    'last poll',
    'start',
    'leftover VMs',
  ]);
});

test('a running service shows its run, queue, poll and start', async () => {
  const rows = await byName();
  expect(rows.run).toBe(
    'hugi / test (macos-15), dbtlr/hugi @ abcdef012345, started 2026-11-19T10:05:48.000Z, 4m12s elapsed',
  );
  expect(rows.queue).toBe('3 candidates, 1 waiting');
  expect(rows['last poll']).toBe('2026-11-19T10:07:00.000Z (3m ago), ok');
  expect(rows.start).toBe('started 2026-11-19T10:00:00.000Z (10m ago)');
  expect(rows['leftover VMs']).toBe('none');
});

test('no run in flight is idle; failed reads are counted', async () => {
  const { run: _run, ...idle } = state;
  const rows = await byName({
    state: { ...idle, lastPoll: { endedAt: '2026-11-19T10:09:59.000Z', failures: 2 } },
  });
  expect(rows.run).toBe('idle');
  expect(rows['last poll']).toBe('2026-11-19T10:09:59.000Z (1s ago), 2 reads failed');
});

test('a refused start shows when and why, and is stale, since its process has exited', async () => {
  const rows = await byName({
    lockHolder: undefined,
    state: {
      pid: 1,
      start: { at: '2026-11-19T10:09:00.000Z', kind: 'refused', reason: 'tart not found on PATH' },
      startedAt: '2026-11-19T10:09:00.000Z',
    },
  });
  expect(rows.start).toBe(
    `refused 2026-11-19T10:09:00.000Z (1m ago): tart not found on PATH${STALE}`,
  );
  expect(rows.queue).toBe(`no poll yet${STALE}`);
  expect(rows['last poll']).toBe(`no poll yet${STALE}`);
  expect(rows.run).toBe(`idle${STALE}`);
});

test('unless the process that wrote it holds the lock, every row read from the state says it is stale', async () => {
  const rows = await byName({ lockHolder: undefined });
  for (const name of ['run', 'queue', 'last poll', 'start']) {
    expect(rows[name]).toEndWith('(stale: the hugi serve that wrote it no longer runs)');
  }
  expect(rows['leftover VMs']).not.toContain('stale');
});

test('a missing state says there is no state yet', async () => {
  const rows = await byName({ state: undefined });
  for (const name of ['run', 'queue', 'last poll', 'start']) {
    expect(rows[name]).toBe('no state yet');
  }
});

test('an unreadable state says so in each state row', async () => {
  const rows = await byName({
    state: { kind: 'error', message: 'service.json is not valid JSON' },
  });
  for (const name of ['run', 'queue', 'last poll', 'start']) {
    expect(rows[name]).toBe('state unreadable: service.json is not valid JSON');
  }
});

test('leftover VMs lists hugi-svc-* names only, and leaves out the run in flight while live', async () => {
  expect((await byName({ listVms }))['leftover VMs']).toBe('hugi-svc-old');
  expect((await byName({ listVms, lockHolder: undefined }))['leftover VMs']).toBe(
    'hugi-svc-run1, hugi-svc-old',
  );
  expect((await byName({ listVms, state: undefined }))['leftover VMs']).toBe(
    'hugi-svc-run1, hugi-svc-old',
  );
});

test('leftover VMs says why tart could not list them', async () => {
  const rows = await byName({
    listVms: async () => {
      throw new Error('tart: command not found');
    },
  });
  expect(rows['leftover VMs']).toBe('tart: command not found');
});

test('relative and elapsed times read short', () => {
  expect(formatRelative(5_000)).toBe('5s ago');
  expect(formatRelative(180_000)).toBe('3m ago');
  expect(formatRelative(7_300_000)).toBe('2h ago');
  expect(formatRelative(3 * 86_400_000)).toBe('3d ago');
  expect(formatRelative(-5_000)).toBe('0s ago');
  expect(formatElapsed(12_000)).toBe('12s');
  expect(formatElapsed(252_000)).toBe('4m12s');
  expect(formatElapsed(3_725_000)).toBe('1h02m05s');
});

/** The service manager's word on whether a process runs, which the probe does not trust. */
const manager = (running: boolean) => ({
  state: {
    installed: true,
    label: 'dev.hugi',
    notes: [],
    running,
    state: running ? 'running' : 'not running',
    unit: '/unit.plist',
  },
});
/** The probe of the state in `state` (pid 42), with this lock holder. */
const probeWith = (lockHolder: () => Promise<number | undefined>) =>
  createProbe({
    listVms,
    lockHolder,
    now: () => NOW,
    readState: async () => state,
  });
const rowsOf = async (rows: Promise<readonly { name: string; value: string }[]>) =>
  Object.fromEntries((await rows).map((row) => [row.name, row.value]));

describe('whether the state is live', () => {
  test('a hugi serve run by hand, with the agent stopped, is live: its VM is not a leftover', async () => {
    const rows = await rowsOf(probeWith(async () => 42)(manager(false)));
    expect(rows.start).not.toContain('stale');
    expect(rows['leftover VMs']).toBe('hugi-svc-old');
  });

  test('just after a crash the dead instance is stale, though launchd runs a new process', async () => {
    for (const holder of [undefined, 99]) {
      // oxlint-disable-next-line no-await-in-loop -- two cases
      const rows = await rowsOf(probeWith(async () => holder)(manager(true)));
      expect(rows.start).toContain('stale');
      expect(rows['leftover VMs']).toBe('hugi-svc-run1, hugi-svc-old');
    }
  });
});

test('a run being prepared shows its lane as preparing, and leaves no VM out of the leftovers', async () => {
  const preparing = {
    commit: 'abcdef0123456789abcdef0123456789abcdef01',
    repository: 'dbtlr/hugi',
    startedAt: '2026-11-19T10:05:48.000Z',
    statusName: 'hugi / test (macos-15)',
  };
  const rows = await byName({ listVms, state: { ...state, run: preparing } });
  expect(rows.run).toBe(
    'hugi / test (macos-15), dbtlr/hugi @ abcdef012345, started 2026-11-19T10:05:48.000Z, 4m12s elapsed (preparing)',
  );
  expect(rows['leftover VMs']).toBe('hugi-svc-run1, hugi-svc-old');
});
