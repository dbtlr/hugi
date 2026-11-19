import { expect, test } from 'bun:test';

import { mockProcess } from '@loomcli/testing';

import pkg from '../package.json' with { type: 'json' };
import { createApp, SHUTDOWN_BUDGET_MS } from './app';
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
