/* oxlint-disable node/no-sync -- test support: builds a throwaway workspace and runs the guest script on the host */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { GUEST_CONTROL_DIR, GUEST_RUNNER_PATHS, GUEST_TOOL_FILES } from './guest-paths';
import type { RunRequest } from './run-request';
import { shellQuote } from './shell';
import { configFilesInWorkspace, parseConfigListing } from './tool-environment';
import { configListingScript, guestScript } from './tool-steps';

const mise = Bun.which('mise');
const jq = Bun.which('jq');
const canRun = mise !== null && jq !== null;

const request: RunRequest = {
  event: {
    event: 'push',
    refName: 'main',
    refType: 'branch',
    repository: 'dbtlr/hugi',
    sha: 'abc',
  },
  image: 'hugi-golden',
  logDir: '/mock/logs',
  plan: {
    env: {},
    lane: { job: 'test', matrix: {}, workflow: '.github/workflows/ci.yml' },
    name: 'test',
    steps: [],
    timeoutMinutes: 10,
  },
  source: { cloneUrl: 'https://github.com/dbtlr/hugi.git', kind: 'remote' },
  toolSource: 'mise',
  tools: [],
};

let root = '';
let workspace = '';
let listingFile = '';

beforeAll(() => {
  // Outside the checkout, so no config of this repository is found above the workspace.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'hugi-tool-steps-')));
  workspace = join(root, 'workspace');
  const confd = join(workspace, '.config/mise/conf.d');
  mkdirSync(confd, { recursive: true });
  mkdirSync(join(root, 'outside'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'control'));
  const toml = '[tools]\nbun = "1"\n';
  writeFileSync(join(workspace, 'mise.toml'), toml);
  writeFileSync(join(confd, 'a\tb.toml'), toml);
  writeFileSync(join(confd, 'c\nd.toml'), toml);
  writeFileSync(join(confd, 'quo"te\'s.toml'), toml);
  writeFileSync(join(root, 'outside/elsewhere.toml'), toml);
  symlinkSync(join(root, 'outside/elsewhere.toml'), join(confd, 'link.toml'));
  listingFile = join(root, 'control/listing.txt');
});

afterAll(() => {
  rmSync(root, { force: true, recursive: true });
});

/** Run the generated listing script on the host, with the guest's paths moved under `root`. */
function runListing(): string {
  const script = configListingScript(request)
    .replaceAll(GUEST_TOOL_FILES.configListing, listingFile)
    .replaceAll(GUEST_RUNNER_PATHS.workspace, workspace)
    .replaceAll(GUEST_CONTROL_DIR, join(root, 'control'))
    .replace('export PATH="', `export PATH="${dirname(mise!)}:`);
  const ran = Bun.spawnSync(['bash', '-s'], {
    env: { HOME: join(root, 'home'), PATH: '/usr/bin:/bin' },
    stdin: new TextEncoder().encode(script),
  });
  expect(ran.exitCode, ran.stdout.toString()).toBe(0);
  return readFileSync(listingFile, 'utf8');
}

describe.skipIf(!canRun)('the guest listing script, run on the host with real mise', () => {
  test('keeps file names with a tab, a newline and quotes in one piece', () => {
    const listing = parseConfigListing(runListing());
    const paths = listing.files.map((file) => file.path);
    for (const name of ['a\tb.toml', 'c\nd.toml', 'quo"te\'s.toml']) {
      expect(paths).toContain(join(workspace, '.config/mise/conf.d', name));
    }
    expect(listing.workspace).toBe(workspace);
  });

  test('resolves symbolic links: a workspace link that points outside does not count as inside', () => {
    const listing = parseConfigListing(runListing());
    const link = join(workspace, '.config/mise/conf.d/link.toml');
    expect(listing.files).toContainEqual({
      path: link,
      real: join(root, 'outside/elsewhere.toml'),
    });
    const inside = configFilesInWorkspace(listing);
    expect(inside).not.toContain(link);
    expect(inside).toContain(join(workspace, 'mise.toml'));
    expect(inside).toContain(join(workspace, '.config/mise/conf.d/a\tb.toml'));
    expect(inside).toContain(join(workspace, '.config/mise/conf.d/c\nd.toml'));
  });
});

test('the listing script resolves each file with realpath', () => {
  expect(configListingScript(request)).toContain('realpath "$path"');
});

