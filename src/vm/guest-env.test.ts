import { expect, test } from 'bun:test';

import {
  githubEnvironment,
  parseEnvFile,
  parsePathFile,
  prependPaths,
  stepEnvironment,
  toolVersionEnvironment,
} from './guest-env';
import { GUEST_RUNNER_PATHS } from './guest-paths';

const event = {
  event: 'push',
  refName: 'main',
  refType: 'branch',
  repository: 'dbtlr/hugi',
  sha: 'abc123',
} as const;

test('the runner environment mirrors GitHub for a branch push', () => {
  const env = githubEnvironment(event);
  expect(env).toMatchObject({
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_REPOSITORY: 'dbtlr/hugi',
    GITHUB_SHA: 'abc123',
    GITHUB_WORKSPACE: GUEST_RUNNER_PATHS.workspace,
    RUNNER_ARCH: 'ARM64',
    RUNNER_OS: 'macOS',
    RUNNER_TEMP: GUEST_RUNNER_PATHS.temp,
  });
  // Each step gets its own command files, so the runner layer names none.
  expect(env.GITHUB_ENV).toBeUndefined();
  expect(env.GITHUB_PATH).toBeUndefined();
});

test('a tag event gets a refs/tags ref', () => {
  const env = githubEnvironment({ ...event, refName: 'v1.0.0', refType: 'tag' });
  expect(env.GITHUB_REF).toBe('refs/tags/v1.0.0');
  expect(env.GITHUB_REF_TYPE).toBe('tag');
});

test('GITHUB_ENV parses simple assignments, keeping everything after the first =', () => {
  expect(parseEnvFile('A=1\nB=x=y\nC=\n')).toEqual({ env: { A: '1', B: 'x=y', C: '' } });
});

test('GITHUB_ENV parses the multiline KEY<<EOF form', () => {
  expect(parseEnvFile('NOTE<<EOF\nline one\nA=not an assignment\nEOF\nB=2\n')).toEqual({
    env: { B: '2', NOTE: 'line one\nA=not an assignment' },
  });
});

test('GITHUB_ENV lets a later assignment win and skips empty lines', () => {
  expect(parseEnvFile('A=1\n\r\n\nA=2\r\n')).toEqual({ env: { A: '2' } });
});

test('GITHUB_ENV picks the form by whichever of = and << comes first', () => {
  expect(parseEnvFile('A=x<<y\nB<<E\nv=1\nE\n')).toEqual({ env: { A: 'x<<y', B: 'v=1' } });
});

test('an empty file and an empty multiline value both parse', () => {
  expect(parseEnvFile('')).toEqual({ env: {} });
  expect(parseEnvFile('A<<EOF\nEOF\n')).toEqual({ env: { A: '' } });
});

test('malformed GITHUB_ENV content is an error, as on GitHub', () => {
  expect(parseEnvFile('A=1\nB<<EOF\nnever ends\n')).toEqual({
    error: "Invalid environment variable value. Matching delimiter not found 'EOF'",
  });
  expect(parseEnvFile('junk\n')).toEqual({ error: "Invalid environment variable format 'junk'" });
  expect(parseEnvFile('=value\n')).toMatchObject({
    error: expect.stringContaining('name must not be empty'),
  });
  expect(parseEnvFile('<<EOF\nx\nEOF\n')).toMatchObject({
    error: expect.stringContaining('delimiter must not be empty'),
  });
  expect(parseEnvFile('A<<\nx\n')).toMatchObject({
    error: expect.stringContaining('delimiter must not be empty'),
  });
});

test('GITHUB_PATH lists the last-added directory first', () => {
  expect(parsePathFile('/first\n\n/second\n')).toEqual(['/second', '/first']);
});

test("a step's GITHUB_PATH additions go in front of earlier ones, without duplicates", () => {
  expect(prependPaths(['/b', '/a'], ['/c', '/a'])).toEqual(['/c', '/a', '/b']);
});

test('pinned tools become mise per-tool version overrides', () => {
  expect(
    toolVersionEnvironment(['node@22.23.2', 'pnpm@10.0.0', 'powershell-core@7.7.0', 'bun']),
  ).toEqual({
    MISE_NODE_VERSION: '22.23.2',
    MISE_PNPM_VERSION: '10.0.0',
    MISE_POWERSHELL_CORE_VERSION: '7.7.0',
  });
});

test('step env beats GITHUB_ENV, which beats plan env, which beats the runner', () => {
  const env = stepEnvironment({
    fromGithubEnv: { C: 'file', D: 'file' },
    plan: { B: 'plan', C: 'plan', D: 'plan' },
    runner: { A: 'runner', B: 'runner', C: 'runner', D: 'runner' },
    step: { D: 'step' },
  });
  expect(env).toEqual({ A: 'runner', B: 'plan', C: 'file', D: 'step' });
});
