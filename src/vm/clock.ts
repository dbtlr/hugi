import { setTimeout as delay } from 'node:timers/promises';

import type { Clock } from './tart';

/**
 * The system's monotonic clock: `now` counts milliseconds from an arbitrary origin and never steps
 * when the wall clock is set, so durations, deadlines and waits measured on it hold. It is no
 * timestamp; a time written to the state or a record comes from `Date`.
 */
export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: async (milliseconds, signal) => {
    try {
      await delay(milliseconds, undefined, { signal });
      return true;
    } catch {
      return false; // the signal cancelled the sleep
    }
  },
};
