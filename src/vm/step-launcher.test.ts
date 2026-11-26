/* oxlint-disable node/no-sync -- test support: runs a generated script on the host in a throwaway directory */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { RunStep } from '../lane/step-plan';
import { stepFiles } from './guest-paths';
import { stepLogName } from './logs';
import { shellQuote } from './shell';
import { buildStepLauncher, guestPath, shellCommand, splitEnvironment } from './step-launcher';

const step: RunStep = {
  continueOnError: false,
  env: {},
  index: 7,
  kind: 'run',
  name: 'x',
  script: 'echo hi',
  shell: 'bash',
  when: 'success',
};

const launch = (overrides: Partial<Parameters<typeof buildStepLauncher>[0]> = {}): string =>
  buildStepLauncher({ env: {}, extraPath: [], files: stepFiles(7), step, ...overrides });

test('a script that contains the heredoc delimiter still gets a safe one', () => {
  const launcher = launch({ step: { ...step, script: 'echo HUGI_STEP_END' } });
  expect(launcher).toContain("<<'HUGI_STEP_END_X'");
});

test('env values with quotes and newlines are quoted for the shell', () => {
  const launcher = launch({ env: { Q: "it's\nhere" } });
  expect(launcher).toContain(`export Q='it'\\''s\nhere'`);
});

test('extra PATH entries are escaped inside double quotes', () => {
  expect(launch({ extraPath: ['/a "b"/$x'] })).toContain(String.raw`export PATH="/a \"b\"/\$x:`);
});

test('log names are zero-padded and slugged', () => {
  expect(stepLogName(3, 'Run tests / macOS (arm64)!')).toBe('03-run-tests-macos-arm64.log');
  expect(stepLogName(12, '???')).toBe('12-step.log');
});

test('each shell runs as GitHub runs it on macOS', () => {
  expect(shellCommand('default', '/s.sh')).toEqual(['bash', '-e', '/s.sh']);
  expect(shellCommand('bash', '/s.sh')).toEqual([
    'bash',
    '--noprofile',
    '--norc',
    '-eo',
    'pipefail',
    '/s.sh',
  ]);
  expect(shellCommand('sh', '/s.sh')).toEqual(['sh', '-e', '/s.sh']);
});

test('the step shell runs directly, never under a mise wrapper', () => {
  const launcher = launch();
  expect(launcher).not.toContain("'mise'");
  expect(launcher).toContain("'bash' '--noprofile' '--norc' '-eo' 'pipefail'");
});

test('the base PATH is Homebrew, then the system paths, with no mise shims', () => {
  const launcher = launch();
  expect(launcher).toContain(
    'export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
  );
  expect(launcher).not.toContain('shims');
});

test('GITHUB_PATH additions go in front of the base PATH', () => {
  expect(guestPath(['/custom/bin'])).toStartWith('/custom/bin:/opt/homebrew/bin:');
});

test('the inherited PATH is not appended', () => {
  expect(guestPath([])).not.toContain('$PATH');
});

test('a PATH from the environment replaces the base PATH, behind GITHUB_PATH additions', () => {
  const launcher = launch({ env: { PATH: '/only/$here' }, extraPath: ['/added'] });
  expect(launcher).toContain(String.raw`export PATH="/added:/only/\$here"`);
  expect(launcher).not.toContain('mise/shims');
  expect(launcher).not.toContain("export PATH='");
});

test('the step starts detached in a session of its own, with its output and status in guest files', () => {
  const files = stepFiles(7);
  const launcher = launch();
  // A new session makes the step's process group killable as a whole.
  expect(launcher).toContain('POSIX::setsid()');
  expect(launcher).toContain(`echo $$ > '${files.processGroup}'`);
  expect(launcher).toContain(`exec >> '${files.log}' 2>&1 < /dev/null`);
  expect(launcher).toContain(`/bin/mv '${files.status}.tmp' '${files.status}'`);
  // The launcher itself returns at once; nothing it starts keeps tart exec's pipes open.
  expect(launcher.trimEnd()).toEndWith(`>> '${files.log}' 2>&1 < /dev/null &`);
});

test('the step gets SIGINT and SIGQUIT back at their defaults, which a background job of the launcher shell ignores', () => {
  const launcher = launch();
  expect(launcher).toContain('$SIG{INT} = "DEFAULT"; $SIG{QUIT} = "DEFAULT";');
  // The reset comes after the session starts and before the step's shell is exec'd.
  expect(launcher.indexOf('POSIX::setsid()')).toBeLessThan(launcher.indexOf('$SIG{INT}'));
  expect(launcher.indexOf('$SIG{INT}')).toBeLessThan(launcher.indexOf('exec @ARGV'));
});

test('each step starts with fresh, empty GITHUB_ENV, GITHUB_PATH, and GITHUB_OUTPUT files', () => {
  const files = stepFiles(7);
  const launcher = launch();
  for (const [name, file] of [
    ['GITHUB_ENV', files.env],
    ['GITHUB_PATH', files.path],
    ['GITHUB_OUTPUT', files.output],
  ] as const) {
    expect(launcher).toContain(`: > '${file}'`);
    expect(launcher).toContain(`export ${name}='${file}'`);
  }
});

test('a missing working directory fails the step rather than the launcher', () => {
  const launcher = launch({ step: { ...step, workingDirectory: 'pkg' } });
  expect(launcher).toContain("if cd '/Users/admin/hugi/workspace/pkg'; then");
});

describe('an env key that is not a shell name', () => {
  const env = { 'A;touch hacked': 'y=z', FOO: 'plain', 'FOO-BAR': "it's x" };

  test('splits into export lines for shell names and env assignments for the rest', () => {
    expect(splitEnvironment({ ...env, PATH: '/p' })).toEqual({
      envPrefix: `/usr/bin/env 'A;touch hacked=y=z' 'FOO-BAR=it'\\''s x'`,
      exports: [`export FOO='plain'`],
    });
    expect(splitEnvironment({ FOO: 'a' })).toEqual({ envPrefix: '', exports: [`export FOO='a'`] });
  });

  test('the launcher starts the supervisor under env, and exports only shell names', () => {
    const launcher = launch({ env });
    expect(launcher).toContain(`export FOO='plain'`);
    expect(launcher).not.toContain('export FOO-BAR');
    expect(launcher).not.toContain('export A;touch');
    expect(launcher).toContain(
      `\n/usr/bin/env 'A;touch hacked=y=z' 'FOO-BAR=it'\\''s x' /usr/bin/perl `,
    );
  });

  test('a launcher without such keys has no env prefix', () => {
    expect(launch({ env: { FOO: 'a' } })).toContain('\n/usr/bin/perl -e ');
  });

  test('a real bash passes the key to a child verbatim and runs nothing from it', () => {
    const dir = mkdtempSync(join('.scratch', 'env-keys.'));
    try {
      const { envPrefix } = splitEnvironment(env);
      const out = execFileSync(
        '/bin/bash',
        ['-c', `cd ${shellQuote(dir)} && ${envPrefix} /bin/bash -c '/usr/bin/env'`],
        { encoding: 'utf8' },
      );
      expect(out).toContain("FOO-BAR=it's x\n");
      expect(out).toContain('A;touch hacked=y=z\n');
      expect(existsSync(join(dir, 'hacked'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