describe('guestScript', () => {
  test('keeps the marker first, exports only PATH, and runs the lines in a bash that env starts', () => {
    const script = guestScript(
      'x',
      {
        BASH_ENV: '/b',
        'BASH_FUNC_mise%%': '() { echo FAKE; }',
        FOO: "it's",
        PATH: '/wf/bin',
        POSIXLY_CORRECT: '1',
        SHELLOPTS: 'xtrace',
      },
      ['echo "$FOO"', "touch 'ok'"],
    );
    expect(script).toStartWith('# hugi-x\n');
    expect(script.split('\n').filter((line) => line.startsWith('export '))).toEqual([
      'export PATH="/wf/bin"',
    ]);
    expect(script).toEndWith(
      `${String.raw`exec /usr/bin/env -u BASH_ENV -u ENV -u SHELLOPTS -u BASHOPTS -u POSIXLY_CORRECT -- 'FOO=it'\''s' /bin/bash -eo pipefail -c 'echo "$FOO"`}\n${String.raw`touch '\''ok'\'''`}\n`,
    );
  });

  describe('run by a real bash', () => {
    let dir = '';

    beforeEach(() => {
      mkdirSync('.scratch', { recursive: true });
      dir = resolve(mkdtempSync(join('.scratch', 'guest-script.')));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true });
    });

    /** Run `script` as the guest runs a guest script: `bash -s` reading it, in `dir`. */
    const run = (script: string) => {
      const ran = Bun.spawnSync(['/bin/bash', '-s'], {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        stdin: new TextEncoder().encode(script),
      });
      return { code: ran.exitCode, out: ran.stdout.toString() };
    };

    test('hands a child every key exactly, whatever bash makes of the name, and runs nothing from one', () => {
      const env = {
        '-x': 'dash',
        'A;touch hacked': 'q',
        'FOO-BAR': "it's x",
        GROUPS: 'g',
        SECONDS: 'x',
        UID: '5',
      };
      const ran = run(guestScript('x', env, ['/usr/bin/env']));
      expect(ran.code, ran.out).toBe(0);
      const lines = ran.out.split('\n');
      for (const [key, value] of Object.entries(env)) {
        expect(lines).toContain(`${key}=${value}`);
      }
      expect(existsSync(join(dir, 'hacked'))).toBe(false);
    });

    test("no BASH_ENV, SHELLOPTS, POSIXLY_CORRECT or BASH_FUNC_ variable in the environment reaches the wrapper bash or the lines' commands", () => {
      const marker = join(dir, 'sourced');
      const file = join(dir, 'bash-env.sh');
      writeFileSync(file, `touch ${shellQuote(marker)}\n`);
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'mise'), '#!/bin/sh\necho REAL\n', { mode: 0o755 });
      const env = {
        BASH_ENV: file,
        'BASH_FUNC_mise%%': '() { echo FAKE; }',
        ENV: file,
        POSIXLY_CORRECT: '1',
        SHELLOPTS: 'xtrace',
      };
      const ran = run(
        guestScript(
          'x',
          env,
          [
            'echo quiet',
            'type -t mise',
            'mise',
            "set -o | grep '^posix' | tr -s '\t ' ' '",
            '/usr/bin/env | grep -c -e ^BASH_ENV= -e ^ENV= -e ^SHELLOPTS= -e ^POSIXLY_CORRECT= -e ^BASH_FUNC_ || true',
          ],
          [bin],
        ),
      );
      expect(ran.code, ran.out).toBe(0);
      expect(ran.out).toBe('quiet\nfile\nREAL\nposix off\n0\n');
      expect(existsSync(marker)).toBe(false);
    });

    test("a BASH_ENV or SHELLOPTS in the guest shell's own environment does not reach the wrapper bash", () => {
      const marker = join(dir, 'sourced');
      const file = join(dir, 'bash-env.sh');
      writeFileSync(file, `touch ${shellQuote(marker)}\n`);
      const script = guestScript('x', {}, [
        'echo quiet',
        '/usr/bin/env | grep -c ^BASH_ENV= || true',
      ]);
      // Exported by the script's own shell before the exec, as the guest shell's environment would.
      const ran = run(
        script.replace('exec 2>&1\n', `exec 2>&1\nexport BASH_ENV=${shellQuote(file)}\n`),
      );
      expect(ran.code, ran.out).toBe(0);
      expect(ran.out).toBe('quiet\n0\n');
      expect(existsSync(marker)).toBe(false);
    });

    test('a failing line or pipeline fails the script, and its exit code carries out', () => {
      const after = join(dir, 'after');
      expect(run(guestScript('x', {}, ['false', `touch ${shellQuote(after)}`])).code).toBe(1);
      expect(existsSync(after)).toBe(false);
      // pipefail: a failing command anywhere in a pipeline fails it.
      expect(run(guestScript('x', {}, ['false | true', 'exit 0'])).code).toBe(1);
      expect(run(guestScript('x', {}, ['exit 7'])).code).toBe(7);
    });
  });
});
