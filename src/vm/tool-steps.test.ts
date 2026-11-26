/* oxlint-disable node/no-sync -- test support: builds a throwaway workspace and runs the guest script on the host */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

describe('guestScript with a key that is not a shell name', () => {
  const lines = ['echo "$FOO"', 'touch ok'];

  test('has no env prefix, and exports only shell names, when every key is one', () => {
    const script = guestScript('x', { FOO: 'a' }, lines);
    expect(script).toStartWith('# hugi-x\n');
    expect(script).toContain("export FOO='a'");
    expect(script).not.toContain('exec /usr/bin/env');
    expect(script).toContain('\ntouch ok\n');
  });

  test('keeps the marker first and runs the lines under env, which a real bash carries to a child', () => {
    mkdirSync('.scratch', { recursive: true });
    const dir = mkdtempSync(join('.scratch', 'guest-script.'));
    try {
      const script = guestScript('x', { 'A;touch hacked': 'q', FOO: "it's", 'FOO-BAR': 'x' }, [
        'echo "$FOO"',
        "/usr/bin/env | grep -F 'FOO-BAR='",
        `touch ${resolve(dir)}/ran`,
      ]);
      expect(script).toStartWith('# hugi-x\n');
      expect(script).toContain(String.raw`export FOO='it'\''s'`);
      const ran = Bun.spawnSync(['bash', '-s'], {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        stdin: new TextEncoder().encode(script),
      });
      expect(ran.exitCode, ran.stdout.toString()).toBe(0);
      expect(ran.stdout.toString()).toContain("it's\nFOO-BAR=x\n");
      expect(existsSync(join(dir, 'ran'))).toBe(true);
      expect(existsSync(join(dir, 'hacked'))).toBe(false);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
