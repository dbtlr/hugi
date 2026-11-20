import { expect, test } from 'bun:test';

import { FakeClock, FakeTart } from './fake-tart';
import { SERVICE_VM_PREFIX } from './lifecycle';
import { sweepVms } from './sweep';

const BYSTANDERS = ['hugi-svc', 'hugi-run-x', 'ci-timing-base', 'hugi-golden', 'xhugi-svc-a'];

/** The error a promise rejects with. */
async function failureOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
}

const setup = (vms: string[], guest: { deleteErrors?: number; listError?: string } = {}) => {
  const tart = new FakeTart(new FakeClock(), { steps: {}, vms, ...guest });
  return tart;
};

test('a sweep deletes the VMs with the prefix and no other', async () => {
  const tart = setup([...BYSTANDERS, 'hugi-svc-a', 'hugi-svc-b']);
  const result = await sweepVms(tart, SERVICE_VM_PREFIX);
  expect(result).toEqual({ deleted: ['hugi-svc-a', 'hugi-svc-b'], failed: [] });
  expect(await tart.list()).toEqual(BYSTANDERS);
  expect(tart.events.filter((event) => event.startsWith('delete'))).toEqual([
    'delete hugi-svc-a',
    'delete hugi-svc-b',
  ]);
});

test('a sweep of an empty host deletes nothing', async () => {
  const result = await sweepVms(setup(BYSTANDERS), SERVICE_VM_PREFIX);
  expect(result).toEqual({ deleted: [], failed: [] });
});

test('a failed delete is recorded and the sweep continues', async () => {
  const tart = setup(['hugi-svc-a', 'hugi-svc-b'], { deleteErrors: 1 });
  const result = await sweepVms(tart, SERVICE_VM_PREFIX);
  expect(result.deleted).toEqual(['hugi-svc-b']);
  expect(result.failed).toEqual([{ message: 'vm is busy', vm: 'hugi-svc-a' }]);
});

test('a failed list propagates', async () => {
  const tart = setup([], { listError: 'tart is wedged' });
  expect(String(await failureOf(sweepVms(tart, SERVICE_VM_PREFIX)))).toContain('tart is wedged');
});

test.each(['', 'hugi-', 'hugi-svc', 'hugi-svc-x-', 'hugi-Run-', 'ci-', 'hugi-1-', 'hugi--'])(
  'the prefix %p is refused before any tart call',
  async (prefix) => {
    const tart = setup(['hugi-svc-a']);
    expect(String(await failureOf(sweepVms(tart, prefix)))).toContain('not allowed');
    expect(tart.events).toEqual([]);
  },
);
