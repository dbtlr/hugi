import { expect, test } from 'bun:test';
import { finished } from 'node:stream/promises';

import { advanceUntilSettled, FakeClock, FakeSpawn, settle } from './fake-tart';
import type { FakeCommand } from './fake-tart';
import { TartCallError } from './tart';
import { createTartCli } from './tart-cli';
import {
  TART_CLONE_DEADLINE_MS,
  TART_DELETE_DEADLINE_MS,
  TART_EXEC_DEADLINE_MS,
  TART_ESCALATION_MS,
  TART_LIST_DEADLINE_MS,
  TART_SET_DEADLINE_MS,
  TART_STOP_DEADLINE_MS,
  TART_TERM_GRACE_MS,
  textSink,
} from './tart-process';

const VM = 'hugi-run-a';
const STEP_MS = 100;

const setup = (script: (args: readonly string[]) => FakeCommand) => {
  const clock = new FakeClock();
  const fake = new FakeSpawn(clock, script);
  return { clock, fake, tart: createTartCli(fake.spawn, clock) };
};

/** The error a call that hangs ends with, and how long it took. */
async function failureOf(
  clock: FakeClock,
  work: Promise<unknown>,
  stepMs = STEP_MS,
): Promise<TartCallError> {
  const error = await advanceUntilSettled(
    clock,
    work.then(
      () => undefined,
      (caught: unknown) => caught,
    ),
    stepMs,
  );
  if (!(error instanceof TartCallError)) {
    throw new Error(`expected a TartCallError, got ${String(error)}`);
  }
  return error;
}

test('a character split across two output chunks arrives whole', async () => {
  const texts: string[] = [];
  const sink = textSink((text) => texts.push(text));
  const bytes = new TextEncoder().encode('café ✓');
  sink.write(bytes.slice(0, 4));
  sink.write(bytes.slice(4, 8));
  sink.write(bytes.slice(8));
  await finished(sink.end());
  expect(texts.join('')).toBe('café ✓');
});

test('a tart command that exits non-zero throws with its output', async () => {
  const { clock, tart } = setup(() => ({ exitCode: 1, output: 'no such vm\n' }));
  const error = await advanceUntilSettled(
    clock,
    tart.delete(VM).catch((caught: unknown) => caught),
    STEP_MS,
  );
  expect(String(error)).toContain(`tart delete ${VM} exited 1: no such vm`);
});

test('a hung tart clone throws a typed timeout naming the VM at its deadline', async () => {
  const { clock, fake, tart } = setup(() => ({ hangs: true }));
  const error = await failureOf(clock, tart.clone('golden', VM), 10_000);
  expect(error).toMatchObject({ failure: 'timed-out', vm: VM });
  expect(error.message).toContain(`tart clone golden ${VM}`);
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM']);
  expect(clock.now()).toBeGreaterThanOrEqual(TART_CLONE_DEADLINE_MS);
  expect(clock.now()).toBeLessThanOrEqual(TART_CLONE_DEADLINE_MS + 10_000);
});

test('a hung tart exec nobody aborts throws a typed timeout naming the VM at its deadline', async () => {
  const { clock, fake, tart } = setup(() => ({ hangs: true }));
  const error = await failureOf(clock, tart.exec(VM, ['sleep', '99']), 600_000);
  expect(error).toMatchObject({ failure: 'timed-out', vm: VM });
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM']);
  expect(clock.now()).toBeGreaterThanOrEqual(TART_EXEC_DEADLINE_MS);
  expect(clock.now()).toBeLessThanOrEqual(TART_EXEC_DEADLINE_MS + 600_000);
});

test('a hung tart set throws a typed timeout naming the VM at its deadline', async () => {
  const { clock, fake, tart } = setup(() => ({ hangs: true }));
  const error = await failureOf(clock, tart.setResources(VM, { cpus: 4, memoryMb: 4096 }));
  expect(error).toMatchObject({ failure: 'timed-out', vm: VM });
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM']);
  expect(clock.now()).toBeLessThanOrEqual(TART_SET_DEADLINE_MS + STEP_MS);
});

test('a hung tart delete that ignores SIGTERM is killed, and the failure names the VM', async () => {
  const { clock, fake, tart } = setup(() => ({ hangs: true, ignoresSigterm: true }));
  const error = await failureOf(clock, tart.delete(VM));
  expect(error).toMatchObject({ failure: 'killed', vm: VM });
  expect(error.message).toContain(`tart delete ${VM}`);
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(clock.now()).toBeLessThanOrEqual(TART_DELETE_DEADLINE_MS + TART_ESCALATION_MS + STEP_MS);
});

test('a caller can shorten a delete deadline but not lengthen it', async () => {
  const shorter = setup(() => ({ hangs: true }));
  await failureOf(shorter.clock, shorter.tart.delete(VM, { deadlineMs: 3000 }));
  expect(shorter.clock.now()).toBeLessThanOrEqual(3000 + STEP_MS);

  const longer = setup(() => ({ hangs: true }));
  await failureOf(
    longer.clock,
    longer.tart.delete(VM, { deadlineMs: 10 * TART_DELETE_DEADLINE_MS }),
  );
  expect(longer.clock.now()).toBeLessThanOrEqual(TART_DELETE_DEADLINE_MS + STEP_MS);
});

test('a tart exec that ignores SIGTERM after an abort is killed and reports the kill code', async () => {
  const { clock, fake, tart } = setup(() => ({ hangs: true, ignoresSigterm: true }));
  const abort = new AbortController();
  const work = tart.exec(VM, ['sleep', '99'], { signal: abort.signal });
  await settle();
  abort.abort();
  expect(await advanceUntilSettled(clock, work, STEP_MS)).toEqual({ exitCode: 137 });
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(clock.now()).toBeLessThanOrEqual(TART_TERM_GRACE_MS + STEP_MS);
});

test('a hung tart stop is cut off at its deadline, SIGKILL after SIGTERM is ignored', async () => {
  const { clock, fake, tart } = setup(() => ({ hangs: true, ignoresSigterm: true }));
  const error = await failureOf(clock, tart.stop(VM));
  expect(error.failure).toBe('killed');
  expect(clock.now()).toBeLessThanOrEqual(TART_STOP_DEADLINE_MS + TART_ESCALATION_MS + STEP_MS);
  expect(fake.calls[0]!.args).toEqual(['stop', '--timeout', '10', VM]);
});

test('killing the VM process escalates to SIGKILL and its exit code resolves', async () => {
  const { clock, fake, tart } = setup(() => ({ hangs: true, ignoresSigterm: true }));
  const vm = tart.run(VM, { readOnlyShares: [] });
  await settle();
  vm.kill();
  expect(await advanceUntilSettled(clock, vm.exited, STEP_MS)).toBe(137);
  expect(fake.calls[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
});
