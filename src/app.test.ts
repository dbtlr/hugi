import { expect, test } from 'bun:test';

import { mockProcess } from '@loomcli/testing';

import pkg from '../package.json' with { type: 'json' };
import { createApp, SHUTDOWN_BUDGET_MS } from './app';
import { DEFAULT_TUNING } from './vm/lifecycle';

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
  // Kill the running step and copy its log, stop the VM, wait twice for it to exit, then
  // delete it, with a pause between attempts.
  const worstCaseMs =
    2 * t.housekeepingMs +
    t.housekeepingMs +
    2 * t.stopGraceMs +
    (t.deleteAttempts - 1) * t.deleteRetryMs;
  expect(worstCaseMs).toBe(154_000);
  expect(SHUTDOWN_BUDGET_MS).toBeGreaterThanOrEqual(worstCaseMs + 20_000);
});
