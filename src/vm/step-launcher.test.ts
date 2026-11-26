/* oxlint-disable node/no-sync -- test support: runs a generated script on the host in a throwaway directory */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { RunStep } from '../lane/step-plan';
import { GUEST_RUNNER_PATHS, stepFiles } from './guest-paths';
import { stepLogName } from './logs';
import { shellQuote } from './shell';
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
  expect(launcher).toContain(`'Q=it'\\''s\nhere'`);
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

describe("the step's environment", () => {
  test('reaches the step shell through env on its own command, and Hugi exports only what it owns', () => {
    const launcher = launch({
      env: { FOO: 'plain', 'FOO-BAR': "it's x", GITHUB_ENV: '/wf/env', PATH: '/wf/bin' },
    });
    expect(launcher).toContain(
      `\n  /usr/bin/env -- 'FOO=plain' 'FOO-BAR=it'\\''s x' 'bash' '--noprofile' '--norc' '-eo' 'pipefail' `,
    );
    expect(launcher.split('\n').filter((line) => line.startsWith('export '))).toEqual([
      `export GITHUB_ENV='${stepFiles(7).env}'`,
      `export GITHUB_PATH='${stepFiles(7).path}'`,
      `export GITHUB_OUTPUT='${stepFiles(7).output}'`,
      'export PATH="/wf/bin"',
    ]);
    expect(launcher).not.toContain("'GITHUB_ENV=");
    expect(launcher).not.toContain("'PATH=");
    // The supervisor starts with nothing in front of the session's start.
    expect(launcher).toContain('\n/usr/bin/perl -e ');
  });

  test('with no variables, the step shell still runs under env', () => {
    expect(launch()).toContain("\n  /usr/bin/env -- 'bash' '--noprofile' ");
  });
});

/**
 * Run the generated launcher under the host's `/bin/bash` (3.2, as the guest's), with the guest's
 * directories moved under a scratch directory, then wait up to ten seconds for the step's status.
 */
function runLauncher(
  dir: string,
  env: Record<string, string>,
  script: string,
): { readonly log: string; readonly status: string | undefined } {
  const guestRoot = dirname(GUEST_RUNNER_PATHS.workspace);
  const local = (text: string): string => text.replaceAll(guestRoot, dir);
  const files = stepFiles(7);
  mkdirSync(local(GUEST_RUNNER_PATHS.workspace), { recursive: true });
  mkdirSync(local(GUEST_RUNNER_PATHS.temp), { recursive: true });
  execFileSync('/bin/bash', ['-s'], {
    cwd: dir,
    env: { PATH: '/usr/bin:/bin' },
    input: local(launch({ env, step: { ...step, script } })),
  });
  const status = local(files.status);
  for (let waited = 0; !existsSync(status) && waited < 10_000; waited += 50) {
    Bun.sleepSync(50);
  }
  return {
    log: readFileSync(local(files.log), 'utf8'),
    status: existsSync(status) ? readFileSync(status, 'utf8').trim() : undefined,
  };
}

describe('the generated launcher, run by a real bash', () => {
  let dir = '';

  beforeEach(() => {
    mkdirSync('.scratch', { recursive: true });
    dir = realpathSync(mkdtempSync(join('.scratch', 'launcher.')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
  });

  test('hands every key to the step exactly, whatever bash makes of the name, and runs nothing from one', () => {
    const marker = join(dir, 'INJECTED');
    const env = {
      [`-S/x=1 touch ${marker}`]: 'dash-s',
      '-x': 'dash',
      'A;touch hacked': 'y=z',
      DIRSTACK: 'x',
      'FOO-BAR': "it's x",
      FUNCNAME: 'f',
      GROUPS: 'g',
      SECONDS: 'x',
      UID: '5',
    };
    const seen = join(dir, 'seen');
    const ran = runLauncher(dir, env, `/usr/bin/env > ${shellQuote(seen)}`);
    expect(ran.status, ran.log).toBe('0');
    const lines = readFileSync(seen, 'utf8').split('\n');
    for (const [key, value] of Object.entries(env)) {
      expect(lines).toContain(`${key}=${value}`);
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, 'workspace/hacked'))).toBe(false);
  });

  test("keeps Hugi's command files over the workflow's values of their names", () => {
    const seen = join(dir, 'seen');
    const ran = runLauncher(
      dir,
      { GITHUB_ENV: '/wf/env', GITHUB_OUTPUT: '/wf/out', GITHUB_PATH: '/wf/path' },
      `/usr/bin/env > ${shellQuote(seen)}`,
    );
    expect(ran.status, ran.log).toBe('0');
    const lines = readFileSync(seen, 'utf8').split('\n');
    for (const [name, file] of [
      ['GITHUB_ENV', 'github_env'],
      ['GITHUB_OUTPUT', 'github_output'],
      ['GITHUB_PATH', 'github_path'],
    ] as const) {
      expect(lines).toContain(`${name}=${join(dir, `control/step-07/${file}`)}`);
    }
    expect(lines.filter((line) => line.includes('=/wf/'))).toEqual([]);
  });

  test('a SHELLOPTS of errexit reaches only the step shell, so a failing step writes its status', () => {
    const ran = runLauncher(dir, { SHELLOPTS: 'errexit' }, 'false');
    expect(ran.status, ran.log).toBe('1');
  });

  test("a SHELLOPTS of xtrace traces the step's lines, not the supervisor's", () => {
    const ran = runLauncher(dir, { SHELLOPTS: 'xtrace' }, 'echo traced');
    expect(ran.status, ran.log).toBe('0');
    expect(ran.log).toContain('+ echo traced');
    expect(ran.log).not.toContain('code=');
  });

  test('a BASH_ENV is sourced by the step shell alone', () => {
    const marker = join(dir, 'sourced');
    const file = join(dir, 'bash-env.sh');
    writeFileSync(file, `echo "$$" >> ${shellQuote(marker)}\n`);
    const ran = runLauncher(dir, { BASH_ENV: file }, 'true');
    expect(ran.status, ran.log).toBe('0');
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  // The guest's env is macOS's, which refuses these keys; GNU env on a Linux host accepts them.
  test.skipIf(process.platform !== 'darwin').each(['=LEAD', ''])(
    "a key env cannot set (%p) fails the step promptly, with env's message in its log",
    (key) => {
      const ran = runLauncher(dir, { [key]: 'x' }, 'true');
      expect(ran.status).toBeDefined();
      expect(ran.status).not.toBe('0');
      expect(ran.log).toContain(`env: setenv ${key}=x`);
    },
  );
});
