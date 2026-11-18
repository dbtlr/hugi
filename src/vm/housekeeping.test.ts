import { expect, test } from 'bun:test';

import { FakeClock } from './fake-tart';
import { copyGuestFile, readGuestFile } from './housekeeping';
import type { GuestCall } from './housekeeping';
import type { Tart } from './tart';

const unused = (): never => {
  throw new Error('not used by a guest file read');
};

/** A tart whose guest prints every file in three chunks. */
const chunkedTart: Tart = {
  clone: unused,
  delete: unused,
  exec: async (_vm, _argv, options) => {
    for (const chunk of ['first ', 'second ', 'third\n']) {
      options?.onOutput?.(chunk);
    }
    return { exitCode: 0 };
  },
  run: unused,
  setResources: unused,
  stop: unused,
};

function chunkedGuest(): GuestCall {
  return { clock: new FakeClock(), deadlineMs: 1000, tart: chunkedTart, vm: 'hugi-run-x' };
}

test('a copied guest file goes to the sink chunk by chunk, without being held whole', async () => {
  const chunks: string[] = [];
  const copied = await copyGuestFile(chunkedGuest(), '/guest/step.log', (chunk) => {
    chunks.push(chunk);
  });
  expect(copied).toEqual({ ok: true, timedOut: false, value: undefined });
  expect(chunks).toEqual(['first ', 'second ', 'third\n']);
});

test('a read guest file returns its whole text', async () => {
  expect(await readGuestFile(chunkedGuest(), '/guest/env')).toEqual({
    ok: true,
    timedOut: false,
    value: 'first second third\n',
  });
});
