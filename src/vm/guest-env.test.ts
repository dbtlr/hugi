import { expect, test } from 'bun:test';

import {
  carriedGithubEnv,
  githubEnvironment,
  parseEnvFile,
  parseExportedVariables,
  parseOutputFile,
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
  expect(env.GITHUB_OUTPUT).toBeUndefined();
});

test('GITHUB_OUTPUT accepts the GITHUB_ENV grammar', () => {
  expect(parseOutputFile('a=1\nfiles<<EOF\nx\ny\nEOF\n')).toBeUndefined();
  expect(parseOutputFile('')).toBeUndefined();
});

test("malformed GITHUB_OUTPUT content is an error in GitHub's wording", () => {
  // `echo "files=$(printf 'a\nb')"` writes a bare second line.
  expect(parseOutputFile('files=a\nb\n')).toBe(
    "Unable to process file command 'output' successfully. Invalid format 'b'",
  );
  expect(parseOutputFile('x<<EOF\nno end\n')).toBe(
    "Unable to process file command 'output' successfully. Invalid value. Matching delimiter not found 'EOF'",
  );
  expect(parseOutputFile('=v\n')).toContain('Name must not be empty');
});

test('a push event has empty head and base refs', () => {
  const env = githubEnvironment(event);
  expect(env.GITHUB_HEAD_REF).toBe('');
  expect(env.GITHUB_BASE_REF).toBe('');
});

test('a pull_request event exports the merge ref, not a branch ref, and both branch names', () => {
  const env = githubEnvironment({
    event: 'pull_request',
    pullRequest: { baseRef: 'main', headRef: 'feature', headSha: 'def456', number: 7 },
    repository: 'dbtlr/hugi',
    sha: 'abc123',
  });
  expect(env).toMatchObject({
    GITHUB_BASE_REF: 'main',
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_HEAD_REF: 'feature',
    GITHUB_REF: 'refs/pull/7/merge',
    GITHUB_REF_NAME: '7/merge',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_SHA: 'abc123',
  });
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
  expect(parseEnvFile('A=1\nB<<EOF\nnever ends\n')).toMatchObject({
    error: "Invalid environment variable value. Matching delimiter not found 'EOF'",
  });
  expect(parseEnvFile('junk\n')).toMatchObject({
    error: "Invalid environment variable format 'junk'",
  });
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

test('a malformed GITHUB_ENV keeps the assignments before the bad line, as GitHub does', () => {
  expect(parseEnvFile('A=1\nNOTE<<EOF\nx\nEOF\nB=2\njunk\nC=3\n')).toEqual({
    env: { A: '1', B: '2', NOTE: 'x' },
    error: "Invalid environment variable format 'junk'",
  });
  expect(parseEnvFile('A=1\nB<<EOF\nnever ends\n')).toMatchObject({ env: { A: '1' } });
  expect(parseEnvFile('A=1\n=value\nB=2\n')).toMatchObject({ env: { A: '1' } });
  expect(parseEnvFile('A=1\nB<<\nx\n')).toMatchObject({ env: { A: '1' } });
});

test('exported variables read back from GITHUB_ENV keep a name like FOO-BAR and any value exactly', () => {
  const variables = { '-x': '', 'A-B': 'v', 'FOO-BAR': 'x=y\nZ<<EOF\n' };
  expect(parseExportedVariables(variables)).toEqual({ env: variables });
});

test.each([
  ['A=B', "Invalid environment variable format 'v'"],
  ['=X', 'Environment variable name must not be empty'],
  ['C<<D', "Invalid environment variable value. Matching delimiter not found 'D<<ghadelimiter_"],
  ['E\nF', "Invalid environment variable format 'E'"],
])(
  "an exported name %p GITHUB_ENV cannot carry is the runner's error, keeping the writes before it",
  (name, message) => {
    // In write order: the bad name between two good ones.
    const read = parseExportedVariables(
      Object.fromEntries([
        ['EARLIER', 'kept'],
        [name, 'v'],
        ['LATER', 'x'],
      ]),
    );
    expect(read.error).toContain(message);
    expect(read.env).toMatchObject({ EARLIER: 'kept' });
    expect(read.env).not.toHaveProperty(name);
  },
);

test("GitHub's runner refuses NODE_OPTIONS from GITHUB_ENV in any case, with its message for each", () => {
  expect(carriedGithubEnv({ A: '1', NODE_OPTIONS: '--x', node_options: '--y' })).toEqual({
    env: { A: '1' },
    refused: [
      "Can't store NODE_OPTIONS output parameter using '$GITHUB_ENV' command.",
      "Can't store NODE_OPTIONS output parameter using '$GITHUB_ENV' command.",
    ],
  });
  expect(carriedGithubEnv({ NODE_OPTIONS_EXTRA: '1' })).toEqual({
    env: { NODE_OPTIONS_EXTRA: '1' },
    refused: [],
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

test('a long file of heredoc entries parses in time linear in its length', () => {
  const records = Array.from({ length: 60_000 }, (_, i) => `K${i}<<EOF\nv${i}\nEOF`).join('\n');
  const started = performance.now();
  const parsed = parseEnvFile(`${records}\n`);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(parsed.env.K59999).toBe('v59999');
});
