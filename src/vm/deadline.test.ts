/* oxlint-disable promise/avoid-new -- work that settles only on abort */
import { describe, expect, test } from 'bun:test';

import { withDeadline } from './deadline';
import { FakeClock, settle } from './fake-tart';

/** Work that settles only once its signal aborts, then returns `value`. */
const untilAborted =
  <T>(value: T) =>
  (signal: AbortSignal): Promise<T> =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(value), { once: true });
    });

/** Work that ignores its signal and never settles, like a wedged guest agent. */
const wedged = (): Promise<string> => new Promise(() => {});

describe.each([true, false])('waitForWork: %p', (waitForWork) => {
  test('work that finishes in time is ok and not timed out', async () => {
    const clock = new FakeClock();
    const result = await withDeadline(clock, 1000, async () => 'done', { waitForWork });
    expect(result).toEqual({ ok: true, timedOut: false, value: 'done' });
  });

  test('work that throws is not ok, with the reason', async () => {
    const clock = new FakeClock();
    const result = await withDeadline(
      clock,
      1000,
      async () => {
        throw new Error('agent refused');
      },
      { waitForWork },
    );
    expect(result).toEqual({ ok: false, timedOut: false, why: 'agent refused' });
  });

  test('a parent abort aborts the work, which is not a timeout', async () => {
    const clock = new FakeClock();
    const parent = new AbortController();
    const pending = withDeadline(clock, 1000, untilAborted('stopped'), {
      parent: parent.signal,
      waitForWork,
    });
    parent.abort();
    expect(await pending).toEqual({ ok: true, timedOut: false, value: 'stopped' });
  });
});

test('waiting for the work: the deadline aborts it and the result is what it returns', async () => {
  const clock = new FakeClock();
  const pending = withDeadline(clock, 1000, untilAborted('cut short'), { waitForWork: true });
  await settle();
  clock.advance(1000);
  expect(await pending).toEqual({ ok: true, timedOut: true, value: 'cut short' });
});

test('not waiting: work that ignores its signal still ends at the deadline', async () => {
  const clock = new FakeClock();
  const pending = withDeadline(clock, 1000, wedged, { waitForWork: false });
  await settle();
  clock.advance(1000);
  expect(await pending).toEqual({ ok: false, timedOut: true, why: 'no answer within 1s' });
});

test('a parent abort stays an interruption when the deadline passes while the work unwinds', async () => {
  const clock = new FakeClock();
  const parent = new AbortController();
  const unwinding = Promise.withResolvers<string>();
  const pending = withDeadline(clock, 1000, () => unwinding.promise, {
    parent: parent.signal,
    waitForWork: true,
  });
  parent.abort();
  await settle();
  clock.advance(1000);
  await settle();
  unwinding.resolve('unwound');
  expect(await pending).toEqual({ ok: true, timedOut: false, value: 'unwound' });
});
