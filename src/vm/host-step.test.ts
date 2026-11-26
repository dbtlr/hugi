/* oxlint-disable promise/avoid-new -- guest work that settles only on abort */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeClock, FakeTart, settle } from './fake-tart';
import { runHostStep } from './host-step';
import type { HostStepContext } from './host-step';
import type { ExecOptions, ExecResult } from './tart';

/** A tart whose `exec` hangs until its signal aborts, as a wedged checkout does, then exits 130. */
class HangingTart extends FakeTart {
  override exec(
    _vm: string,
    _argv: readonly string[],
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      options.signal?.addEventListener('abort', () => resolve({ exitCode: 130 }), { once: true });
    });
  }
}

/** The log directories this file's contexts made, removed after each test. */
const logDirs: string[] = [];
afterEach(async () => {
  await Promise.all(logDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function context(): Promise<{
  readonly ctx: HostStepContext;
  readonly clock: FakeClock;
  readonly interrupt: AbortController;
  readonly vmLost: AbortController;
}> {
  const clock = new FakeClock();
  const interrupt = new AbortController();
  const vmLost = new AbortController();
  const logDir = await mkdtemp(join(tmpdir(), 'hugi-host-step-'));
  logDirs.push(logDir);
  const ctx: HostStepContext = {
    clock,
    housekeepingMs: 1000,
    interrupt: interrupt.signal,
    logDir,
    tart: new HangingTart(clock),
    vm: 'hugi-run-test',
    vmLost: vmLost.signal,
  };
  return { clock, ctx, interrupt, vmLost };
}

const step = { index: 1, name: 'actions/checkout@v4' };

/** A body that runs one guest script and reports whatever it exited with. */
const runsOneScript = async (tools: { exec: (script: string) => Promise<number> }) => {
  const exitCode = await tools.exec('git checkout');
  return { exitCode, ok: exitCode === 0 };
};

test('a step that outlives the job deadline ends as a job timeout, not a failure', async () => {
  const { clock, ctx } = await context();
  const pending = runHostStep(ctx, step, 5000, runsOneScript, true);
  await settle();
  clock.advance(5000);
  const run = await pending;
  expect(run.end).toBe('job-timeout');
  expect(run.result.outcome).toBe('timeout');
});

test('a VM that exits mid-step ends the step as vm-lost, naming the step', async () => {
  const { ctx, vmLost } = await context();
  const pending = runHostStep(ctx, step, 5000, runsOneScript, true);
  await settle();
  vmLost.abort();
  const run = await pending;
  expect(run.end).toBe('vm-lost');
  expect(run.result).toMatchObject({
    error: 'the VM exited during actions/checkout@v4',
    outcome: 'failure',
  });
});

test('an interrupt mid-step ends it as interrupted, not as the step failing', async () => {
  const { ctx, interrupt } = await context();
  const pending = runHostStep(ctx, step, 5000, runsOneScript, true);
  await settle();
  interrupt.abort();
  const run = await pending;
  expect(run.end).toBe('interrupted');
  expect(run.result).toMatchObject({
    error: 'interrupted during actions/checkout@v4',
    outcome: 'failure',
  });
});

test('a VM lost and an interrupt together report the lost VM, which is the cause', async () => {
  const { ctx, interrupt, vmLost } = await context();
  const pending = runHostStep(ctx, step, 5000, runsOneScript, true);
  await settle();
  vmLost.abort();
  interrupt.abort();
  expect((await pending).end).toBe('vm-lost');
});

test('the step log is closed and kept whichever way the step ends', async () => {
  const { ctx, vmLost } = await context();
  const pending = runHostStep(ctx, step, 5000, runsOneScript, true);
  await settle();
  vmLost.abort();
  const run = await pending;
  expect(await readFile(run.result.logFile ?? '', 'utf8')).toBe('');
});
