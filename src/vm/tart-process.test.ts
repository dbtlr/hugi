import { expect, test } from 'bun:test';

import type { ChildExit } from '@loomcli/core';

import { advanceUntilSettled, FakeClock, FakeSpawn, settle } from './fake-tart';
import type { FakeCommand } from './fake-tart';
import { runTart, startTart, TART_KILL_WAIT_MS, TART_TERM_GRACE_MS } from './tart-process';

const DEADLINE_MS = 10_000;
const neverStarts: Parameters<typeof runTart>[0] = () => ({
  abandon: () => undefined,
  exited: Promise.resolve<ChildExit>({ error: new Error('no such program'), kind: 'unstarted' }),
  kill: () => undefined,
});

const STEP_MS = 100;
const setup = (script: (args: readonly string[]) => FakeCommand) => {
  const clock = new FakeClock();
  return { clock, fake: new FakeSpawn(clock, script) };
};
const finish = <T>(clock: FakeClock, work: Promise<T>): Promise<T> =>
  advanceUntilSettled(clock, work, STEP_MS);

test('a command that completes reports its exit code and output', async () => {
  const { clock, fake } = setup(() => ({ exitCode: 3, output: 'boom\n' }));
  const outcome = await finish(
    clock,
    runTart(fake.spawn, clock, ['set', 'hugi-run-a'], { deadlineMs: DEADLINE_MS }),
  );
  expect(outcome).toEqual({ exitCode: 3, kind: 'completed', output: 'boom\n' });
  expect(fake.calls[0]!.signals).toEqual([]);
});

test('a hung tart set ends at its deadline with SIGTERM', async () => {
  const { clock, fake } = setup(() => ({ hangs: true }));
  const outcome = await finish(
    clock,
    runTart(fake.spawn, clock, ['set', 'hugi-run-a'], { deadlineMs: DEADLINE_MS }),
  );
  expect(outcome).toMatchObject({ cause: 'deadline', kind: 'timed-out' });
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM']);
  const took = fake.calls[0]!.endedAt! - fake.calls[0]!.startedAt;
  expect(took).toBeLessThanOrEqual(DEADLINE_MS + STEP_MS);
});

test('a hung tart delete that ignores SIGTERM is killed after the grace period', async () => {
  const { clock, fake } = setup(() => ({ hangs: true, ignoresSigterm: true }));
  const outcome = await finish(
    clock,
    runTart(fake.spawn, clock, ['delete', 'hugi-run-a'], { deadlineMs: DEADLINE_MS }),
  );
  expect(outcome).toMatchObject({ cause: 'deadline', kind: 'killed' });
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(fake.calls[0]!.abandoned).toBeUndefined();
  const took = fake.calls[0]!.endedAt! - fake.calls[0]!.startedAt;
  expect(took).toBeGreaterThanOrEqual(DEADLINE_MS + TART_TERM_GRACE_MS);
  expect(took).toBeLessThanOrEqual(DEADLINE_MS + TART_TERM_GRACE_MS + STEP_MS);
});

test('a tart exec that ignores SIGTERM after an abort is killed, and the abort is the cause', async () => {
  const { clock, fake } = setup(() => ({ hangs: true, ignoresSigterm: true }));
  const abort = new AbortController();
  const work = runTart(fake.spawn, clock, ['exec', 'hugi-run-a', 'sleep', '9'], {
    deadlineMs: 60_000,
    signal: abort.signal,
  });
  await settle();
  abort.abort();
  const outcome = await finish(clock, work);
  expect(outcome).toMatchObject({ cause: 'abort', exitCode: 137, kind: 'killed' });
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
});

test('an abort that SIGTERM satisfies is reported as aborted', async () => {
  const { clock, fake } = setup(() => ({ hangs: true }));
  const abort = new AbortController();
  const work = runTart(fake.spawn, clock, ['exec', 'hugi-run-a', 'true'], {
    deadlineMs: 60_000,
    signal: abort.signal,
  });
  await settle();
  abort.abort();
  expect(await finish(clock, work)).toMatchObject({ exitCode: 143, kind: 'aborted' });
});

test('a process that survives SIGKILL no longer holds the caller', async () => {
  const { clock, fake } = setup(() => ({ hangs: true, ignoresSigterm: true, unkillable: true }));
  const outcome = await finish(
    clock,
    runTart(fake.spawn, clock, ['delete', 'hugi-run-a'], { deadlineMs: DEADLINE_MS }),
  );
  expect(outcome.kind).toBe('killed');
  expect(fake.calls[0]!.endedAt).toBeUndefined();
  expect(fake.calls[0]!.abandoned).toBe(true);
  expect(clock.now()).toBeLessThanOrEqual(
    DEADLINE_MS + TART_TERM_GRACE_MS + TART_KILL_WAIT_MS + STEP_MS,
  );
});

test('a command that cannot start is unstarted', async () => {
  const clock = new FakeClock();
  const outcome = await runTart(neverStarts, clock, ['list'], { deadlineMs: DEADLINE_MS });
  expect(outcome).toMatchObject({ kind: 'unstarted' });
});

test('a long-lived process has no deadline, and terminate escalates to SIGKILL', async () => {
  const { clock, fake } = setup(() => ({ hangs: true, ignoresSigterm: true }));
  const call = startTart(fake.spawn, clock, ['run', 'hugi-run-a'], {});
  await settle();
  clock.advance(24 * 3_600_000);
  await settle();
  expect(fake.calls[0]!.signals).toEqual([]);
  call.terminate();
  const outcome = await finish(clock, call.outcome);
  expect(outcome).toMatchObject({ kind: 'killed' });
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
});

/** A spawn whose child settles without an exit code, as an abandoned child does. */
const abandoned: Parameters<typeof runTart>[0] = () => ({
  abandon: () => undefined,
  exited: Promise.resolve<ChildExit>({
    kind: 'abandoned',
    stderr: { bytes: new Uint8Array(), text: '' },
    stdout: { bytes: new Uint8Array(), text: '' },
  }),
  kill: () => undefined,
});

test('a tart call that ends without an exit code reports the kill exit code', async () => {
  const clock = new FakeClock();
  const outcome = await finish(
    clock,
    runTart(abandoned, clock, ['list'], { deadlineMs: DEADLINE_MS }),
  );
  expect(outcome).toEqual({ exitCode: 137, kind: 'completed', output: '' });
});
