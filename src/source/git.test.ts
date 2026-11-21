import { expect, test } from 'bun:test';

import { FakeClock, FakeSpawn, settle } from '../vm/fake-tart';
import type { FakeCommand } from '../vm/fake-tart';
import { createGit } from './git';

function fakeGit(behavior: FakeCommand, deadlineMs?: number) {
  const clock = new FakeClock();
  const fake = new FakeSpawn(clock, () => behavior);
  const git = createGit(
    { cwd: '/', deadlineMs, env: {}, lazyFetch: false, spawn: fake.spawn, transport: 'https' },
    clock,
  );
  return { call: git(undefined, ['fetch']), clock, fake };
}

test('a hung git call ends at the deadline with SIGTERM and keeps its stdout', async () => {
  const { call, clock, fake } = fakeGit({ hangs: true, output: 'partial output\n' }, 10_000);
  clock.advance(9999);
  await settle();
  expect(fake.calls[0]?.signals).toEqual([]);

  clock.advance(1);
  await settle();
  expect(fake.calls[0]?.signals).toEqual(['SIGTERM']);
  expect(await call).toEqual({
    ok: false,
    stderr: 'git timed out after 10 seconds.',
    stdout: 'partial output\n',
  });
});

test('a hung git call that ignores SIGTERM is killed after the grace period', async () => {
  const { call, clock, fake } = fakeGit({ hangs: true, ignoresSigterm: true }, 10_000);
  clock.advance(10_000);
  await settle();
  expect(fake.calls[0]?.signals).toEqual(['SIGTERM']);

  clock.advance(1000);
  await settle();
  expect(fake.calls[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(await call).toMatchObject({ ok: false, stderr: 'git timed out after 10 seconds.' });
});

test('a git call resolves after SIGKILL even if Loom has not reported its exit', async () => {
  const { call, clock, fake } = fakeGit(
    { hangs: true, ignoresSigterm: true, unkillable: true },
    10_000,
  );
  clock.advance(10_000);
  await settle();
  clock.advance(1000);
  await settle();
  expect(fake.calls[0]?.signals).toEqual(['SIGTERM', 'SIGKILL']);

  clock.advance(1000);
  expect(await call).toMatchObject({ ok: false, stderr: 'git timed out after 10 seconds.' });
  expect(fake.calls[0]?.endedAt).toBeUndefined();
  expect(fake.calls[0]?.abandoned).toBe(true);
});

test('without a deadline git waits for its ordinary exit and output', async () => {
  const { call, clock, fake } = fakeGit({ output: 'done\n', takesMs: 1_200_000 });
  clock.advance(1_200_000);
  expect(await call).toEqual({ ok: true, stderr: '', stdout: 'done\n' });
  expect(fake.calls[0]?.signals).toEqual([]);
});

test('a git call that ends without an exit code fails and keeps its output', async () => {
  const git = createGit({
    cwd: '/',
    env: {},
    lazyFetch: false,
    spawn: () => ({
      abandon: () => undefined,
      exited: Promise.resolve({
        kind: 'abandoned',
        stderr: { bytes: new Uint8Array(), text: 'remote: half\n' },
        stdout: { bytes: new Uint8Array(), text: 'partial\n' },
      }),
      kill: () => undefined,
    }),
    transport: 'https',
  });
  expect(await git(undefined, ['fetch'])).toEqual({
    ok: false,
    stderr: 'remote: half\n',
    stdout: 'partial\n',
  });
});
