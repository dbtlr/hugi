import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { FatalError } from '@loomcli/core';
import type { Host } from '@loomcli/core';

import {
  findExecutable,
  HostToolsError,
  requireHostTools,
  serviceEnvironment,
  spawnWithTools,
} from './host-tools';

test('findExecutable returns the first executable and stops searching', async () => {
  const visited: string[] = [];
  const match = findExecutable('git', '/missing:/first:/later', (candidate) => {
    visited.push(candidate);
    return candidate !== '/missing/git';
  });
  expect(match).toBe('/first/git');
  expect(visited).toEqual(['/missing/git', '/first/git']);
});

test('findExecutable returns undefined when PATH has no match or is unset', async () => {
  expect(findExecutable('git', '/nowhere:/also-nowhere', () => false)).toBeUndefined();
  expect(findExecutable('git', undefined, () => true)).toBeUndefined();
});

test('findExecutable returns an absolute path for relative and empty PATH entries', async () => {
  expect(findExecutable('git', 'tools:/elsewhere', () => true)).toBe(resolve('tools/git'));
  expect(findExecutable('git', ':/elsewhere', () => true)).toBe(resolve('git'));
});

test('the production lookup accepts executable files and refuses directories', async () => {
  expect(findExecutable('sh', '/bin')).toBe('/bin/sh');
  expect(findExecutable('bin', '/usr')).toBeUndefined();
});

// Root passes the execute check whatever the mode, so the test means nothing as root.
const unlessRoot = test.skipIf(process.getuid?.() === 0);

unlessRoot('the production lookup skips a file this user cannot execute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hugi-hosttools-'));
  try {
    await mkdir(join(root, 'first'));
    await mkdir(join(root, 'later'));
    await writeFile(join(root, 'first', 'tool'), '#!/bin/sh\n');
    await chmod(join(root, 'first', 'tool'), 0o001); // only "other" may execute it, so this user may not
    await writeFile(join(root, 'later', 'tool'), '#!/bin/sh\n');
    await chmod(join(root, 'later', 'tool'), 0o755);
    expect(findExecutable('tool', `${join(root, 'first')}:${join(root, 'later')}`)).toBe(
      join(root, 'later', 'tool'),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('requireHostTools returns the resolved paths when both tools are present', async () => {
  const installed = new Set(['/first/tart', '/second/git']);
  const tools = requireHostTools({ PATH: '/first:/second' }, ['tart', 'git'], (candidate) =>
    installed.has(candidate),
  );
  expect(tools).toEqual({ git: '/second/git', tart: '/first/tart' });
});

test('requireHostTools names every missing tool, the searched PATH and the fix', async () => {
  const failure = failureOf(() =>
    requireHostTools({ PATH: '/first:/second' }, ['tart', 'git'], () => false),
  );
  expect(failure).toBeInstanceOf(FatalError);
  expect(HostToolsError.exitCode).toBe(1);
  expect(failure).toMatchObject({
    message: expect.stringMatching(
      /tart.*git.*PATH.*\/first:\/second.*Put the directories that hold them on PATH\./iu,
    ),
  });
});

/** The error `act` throws, or undefined when it returns. */
function failureOf(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  return undefined;
}

test('serviceEnvironment gives the unit the installing PATH when it finds tart and git', () => {
  const installed = new Set(['/opt/homebrew/bin/tart', '/usr/bin/git']);
  const env = { HOME: '/Users/me', PATH: '/opt/homebrew/bin:/usr/bin' };
  expect(serviceEnvironment(env, (candidate) => installed.has(candidate))).toEqual({
    PATH: '/opt/homebrew/bin:/usr/bin',
  });
});

test('serviceEnvironment refuses the install when the installing PATH lacks tart or git', () => {
  const installed = new Set(['/usr/bin/git']);
  const failure = failureOf(() =>
    serviceEnvironment({ PATH: '/usr/bin:/bin' }, (candidate) => installed.has(candidate)),
  );
  expect(failure).toBeInstanceOf(HostToolsError);
  expect(failure).toMatchObject({
    message: expect.stringMatching(/tools tart on PATH "\/usr\/bin:\/bin".*service install/su),
  });
});

test('serviceEnvironment copies only the absolute PATH entries, which launchd reads alike', () => {
  const installed = new Set(['/opt/homebrew/bin/tart', '/usr/bin/git']);
  const env = { PATH: 'bin:/opt/homebrew/bin::.:/usr/bin:' };
  expect(serviceEnvironment(env, (candidate) => installed.has(candidate))).toEqual({
    PATH: '/opt/homebrew/bin:/usr/bin',
  });
});

test('serviceEnvironment refuses the install when only a relative PATH entry finds tart', () => {
  const installed = new Set([resolve('bin/tart'), '/usr/bin/git']);
  const failure = failureOf(() =>
    serviceEnvironment({ PATH: 'bin:/usr/bin' }, (candidate) => installed.has(candidate)),
  );
  expect(failure).toBeInstanceOf(HostToolsError);
  expect(failure).toMatchObject({
    message: expect.stringMatching(/tools tart on PATH "\/usr\/bin"/u),
  });
});

test('serviceEnvironment refuses the install when PATH is unset', () => {
  expect(failureOf(() => serviceEnvironment({}, () => true))).toBeInstanceOf(HostToolsError);
});

test('spawnWithTools runs a resolved tool by its path, with the service environment', () => {
  const calls: { command: string; env: unknown }[] = [];
  const spawn: Host['spawn'] = (command, _args, options) => {
    calls.push({ command, env: options?.env });
    return {
      abandon: () => undefined,
      exited: Promise.resolve({ error: new Error('unused'), kind: 'unstarted' }),
      kill: () => undefined,
    };
  };
  const env = { PATH: '/opt/homebrew/bin' };
  const wrapped = spawnWithTools(spawn, { tart: '/opt/homebrew/bin/tart' }, env);
  wrapped('tart', ['list']);
  wrapped('ps', ['-p', '1'], { env: { PATH: '/x' } });
  expect(calls).toEqual([
    { command: '/opt/homebrew/bin/tart', env },
    { command: 'ps', env: { PATH: '/x' } },
  ]);
});
