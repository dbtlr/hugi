import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockProcess } from '@loomcli/testing';

import { createApp } from '../app';
import { PullRequestReadError } from '../github/pull-request';
import type { PullRequestFacts } from '../github/pull-request';
import {
  AmbiguousRefError,
  NoCurrentMergeError,
  NotAFileError,
  SourceError,
} from '../source/host-source';
import type { HostSource } from '../source/host-source';
import type { RunRequest, RunResult } from '../vm';

const SHA = 'b'.repeat(40);
const WORKFLOW = `
on: push
jobs:
  build:
    runs-on: macos-latest
    steps:
      - run: echo hi
`;

const result = (overrides: Partial<RunResult>): RunResult => ({
  reason: 'passed',
  steps: [{ index: 1, logFile: '/logs/1.log', name: 'step 1', outcome: 'success', seconds: 1.5 }],
  timings: { bootSeconds: 1, cloneSeconds: 1, totalSeconds: 4 },
  verdict: 'pass',
  ...overrides,
});

const source = (
  files: Record<string, string> = { '.github/workflows/ci.yml': WORKFLOW },
  commit = 'main',
): HostSource => ({
  changedFiles: async () => [],
  guestSource: async () => ({
    location: { cloneUrl: 'https://github.com/example/project.git', kind: 'remote' },
    release: async () => {},
  }),
  readFile: async (path) => files[path],
  sha: SHA,
  ...(commit === 'main' ? { refKind: 'branch' as const } : {}),
});

async function hugi(argv: string[], vm: RunResult | undefined, files?: Record<string, string>) {
  const requests: RunRequest[] = [];
  const mock = mockProcess({ argv, env: {}, stdin: '' });
  const exitCode = await createApp({
    openSource: async (_spec, commit) => source(files, commit),
    runInVm: async (request) => {
      requests.push(request);
      if (vm === undefined) {
        throw new Error('the VM must not run');
      }
      return vm;
    },
  }).run({ process: mock });
  return { exitCode, requests, stderr: mock.stderr.text, stdout: mock.stdout.text };
}

/** A real directory for `--logs`, because a run writes its record there before its VM boots. */
const LOGS = await mkdtemp(join(tmpdir(), 'hugi-run-test-'));
afterAll(() => rm(LOGS, { force: true, recursive: true }));

const ARGS = ['run', 'example/project', 'main', 'ci.yml:build', '--logs', LOGS];

test('a passing run exits 0 and prints the steps, verdict, and log directory', async () => {
  const { exitCode, stdout, requests } = await hugi(ARGS, result({}));
  expect(exitCode).toBe(0);
  expect(requests).toHaveLength(1);
  expect(stdout).toContain('step 1');
  expect(stdout).toContain('/logs/1.log');
  expect(stdout).toContain('verdict: pass (passed)');
  expect(stdout).toContain(`logs: ${LOGS}`);
});

test('a failing step exits 1', async () => {
  const { exitCode, stdout } = await hugi(ARGS, result({ reason: 'step-failed', verdict: 'fail' }));
  expect(exitCode).toBe(1);
  expect(stdout).toContain('verdict: fail (step-failed)');
});

test.each(['infrastructure', 'interrupted'] as const)('%s exits 3', async (reason) => {
  const { exitCode } = await hugi(ARGS, result({ detail: 'x', reason, verdict: 'none' }));
  expect(exitCode).toBe(3);
});

test('a lane that cannot be read exits 1, prints the reader error, and never runs the VM', async () => {
  const { exitCode, requests, stdout } = await hugi(ARGS, undefined, {
    '.github/workflows/ci.yml': WORKFLOW.replace('macos-latest', 'ubuntu-latest'),
  });
  expect(exitCode).toBe(1);
  expect(requests).toHaveLength(0);
  expect(stdout).toContain('lane-unreadable');
  expect(stdout).toContain('ubuntu-latest');
});

test('a missing job exits 2 with the reader error and never runs the VM', async () => {
  const { exitCode, requests, stderr } = await hugi(
    ['run', 'example/project', 'main', 'ci.yml:nope', '--logs', LOGS],
    undefined,
  );
  expect(exitCode).toBe(2);
  expect(requests).toHaveLength(0);
  expect(stderr).toContain('no job named "nope"');
});

test('a job skipped for the event exits 2 and says there is no verdict', async () => {
  const { exitCode, requests, stderr } = await hugi(ARGS, undefined, {
    '.github/workflows/ci.yml': WORKFLOW.replace(
      'runs-on:',
      "if: github.event_name == 'pull_request'\n    runs-on:",
    ),
  });
  expect(exitCode).toBe(2);
  expect(requests).toHaveLength(0);
  expect(stderr).toContain('skipped for this event');
});

