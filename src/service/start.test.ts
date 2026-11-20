import { expect, test } from 'bun:test';

import { DEFAULTS } from '../config/schema';
import type { HugiConfig } from '../config/schema';
import { ServeLockError } from './lock';
import type { CoordinatorEvent } from './loop';
import { applyEvent, startService } from './start';
import type { StartDeps } from './start';
import type { ServiceState } from './state';

const CONFIG: HugiConfig = {
  allowlist: [],
  pollIntervalSeconds: DEFAULTS.pollIntervalSeconds,
  repositories: ['dbtlr/hugi'],
  runs: { maxAgeDays: DEFAULTS.maxAgeDays, maxSizeGb: DEFAULTS.maxSizeGb },
  vm: { cpus: DEFAULTS.cpus, memoryGb: DEFAULTS.memoryGb },
};

const NOW = new Date('2026-11-20T08:00:00.000Z');

/** What `promise` rejects with, or `undefined` when it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

type Recorded = {
  steps: string[];
  states: ServiceState[];
  logs: { level: string; message: string }[];
};

function harness(overrides: Partial<StartDeps<void>> = {}): {
  deps: StartDeps<void>;
  seen: Recorded;
} {
  const seen: Recorded = { logs: [], states: [], steps: [] };
  const log = (level: string) => (message: string) => void seen.logs.push({ level, message });
  const deps: StartDeps<void> = {
    acquireLock: async () => {
      seen.steps.push('lock');
      return async () => void seen.steps.push('release');
    },
    checkSetup: async () => void seen.steps.push('check'),
    coordinate: async () => void seen.steps.push('coordinate'),
    loadConfig: async () => {
      seen.steps.push('config');
      return CONFIG;
    },
    log: { error: log('error'), info: log('info'), warn: log('warn') },
    now: () => NOW,
    pid: 4242,
    sweep: async () => {
      seen.steps.push('sweep');
      return { deleted: [], failed: [] };
    },
    writeState: async (state) => void seen.states.push(state),
    ...overrides,
  };
  return { deps, seen };
}

test('starts in order: lock, configuration, setup checks, state, sweep, loop, release', async () => {
  const { deps, seen } = harness();
  await startService(deps);
  expect(seen.steps).toEqual(['lock', 'config', 'check', 'sweep', 'coordinate', 'release']);
  expect(seen.states[0]).toEqual({
    pid: 4242,
    start: { kind: 'running' },
    startedAt: NOW.toISOString(),
  });
});

test('a held lock refuses the start and leaves the state alone', async () => {
  const held = new ServeLockError('Another hugi serve (pid 7) holds the lock.');
  const { deps, seen } = harness({
    acquireLock: async () => {
      throw held;
    },
  });
  expect(await rejectionOf(startService(deps))).toBe(held);
  expect(seen.states).toEqual([]);
  expect(seen.steps).toEqual([]);
});

test('a refused setup is written to the state and releases the lock', async () => {
  const refusal = new Error('tart is not on the search path.');
  const { deps, seen } = harness({
    checkSetup: async () => {
      throw refusal;
    },
  });
  expect(await rejectionOf(startService(deps))).toBe(refusal);
  expect(seen.states).toEqual([
    {
      pid: 4242,
      start: { at: NOW.toISOString(), kind: 'refused', reason: refusal.message },
      startedAt: NOW.toISOString(),
    },
  ]);
  expect(seen.steps).toEqual(['lock', 'config', 'release']);
});

test('a refused configuration is a refused start too', async () => {
  const { deps, seen } = harness({
    loadConfig: async () => {
      throw new Error('repositories: is required.');
    },
  });
  expect(String(await rejectionOf(startService(deps)))).toContain('repositories');
  expect(seen.states[0]?.start).toEqual({
    at: NOW.toISOString(),
    kind: 'refused',
    reason: 'repositories: is required.',
  });
  expect(seen.steps).toEqual(['lock', 'release']);
});

test('a state that cannot be written is a warning, not a refusal', async () => {
  const { deps, seen } = harness({
    writeState: async () => {
      throw new Error('disk full');
    },
  });
  await startService(deps);
  expect(seen.steps).toContain('coordinate');
  expect(seen.logs).toContainEqual({
    level: 'warn',
    message: 'Could not write the service state: disk full',
  });
});

test('the sweep logs what it deleted and what it could not, and the service still starts', async () => {
  const { deps, seen } = harness({
    sweep: async () => ({
      deleted: ['hugi-svc-aa'],
      failed: [{ message: 'tart delete timed out', vm: 'hugi-svc-bb' }],
    }),
  });
  await startService(deps);
  expect(seen.logs).toContainEqual({ level: 'info', message: 'Deleted leftover VM hugi-svc-aa.' });
  expect(seen.logs).toContainEqual({
    level: 'error',
    message: 'Could not delete leftover VM hugi-svc-bb: tart delete timed out',
  });
  expect(seen.steps).toContain('coordinate');
});

test('a sweep that cannot list VMs is an error, and the service still starts', async () => {
  const { deps, seen } = harness({
    sweep: async () => {
      throw new Error('tart list failed');
    },
  });
  await startService(deps);
  expect(seen.logs).toContainEqual({
    level: 'error',
    message: 'Could not sweep leftover VMs: tart list failed',
  });
  expect(seen.steps).toContain('coordinate');
});

test('coordinator events update the state the service writes', async () => {
  const events: CoordinatorEvent[] = [
    { failures: 1, kind: 'poll-ended', queued: 3, waiting: 1 },
    { commit: 'abc', kind: 'run-started', repository: 'dbtlr/hugi', statusName: 'hugi / test' },
    {
      commit: 'abc',
      kind: 'run-started',
      repository: 'dbtlr/hugi',
      runId: 'r1',
      statusName: 'hugi / test',
      vmId: 'x1',
    },
    {
      commit: 'abc',
      ending: 'passed',
      kind: 'run-ended',
      repository: 'dbtlr/hugi',
      statusName: 'hugi / test',
    },
  ];
  const { deps, seen } = harness({
    coordinate: async (_config, _setup, report) => {
      for (const event of events) {
        // oxlint-disable-next-line no-await-in-loop -- events arrive one at a time
        await report(event);
      }
    },
  });
  await startService(deps);
  expect(seen.states.map((state) => state.run?.vm)).toEqual([
    undefined,
    undefined,
    undefined,
    'hugi-svc-x1',
    undefined,
  ]);
  expect(seen.states.at(-1)).toMatchObject({
    lastPoll: { endedAt: NOW.toISOString(), failures: 1 },
    queue: { candidates: 3, waiting: 1 },
  });
});

test('applyEvent names the run in flight once its VM is known', () => {
  const base: ServiceState = { pid: 1, start: { kind: 'running' }, startedAt: NOW.toISOString() };
  const started = applyEvent(
    base,
    {
      commit: 'abc',
      kind: 'run-started',
      repository: 'dbtlr/hugi',
      statusName: 'hugi / test',
      vmId: 'x1',
    },
    NOW,
  );
  expect(started.run).toEqual({
    commit: 'abc',
    repository: 'dbtlr/hugi',
    startedAt: NOW.toISOString(),
    statusName: 'hugi / test',
    vm: 'hugi-svc-x1',
  });
  const ended = applyEvent(
    started,
    {
      commit: 'abc',
      ending: 'failed',
      kind: 'run-ended',
      repository: 'dbtlr/hugi',
      statusName: 'hugi / test',
    },
    NOW,
  );
  expect(ended.run).toBeUndefined();
});

test('the sweep and the loop get what the setup check found', async () => {
  const got: string[] = [];
  const deps: StartDeps<string> = {
    ...harness().deps,
    checkSetup: async () => 'tools found once',
    coordinate: async (_config, setup) => void got.push(`coordinate: ${setup}`),
    sweep: async (_config, setup) => {
      got.push(`sweep: ${setup}`);
      return { deleted: [], failed: [] };
    },
  };
  await startService(deps);
  expect(got).toEqual(['sweep: tools found once', 'coordinate: tools found once']);
});
