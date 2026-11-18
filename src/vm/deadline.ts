import type { Clock } from './tart';

/**
 * Run `work` with a signal that aborts when `milliseconds` pass on `clock` or
 * when `parent` aborts, whichever comes first. `timedOut` tells which.
 */
export async function withDeadline<T>(
  clock: Clock,
  milliseconds: number,
  parent: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ readonly value: T; readonly timedOut: boolean }> {
  const work$ = new AbortController();
  const timer = new AbortController();
  let timedOut = false;
  const abortWork = (): void => work$.abort();
  if (parent.aborted) {
    abortWork();
  }
  parent.addEventListener('abort', abortWork, { once: true });
  const watchTimer = async (): Promise<void> => {
    const elapsed = await clock.sleep(Math.max(0, milliseconds), timer.signal);
    if (!elapsed) {
      return;
    }
    timedOut = true;
    abortWork();
  };
  void watchTimer();
  try {
    const value = await work(work$.signal);
    return { timedOut, value };
  } finally {
    timer.abort();
    parent.removeEventListener('abort', abortWork);
  }
}