const WITH_ACTIONS = `
on: push
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.4 }
      - uses: actions/upload-artifact@v4
        with: { name: out, path: out, if-no-files-found: error }
      - run: echo hi
`;

const withActions = result({
  steps: [
    { index: 0, logFile: '/logs/0.log', name: 'Install tools', outcome: 'success', seconds: 3 },
    {
      index: 1,
      logFile: '/logs/1.log',
      name: 'actions/checkout@v4',
      note: 'checked out bbbbbbb',
      outcome: 'success',
      seconds: 2,
    },
    { index: 2, name: 'oven-sh/setup-bun@v2', outcome: 'skipped', seconds: 0 },
    { index: 3, name: 'actions/upload-artifact@v4', outcome: 'skipped', seconds: 0 },
    { index: 4, logFile: '/logs/4.log', name: 'step 4', outcome: 'success', seconds: 1 },
  ],
});

test('the text report shows each action as resolved and prints the resolution notes', async () => {
  const { exitCode, stdout } = await hugi(ARGS, withActions, {
    '.github/workflows/ci.yml': WITH_ACTIONS,
    'rust-toolchain': '1.90.0\n',
  });
  expect(exitCode).toBe(0);
  expect(stdout).not.toMatch(/^skipped/m);
  expect(stdout).toMatch(
    /success +2\.0s  actions\/checkout@v4: checked out bbbbbbb  \/logs\/1\.log/,
  );
  expect(stdout).toMatch(/resolved .*oven-sh\/setup-bun@v2: bun@1\.4\.4/);
  expect(stdout).toMatch(
    /resolved .*actions\/upload-artifact@v4: no-op: .*existence check is skipped/,
  );
  expect(stdout).toContain(
    'note: rust-toolchain: rustup in the guest handles components and profile.',
  );
});

test('the JSON report carries the resolution and its notes', async () => {
  const { stdout } = await hugi([...ARGS, '--format', 'json'], withActions, {
    '.github/workflows/ci.yml': WITH_ACTIONS,
    'rust-toolchain': '1.90.0\n',
  });
  const report: unknown = JSON.parse(stdout);
  expect(report).toMatchObject({
    steps: [
      { outcome: 'success' },
      { note: 'checked out bbbbbbb', outcome: 'success' },
      { action: { kind: 'tools', tools: ['bun@1.4.4'] }, outcome: 'resolved' },
      { action: { kind: 'noop' }, outcome: 'resolved' },
      { outcome: 'success' },
    ],
    toolchain: {
      notes: ['rust-toolchain: rustup in the guest handles components and profile.'],
      tools: ['bun@1.4.4', 'rust@1.90.0'],
    },
  });
  expect(stdout).toContain('existence check is skipped');
});

test('--format json prints the report as JSON', async () => {
  const { exitCode, stdout } = await hugi([...ARGS, '--format', 'json'], result({}));
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ reason: 'passed', sha: SHA, verdict: 'pass' });
});

test('a leaked VM is named in the text report with how to remove it, and in the JSON report', async () => {
  const leaked = result({ leakedVm: 'hugi-run-abc' });
  const text = await hugi(ARGS, leaked);
  expect(text.stdout).toContain(
    'leaked VM: hugi-run-abc (remove it with: tart delete hugi-run-abc)',
  );
  const json = await hugi([...ARGS, '--format', 'json'], leaked);
  expect(JSON.parse(json.stdout)).toMatchObject({ leakedVm: 'hugi-run-abc' });
  const clean = await hugi(ARGS, result({}));
  expect(clean.stdout).not.toContain('leaked');
});

test('--matrix, --needs, and the ref options reach the VM request', async () => {
  const workflow = `
on: push
jobs:
  changes:
    runs-on: ubuntu-latest
    steps:
      - run: 'true'
  build:
    runs-on: \${{ matrix.os }}
    if: needs.changes.outputs.code == 'true'
    needs: changes
    strategy: { matrix: { os: [macos-latest, ubuntu-latest] } }
    steps:
      - run: echo \${{ github.ref_name }}
`;
  const { exitCode, requests } = await hugi(
    [
      'run',
      'example/project',
      SHA,
      'ci.yml:build',
      '--logs',
      LOGS,
      '--matrix',
      'os=macos-latest',
      '--needs',
      'changes.outputs.code=true',
      '--ref-type',
      'tag',
      '--ref-name',
      'v1',
      '--event',
      'push',
    ],
    result({}),
    { '.github/workflows/ci.yml': workflow },
  );
  expect(exitCode).toBe(0);
  expect(requests[0]!.event).toMatchObject({ refName: 'v1', refType: 'tag' });
  expect(requests[0]!.plan.lane.matrix).toEqual({ os: 'macos-latest' });
});

