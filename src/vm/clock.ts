import { setTimeout as delay } from 'node:timers/promises';

import type { Clock } from './tart';

/** The wall clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: async (milliseconds, signal) => {
    try {
      await delay(milliseconds, undefined, { signal });
      return true;
    } catch {
      return false; // the signal cancelled the sleep
    }
  },
};
