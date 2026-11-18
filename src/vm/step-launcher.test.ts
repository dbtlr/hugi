import { expect, test } from 'bun:test';

import type { RunStep } from '../lane/step-plan';
import { stepFiles } from './guest-paths';
import { stepLogName } from './logs';
import { buildStepLauncher, guestPath, shellCommand } from './step-launcher';

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

test('PATH starts with the mise shims, then Homebrew, then the system paths', () => {
  expect(launch()).toContain(
    'export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
  );
});

test('GITHUB_PATH additions go in front of the mise shims', () => {
  expect(guestPath(['/custom/bin'])).toStartWith('/custom/bin:$HOME/.local/share/mise/shims:');
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

test('each step starts with fresh, empty GITHUB_ENV and GITHUB_PATH files', () => {
  const files = stepFiles(7);
  const launcher = launch();
  expect(launcher).toContain(`: > '${files.env}'`);
  expect(launcher).toContain(`: > '${files.path}'`);
  expect(launcher).toContain(`export GITHUB_ENV='${files.env}'`);
  expect(launcher).toContain(`export GITHUB_PATH='${files.path}'`);
});

test('a missing working directory fails the step rather than the launcher', () => {
  const launcher = launch({ step: { ...step, workingDirectory: 'pkg' } });
  expect(launcher).toContain("if cd '/Users/admin/hugi/workspace/pkg'; then");
});