test.each([
  [['run', 'example/project', 'main', 'ci.yml']],
  [['run', 'hugi', 'main', 'ci.yml:build']],
  [['run', 'example/project', 'main', 'ci.yml:build', '--matrix', 'oops']],
  [['run', 'example/project', 'main', 'ci.yml:build', '--event', 'schedule']],
  [['run', 'example/project', SHA, 'ci.yml:build']],
  [['run', 'example/project', 'main', 'ci.yml:build', '--matrix', '__proto__=1']],
  [['run', 'example/project', 'main', 'ci.yml:build', '--needs', '__proto__.outputs.x=1']],
])('usage error %p exits 2 without running the VM', async (argv) => {
  const { exitCode, requests } = await hugi(argv, undefined);
  expect(exitCode).toBe(2);
  expect(requests).toHaveLength(0);
});

test('the help documents the exit codes', async () => {
  const { exitCode, stdout } = await hugi(['run', '--help'], undefined);
  expect(exitCode).toBe(0);
  for (const code of ['0: pass', '1: fail', '2: usage', '3: no verdict', '130 (143 for SIGTERM)']) {
    expect(stdout).toContain(code);
  }
  expect(stdout).toContain('skipped for the event');
});

test('SIGINT waits for the VM teardown, then reports the interrupted run and exits 130', async () => {
  const mock = mockProcess({ argv: ARGS, env: {}, stdin: '' });
  let tornDown = false;
  // The real runner sees the interrupt at once, then spends its teardown stopping and deleting the VM.
  const app = createApp({
    openSource: async () => source(),
    runInVm: async () => {
      await Bun.sleep(2000);
      tornDown = true;
      return result({ detail: 'interrupted by SIGINT', reason: 'interrupted', verdict: 'none' });
    },
  });
  let tornDownWhenEnded: boolean | undefined;
  const watch = setInterval(() => {
    if (mock.endedBy !== undefined && tornDownWhenEnded === undefined) {
      tornDownWhenEnded = tornDown;
    }
  }, 10);
  setTimeout(() => {
    mock.signals.raise('SIGINT');
  }, 400);
  const exitCode = await app.run({ process: mock });
  await Bun.sleep(50);
  clearInterval(watch);
  expect(mock.endedBy).toBe('SIGINT');
  expect(tornDownWhenEnded).toBe(true);
  expect(exitCode).toBe(130);
  expect(mock.stdout.text).toContain('verdict: none (interrupted');
});

/** Runs `hugi run` against a source whose workflow read throws `error`. */
async function hugiWithFailingRead(error: Error) {
  const mock = mockProcess({ argv: ARGS, env: {}, stdin: '' });
  const exitCode = await createApp({
    openSource: async () => ({
      ...source(),
      readFile: async () => {
        throw error;
      },
    }),
    runInVm: async () => {
      throw new Error('the VM must not run');
    },
  }).run({ process: mock });
  return { exitCode, stdout: mock.stdout.text };
}

test('a source read that fails after the source opened has no verdict and exits 3', async () => {
  const { exitCode, stdout } = await hugiWithFailingRead(new SourceError('lazy fetch failed'));
  expect(exitCode).toBe(3);
  expect(stdout).toContain('verdict: none (infrastructure: lazy fetch failed)');
});

test('a lane path that names a directory is an unreadable lane and exits 1', async () => {
  const { exitCode, stdout } = await hugiWithFailingRead(new NotAFileError('ci.yml is a tree'));
  expect(exitCode).toBe(1);
  expect(stdout).toContain('lane-unreadable');
});

test('a commit that names both a branch and a tag exits 2', async () => {
  const mock = mockProcess({ argv: ARGS, env: {}, stdin: '' });
  const exitCode = await createApp({
    openSource: async () => {
      throw new AmbiguousRefError('main');
    },
    runInVm: async () => {
      throw new Error('the VM must not run');
    },
  }).run({ process: mock });
  expect(exitCode).toBe(2);
  expect(mock.stderr.text).toContain('--ref-type');
});

test('an empty --ref-name is a usage error and never runs the VM', async () => {
  const { exitCode, stderr } = await hugi(
    ['run', 'example/project', SHA, 'ci.yml:build', '--ref-name='],
    undefined,
  );
  expect(exitCode).toBe(2);
  expect(stderr).toContain('--ref-name');
});

const HEAD_SHA = 'c'.repeat(40);

const PULL_REQUEST: PullRequestFacts = {
  baseRef: 'main',
  headRef: 'feature',
  headSha: HEAD_SHA,
  mergeCommitSha: SHA,
  mergeable: true,
  number: 7,
  state: 'open',
};

