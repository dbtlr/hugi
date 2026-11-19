import { expect, test } from 'bun:test';

import { advanceUntilSettled, FakeClock, FakeSpawn, FakeTart } from './fake-tart';
import type { FakeCommand, FakeGuest } from './fake-tart';
import { DEFAULT_TUNING } from './lifecycle';
import { createTartCli } from './tart-cli';
import { teardown, TEARDOWN_BUDGET_MS } from './teardown';
import type { TeardownTuning } from './teardown';

const VM = 'hugi-run-t';

/** A started and cloned VM, torn down on a fake clock; reports the outcome and the virtual time taken. */
async function tearDown(guest: FakeGuest, tuning: Partial<TeardownTuning> = {}) {
  const clock = new FakeClock();
  const tart = new FakeTart(clock, guest);
  const warnings: string[] = [];
  const vmProcess = tart.run(VM, { readOnlyShares: [] });
  const outcome = await advanceUntilSettled(
    clock,
    teardown(
      { clock, tart, warn: (message) => warnings.push(message) },
      { ...DEFAULT_TUNING, ...tuning },
      VM,
      { cloneStarted: true, vmCloned: true, vmProcess },
    ),
  );
  return { elapsedMs: clock.now(), outcome, tart, warnings };
}

test('a clean teardown stops the VM, deletes it, and takes no time', async () => {
  const { outcome, tart, elapsedMs } = await tearDown({ steps: {} });
  expect(outcome).toEqual({ kind: 'deleted' });
  expect(tart.events.slice(-2)).toEqual([`stop ${VM}`, `delete ${VM}`]);
  expect(elapsedMs).toBe(0);
});

test('a hung stop is cut off and the delete still runs, within the budget', async () => {
  const { outcome, tart, elapsedMs } = await tearDown({ steps: {}, wedged: { stop: true } });
  expect(outcome).toEqual({ kind: 'deleted' });
  expect(tart.events.slice(-3)).toEqual([`stop ${VM}`, `kill ${VM}`, `delete ${VM}`]);
  expect(elapsedMs).toBeLessThanOrEqual(TEARDOWN_BUDGET_MS);
});

test('a hung stop and a delete that hangs every time end as a typed leak inside the budget', async () => {
  const { outcome, tart, elapsedMs, warnings } = await tearDown({
    steps: {},
    wedged: { delete: Infinity, stop: true },
  });
  expect(outcome).toMatchObject({ failure: 'timed-out', kind: 'leaked', vm: VM });
  expect(tart.events.filter((event) => event.startsWith('delete'))).toHaveLength(3);
  expect(warnings.at(-1)).toContain(`tart delete ${VM}`);
  expect(elapsedMs).toBeLessThanOrEqual(TEARDOWN_BUDGET_MS);
});

test('a delete that hangs once is retried and succeeds', async () => {
  const { outcome, tart } = await tearDown({ steps: {}, wedged: { delete: 1 } });
  expect(outcome).toEqual({ kind: 'deleted' });
  expect(tart.events.filter((event) => event.startsWith('delete'))).toHaveLength(2);
});

test('a budget used up by the stop still leaves the delete its reserve', async () => {
  const { outcome, tart, elapsedMs } = await tearDown(
    { steps: {}, wedged: { delete: Infinity, stop: true } },
    { deleteReserveMs: 25_000, teardownBudgetMs: 30_000 },
  );
  expect(tart.events.some((event) => event === `delete ${VM}`)).toBe(true);
  expect(outcome.kind).toBe('leaked');
  // The first delete attempt always runs, so a budget this small is exceeded by at most one attempt.
  expect(elapsedMs).toBeLessThanOrEqual(30_000 + 20_000);
});

test('a clone that failed part-way gets one delete attempt', async () => {
  const clock = new FakeClock();
  const tart = new FakeTart(clock, { steps: {}, wedged: { delete: Infinity } });
  const outcome = await advanceUntilSettled(
    clock,
    teardown({ clock, tart, warn: () => undefined }, DEFAULT_TUNING, VM, {
      cloneStarted: true,
      vmCloned: false,
    }),
  );
  expect(outcome).toMatchObject({ kind: 'leaked', vm: VM });
  expect(tart.events.filter((event) => event.startsWith('delete'))).toHaveLength(1);
});

test('a run that never cloned has nothing to delete', async () => {
  const clock = new FakeClock();
  const tart = new FakeTart(clock);
  const outcome = await teardown({ clock, tart, warn: () => undefined }, DEFAULT_TUNING, VM, {
    cloneStarted: false,
    vmCloned: false,
  });
  expect(outcome).toEqual({ kind: 'nothing-to-delete' });
  expect(tart.events).toEqual([]);
});

/** Teardown through the real tart helper, with every tart process scripted by `behavior`. */
async function tearDownThroughCli(behavior: FakeCommand) {
  const clock = new FakeClock();
  const fake = new FakeSpawn(clock, () => behavior);
  const tart = createTartCli(fake.spawn, clock);
  const vmProcess = tart.run(VM, { readOnlyShares: [] });
  const outcome = await advanceUntilSettled(
    clock,
    teardown({ clock, tart, warn: () => undefined }, DEFAULT_TUNING, VM, {
      cloneStarted: true,
      vmCloned: true,
      vmProcess,
    }),
    1000,
  );
  return { elapsedMs: clock.now(), fake, outcome };
}

const deletesOf = (fake: FakeSpawn) => fake.calls.filter((call) => call.args[0] === 'delete');

test('stop, run and delete that all hang and ignore SIGTERM still end within the budget with a delete tried', async () => {
  const { elapsedMs, fake, outcome } = await tearDownThroughCli({
    hangs: true,
    ignoresSigterm: true,
  });
  expect(outcome).toMatchObject({ failure: 'killed', kind: 'leaked', vm: VM });
  expect(deletesOf(fake).length).toBeGreaterThanOrEqual(1);
  expect(elapsedMs).toBeLessThanOrEqual(TEARDOWN_BUDGET_MS);
});

test('processes that cannot even be killed still leave teardown inside its budget', async () => {
  const { elapsedMs, fake, outcome } = await tearDownThroughCli({
    hangs: true,
    ignoresSigterm: true,
    unkillable: true,
  });
  expect(outcome).toMatchObject({ kind: 'leaked', vm: VM });
  expect(deletesOf(fake).length).toBeGreaterThanOrEqual(1);
  expect(elapsedMs).toBeLessThanOrEqual(TEARDOWN_BUDGET_MS);
});
