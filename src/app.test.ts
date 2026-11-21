import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Host } from '@loomcli/core';
import { mockProcess } from '@loomcli/testing';

import pkg from '../package.json' with { type: 'json' };
import { createApp, SHUTDOWN_BUDGET_MS, statusProbeDeps } from './app';
import { acquireServeLock } from './service/lock';
import { createProbe } from './service/probe';
import { writeServiceState } from './service/state';
import { resolveServeLockPath, resolveServiceStateDir } from './source/locations';
import { FakeClock, FakeSpawn } from './vm/fake-tart';
import { DEFAULT_TUNING } from './vm/lifecycle';
import {
  TART_DELETE_DEADLINE_MS,
  TART_ESCALATION_MS,
  TART_STOP_DEADLINE_MS,
} from './vm/tart-process';
import { DELETE_RESERVE_MS, TEARDOWN_BUDGET_MS } from './vm/teardown';

test('--version prints the package version', async () => {
  const mock = mockProcess({ argv: ['--version'], env: {}, stdin: '' }),
    exitCode = await createApp().run({ process: mock });
  expect(exitCode).toBe(0);
  expect(mock.stdout.text.trim()).toBe(pkg.version);
});

test('--help works without any command declared', async () => {
  const mock = mockProcess({ argv: ['--help'], env: {}, stdin: '' }),
    exitCode = await createApp().run({ process: mock });
  expect(exitCode).toBe(0);
  expect(mock.stdout.text).toContain('hugi');
});

test('the shutdown budget covers the worst-case teardown of an interrupted run', () => {
  const t = DEFAULT_TUNING;
  // End the tart call in flight (it may ignore SIGTERM), kill the running step and copy its log
  // (each bounded by the housekeeping deadline), then tear the VM down within its budget. An
  // interrupted run starts no other guest call (lifecycle.test.ts measures this end to end).
  const worstCaseMs = TART_ESCALATION_MS + 2 * t.housekeepingMs + t.teardownBudgetMs;
  expect(t.teardownBudgetMs).toBe(TEARDOWN_BUDGET_MS);
  expect(worstCaseMs).toBe(167_000);
  expect(SHUTDOWN_BUDGET_MS).toBeGreaterThanOrEqual(worstCaseMs + 10_000);
});

test('the teardown budget holds a full stop and two full delete attempts, escalation included', () => {
  const stopPhaseMs = TART_STOP_DEADLINE_MS + 2 * DEFAULT_TUNING.stopGraceMs;
  expect(stopPhaseMs).toBeLessThanOrEqual(TEARDOWN_BUDGET_MS - DELETE_RESERVE_MS);
  const twoDeletes =
    2 * (TART_DELETE_DEADLINE_MS + TART_ESCALATION_MS) + DEFAULT_TUNING.deleteRetryMs;
  expect(twoDeletes).toBeLessThanOrEqual(DELETE_RESERVE_MS);
});

describe('the leftover VMs row of hugi service status', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hugi-status-'));
    await mkdir(join(home, 'inherited'));
    await writeFile(join(home, 'inherited', 'tart'), '#!/bin/sh\n', { mode: 0o755 });
  });
  afterEach(async () => {
    await rm(home, { force: true, recursive: true });
  });

  /** List the VMs as status does, recording how tart was started. */
  async function listed() {
    const started: { command: string; path: string | undefined }[] = [];
    const fake = new FakeSpawn(new FakeClock(), () => ({ output: '[{"Name":"hugi-svc-left"}]' }));
    const spawn: Host['spawn'] = (command, args, options) => {
      started.push({ command, path: options?.env?.PATH });
      return fake.spawn(command, args, options);
    };
    const host = { env: { PATH: join(home, 'inherited') }, home, platform: 'darwin', spawn };
    const names = await statusProbeDeps(host).listVms();
    return { names, started };
  }

  test('runs tart found on the PATH of the shell running status', async () => {
    const { names, started } = await listed();
    expect(names).toEqual(['hugi-svc-left']);
    expect(started).toEqual([
      { command: join(home, 'inherited', 'tart'), path: join(home, 'inherited') },
    ]);
  });
});

const noSpawn: Host['spawn'] = () => {
  throw new Error('status starts no program for the state rows');
};

describe.skipIf(process.platform !== 'darwin')(
  'whether hugi service status reads the state as live',
  () => {
    let home: string;
    /** The state a hugi serve with this pid wrote. */
    const writeStateOf = (pid: number) =>
      writeServiceState(resolveServiceStateDir({}, home), {
        pid,
        start: { kind: 'running' },
        startedAt: '2026-11-19T10:00:00.000Z',
      });
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'hugi-status-'));
      await writeStateOf(process.pid);
    });
    afterEach(async () => {
      await rm(home, { force: true, recursive: true });
    });

    /** The `start` row, read as `hugi service status` reads it on this darwin host. */
    async function startRow(): Promise<string | undefined> {
      const deps = statusProbeDeps({ env: {}, home, platform: 'darwin', spawn: noSpawn });
      const rows = await createProbe({ ...deps, listVms: async () => [] })({
        state: { installed: false, label: 'x', notes: [], running: false, state: '', unit: '' },
      });
      return rows.find((row) => row.name === 'start')?.value;
    }

    test('live while the hugi serve that wrote it holds the lock', async () => {
      const release = await acquireServeLock(resolveServeLockPath(home), {
        pid: process.pid,
        platform: 'darwin',
      });
      try {
        expect(await startRow()).not.toContain('stale');
      } finally {
        await release();
      }
    });

    test('stale once the lock is free, though the lock file still names its pid', async () => {
      const release = await acquireServeLock(resolveServeLockPath(home), {
        pid: process.pid,
        platform: 'darwin',
      });
      await release();
      expect(await startRow()).toContain('stale');
    });

    test('stale while the lock is held but the pid it and the state name is dead', async () => {
      // A new hugi serve between taking the lock and writing its pid still shows the last one's.
      const exited = Bun.spawn([process.execPath, '-e', '']);
      await exited.exited;
      await writeStateOf(exited.pid);
      const release = await acquireServeLock(resolveServeLockPath(home), {
        pid: exited.pid,
        platform: 'darwin',
      });
      try {
        expect(await startRow()).toContain('stale');
      } finally {
        await release();
      }
    });

    test('stale while another hugi serve holds the lock', async () => {
      // pid 1 is alive, so only the pid differing makes the state stale.
      const release = await acquireServeLock(resolveServeLockPath(home), {
        pid: 1,
        platform: 'darwin',
      });
      try {
        expect(await startRow()).toContain('stale');
      } finally {
        await release();
      }
    });
  },
);