/** Runs `hugi run` with a pull request reader and merge opener in place of GitHub. */
async function hugiPull(
  argv: string[],
  pull: {
    readonly read?: () => Promise<PullRequestFacts>;
    readonly open?: () => Promise<HostSource>;
  } = {},
) {
  const requests: RunRequest[] = [];
  const opened: string[] = [];
  const mock = mockProcess({ argv, env: {}, stdin: '' });
  const exitCode = await createApp({
    openPullRequestSource: pull.open ?? (async () => source()),
    openSource: async (_spec, commit) => {
      opened.push(commit);
      return source(undefined, commit);
    },
    readPullRequest: pull.read ?? (async () => PULL_REQUEST),
    runInVm: async (request) => {
      requests.push(request);
      return result({});
    },
  }).run({ process: mock });
  return { exitCode, opened, requests, stderr: mock.stderr.text, stdout: mock.stdout.text };
}

const PULL_ARGS = ['run', 'example/project', 'pull/7', 'ci.yml:build', '--logs', LOGS];

test('pull/<n> runs the pull request at its merge commit and reports the head', async () => {
  const { exitCode, requests, stdout } = await hugiPull([...PULL_ARGS, '--format', 'json']);
  expect(exitCode).toBe(0);
  expect(requests[0]!.event).toMatchObject({
    event: 'pull_request',
    pullRequest: { number: 7 },
    sha: SHA,
  });
  expect(JSON.parse(stdout)).toMatchObject({
    pullRequest: { headSha: HEAD_SHA, number: 7 },
    sha: SHA,
  });
});

test('--event pull_request with pull/<n> is the same run', async () => {
  const { exitCode, requests } = await hugiPull([...PULL_ARGS, '--event', 'pull_request']);
  expect(exitCode).toBe(0);
  expect(requests[0]!.event.event).toBe('pull_request');
});

test.each([
  ['a missing pull request', new PullRequestReadError('pull request 7 does not exist')],
  ['a rate-limited API', new PullRequestReadError("GitHub's anonymous rate limit is used up")],
])('%s has no verdict and exits 3', async (_name, error) => {
  const { exitCode, requests, stdout } = await hugiPull(PULL_ARGS, {
    read: async () => {
      throw error;
    },
  });
  expect(exitCode).toBe(3);
  expect(requests).toHaveLength(0);
  expect(stdout).toContain(`verdict: none (infrastructure: ${error.message})`);
});

test('a pull request with no current merge has no verdict and exits 3', async () => {
  const { exitCode, requests, stdout } = await hugiPull(PULL_ARGS, {
    open: async () => {
      throw new NoCurrentMergeError('closed', 'Pull request 7 is closed, so it does not run.');
    },
  });
  expect(exitCode).toBe(3);
  expect(requests).toHaveLength(0);
  expect(stdout).toContain('is closed');
});

test.each([
  [['run', './project', 'pull/7', 'ci.yml:build'], 'local repository'],
  [[...PULL_ARGS, '--event', 'push'], '--event push'],
  [['run', 'example/project', 'main', 'ci.yml:build', '--event', 'pull_request'], 'pull/<n>'],
  [[...PULL_ARGS, '--ref-type', 'branch'], '--ref-type'],
  [[...PULL_ARGS, '--ref-name', 'pull/7'], '--ref-name'],
])('usage error %p exits 2 and says what to do', async (argv, message) => {
  const { exitCode, opened, requests, stderr } = await hugiPull(argv);
  expect(exitCode).toBe(2);
  expect(requests).toHaveLength(0);
  expect(opened).toHaveLength(0);
  expect(stderr).toContain(message);
});

test.each(['pull/0', 'pull/abc'])('%s is an ordinary branch name', async (commit) => {
  const { exitCode, opened } = await hugiPull([
    'run',
    'example/project',
    commit,
    'ci.yml:build',
    '--logs',
    LOGS,
    '--ref-name',
    commit,
  ]);
  expect(exitCode).toBe(0);
  expect(opened).toEqual([commit]);
});

test('--tools reaches the VM request and defaults to workflow', async () => {
  const withCheckout = {
    '.github/workflows/ci.yml': WORKFLOW.replace(
      '    steps:\n',
      '    steps:\n      - uses: actions/checkout@v7\n',
    ),
  };
  const withMise = await hugi([...ARGS, '--tools', 'mise'], result({}), withCheckout);
  expect(withMise.requests[0]!.toolSource).toBe('mise');
  const explicit = await hugi([...ARGS, '--tools', 'workflow'], result({}));
  expect(explicit.requests[0]!.toolSource).toBe('workflow');
  const byDefault = await hugi(ARGS, result({}));
  expect(byDefault.requests[0]!.toolSource).toBe('workflow');
});

test('--tools with another value is a usage error and never runs the VM', async () => {
  const { exitCode, stderr, requests } = await hugi([...ARGS, '--tools', 'brew'], undefined);
  expect(exitCode).toBe(2);
  expect(stderr).toContain('--tools must be one of workflow, mise');
  expect(requests).toHaveLength(0);
});
