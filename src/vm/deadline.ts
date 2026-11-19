/**
 * The ways the runner bounds work in time. `withDeadline` bounds a call: the job deadline waits for
 * the work to wind down after its signal aborts, since the work reports how it ended; a
 * housekeeping call does not wait, so a wedged guest agent or tart process that ignores its signal
 * cannot hold a run open. `resolvesWithin` bounds the wait for a promise that has no signal to
 * abort, such as a process's exit.
 */
import { messageOf } from '../errors';
import type { Clock } from './tart';

export type DeadlineOptions = {
  /** Aborts the work too, without counting as a timeout. */
  readonly parent?: AbortSignal;
  /**
   * `true`: settle when the work settles, even past the deadline, with what it returned.
   * `false`: settle at the deadline whether or not the work has.
   */
  readonly waitForWork: boolean;
};

/** How the work ended; `timedOut` says whether the deadline passed first. */
export type Deadlined<T> =
  | { readonly ok: true; readonly value: T; readonly timedOut: boolean }
  | { readonly ok: false; readonly why: string; readonly timedOut: boolean };

/**
 * Run `work` with a signal that aborts when `milliseconds` pass on `clock` or when the parent
 * aborts, whichever comes first. A throw is `ok: false` with its message.
 */
export async function withDeadline<T>(
  clock: Clock,
  milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<Deadlined<T>> {
  const { parent } = options;
  const call = new AbortController();
  const timer = new AbortController();
  let timedOut = false;
  const abortCall = (): void => call.abort();
  if (parent?.aborted) {
    abortCall();
  }
  parent?.addEventListener('abort', abortCall, { once: true });
  const attempt = async (): Promise<Deadlined<T>> => {
    try {
      const value = await work(call.signal);
      return { ok: true, timedOut, value };
    } catch (error) {
      return { ok: false, timedOut, why: messageOf(error) };
    }
  };
  // The timer is cancelled only once the call has settled, so a cancelled deadline never wins.
  const deadline = async (): Promise<Deadlined<T>> => {
    const elapsed = await clock.sleep(Math.max(0, milliseconds), timer.signal);
    if (!elapsed) {
      return { ok: false, timedOut, why: 'cancelled' };
    }
    // A parent abort that came first stays an interruption while the work unwinds past the deadline.
    if (!call.signal.aborted) {
      timedOut = true;
      abortCall();
    }
    return { ok: false, timedOut, why: `no answer within ${milliseconds / 1000}s` };
  };
  try {
    if (options.waitForWork) {
      void deadline();
      return await attempt();
    }
    return await Promise.race([attempt(), deadline()]);
  } finally {
    timer.abort();
    parent?.removeEventListener('abort', abortCall);
  }
}

/** What `settling` resolves to if it does so within `milliseconds` of the clock, otherwise undefined. */
export async function resolvesWithin<T>(
  clock: Clock,
  settling: Promise<T>,
  milliseconds: number,
): Promise<T | undefined> {
  const cancel = new AbortController();
  const timeout = async (): Promise<undefined> => {
    await clock.sleep(milliseconds, cancel.signal);
    return undefined;
  };
  try {
    return await Promise.race([settling, timeout()]);
  } finally {
    cancel.abort();
  }
}
