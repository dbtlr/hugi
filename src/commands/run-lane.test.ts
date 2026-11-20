/* Workflow expression delimiters are literal input to the reader. */
/* eslint-disable no-template-curly-in-string */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processHandle } from '@loomcli/core';

import { messageOf } from '../errors';
import { PullRequestReadError } from '../github/pull-request';
import type { PullRequestFacts } from '../github/pull-request';
import type { GuestSource, HostSource } from '../source/host-source';
import {
  AmbiguousRefError,
  NoCurrentMergeError,
  NotAFileError,
  openHostSource,
  SourceError,
} from '../source/host-source';
import type { RunRequest, RunResult } from '../vm';
import { RunUsageError } from './run-args';
import { exitCodeForVerdict, runLane } from './run-lane';
import type { PushRunRequest, RunLaneDeps, RunLaneRequest } from './run-lane';

const SHA = 'a'.repeat(40);
const WORKFLOW = `
on: push
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.4.4 }
      - run: echo hello \${{ github.ref_name }}
`;

const passed: RunResult = {
  reason: 'passed',
  steps: [{ index: 3, name: 'run', outcome: 'success', seconds: 1 }],
  timings: { bootSeconds: 1, cloneSeconds: 1, totalSeconds: 3 },
  verdict: 'pass',
};

const REMOTE_GUEST: GuestSource = {
  location: { cloneUrl: 'https://github.com/example/project.git', kind: 'remote' },
  release: async () => {},
};

function source(files: Record<string, string>, refKind?: 'branch' | 'tag'): HostSource {
  return {
    changedFiles: async () => [],
    guestSource: async () => REMOTE_GUEST,
    readFile: async (path) => files[path],
    sha: SHA,
    ...(refKind === undefined ? {} : { refKind }),
  };
}

const request: PushRunRequest = {
  commit: 'main',
  event: 'push',
  image: 'hugi-golden',
  lane: { job: 'build', workflow: '.github/workflows/ci.yml' },
  matrix: {},
  needs: {},
  repository: {
    cloneUrl: 'https://github.com/example/project.git',
    kind: 'github',
    name: 'example/project',
  },
  toolSource: 'workflow',
};

/** `workflow` with an upstream `changes` job the lane can need, and the lane's job needing it. */
const needingChanges = (workflow: string, jobLines = '') =>
  workflow
    .replace(
      'jobs:\n',
      'jobs:\n  changes:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "true"\n',
    )
    .replace('    runs-on: macos', `    needs: changes\n${jobLines}    runs-on: macos`);

const HEAD_SHA = 'c'.repeat(40);

/** Pull request 7 as GitHub reports it, with its merge commit current. */
const PULL_REQUEST: PullRequestFacts = {
  baseRef: 'main',
  headRef: 'feature',
  headSha: HEAD_SHA,
  mergeCommitSha: SHA,
  mergeable: true,
  number: 7,
  state: 'open',
};

function harness(files: Record<string, string>, result: RunResult = passed) {
  const calls: RunRequest[] = [];
  const warnings: string[] = [];
  const deps: RunLaneDeps = {
    newLogDir: async (sha) => `/logs/${sha.slice(0, 7)}`,
    openPullRequestSource: async () => source(files),
    openSource: async (_spec, commit) => source(files, commit === 'main' ? 'branch' : undefined),
    readPullRequest: async () => PULL_REQUEST,
    runInVm: async (vmRequest) => {
      calls.push(vmRequest);
      return result;
    },
    warn: (message) => warnings.push(message),
  };
  return { calls, deps, warnings };
}

test('a readable lane runs in the VM with its tools and the resolved event', async () => {
  const { calls, deps } = harness({ '.github/workflows/ci.yml': WORKFLOW });
  const report = await runLane(request, deps);
  expect(report.verdict).toBe('pass');
  expect(report.logDir).toBe('/logs/aaaaaaa');
  expect(calls).toHaveLength(1);
  const vm = calls[0]!;
  expect(vm.tools).toEqual(['bun@1.4.4']);
  expect(vm.image).toBe('hugi-golden');
  expect(vm.source).toEqual({ cloneUrl: 'https://github.com/example/project.git', kind: 'remote' });
  expect(vm.event).toMatchObject({
    refName: 'main',
    refType: 'branch',
    repository: 'example/project',
    sha: SHA,
  });
  expect(
    vm.plan.steps.some((step) => step.kind === 'run' && step.script.includes('hello main')),
  ).toBe(true);
});

/** A local source whose guest source is a snapshot at `/snapshots/1`; records each release. */
function snapshotSource(events: string[], prepare?: () => Promise<void>): HostSource {
  return {
    ...source({ '.github/workflows/ci.yml': WORKFLOW }, 'branch'),
    guestSource: async () => {
      await prepare?.();
      events.push('prepared');
      return {
        location: { kind: 'local', path: '/snapshots/1' },
        release: async () => {
          events.push('released');
        },
      };
    },
  };
}

const localRequest: PushRunRequest = {
  ...request,
  repository: { kind: 'local', path: '/repos/project' },
};

test('a local repository reaches the VM as its snapshot, released after the run', async () => {
  const events: string[] = [];
  const { calls, deps } = harness({});
  await runLane(localRequest, {
    ...deps,
    openSource: async () => snapshotSource(events),
    runInVm: async (vmRequest) => {
      calls.push(vmRequest);
      events.push('ran');
      return passed;
    },
  });
  expect(calls[0]!.source).toEqual({ kind: 'local', path: '/snapshots/1' });
  expect(calls[0]!.event.repository).toBe('local/project');
  expect(events).toEqual(['prepared', 'ran', 'released']);
});

test('the snapshot is released when the VM runner throws', async () => {
  const events: string[] = [];
  const { deps } = harness({});
  const failure = await runLane(localRequest, {
    ...deps,
    openSource: async () => snapshotSource(events),
    runInVm: async () => {
      throw new Error('tart vanished');
    },
  }).catch((error: unknown) => error);
  expect(messageOf(failure)).toBe('tart vanished');
  expect(events).toEqual(['prepared', 'released']);
});

test('a run whose start cannot be recorded never boots its VM', async () => {
  const events: string[] = [];
  const { calls, deps } = harness({});
  const failure = await runLane(localRequest, {
    ...deps,
    openSource: async () => snapshotSource(events),
    runStarted: async () => {
      throw new Error('cannot write run.json');
    },
  }).catch((error: unknown) => error);
  expect(messageOf(failure)).toBe('cannot write run.json');
  expect(calls).toHaveLength(0);
  expect(events).toEqual(['prepared', 'released']);
});

test('the snapshot is released when the default log directory cannot be made', async () => {
  const events: string[] = [];
  const { calls, deps } = harness({});
  const failure = await runLane(localRequest, {
    ...deps,
    newLogDir: async () => {
      throw new Error('no room for logs');
    },
    openSource: async () => snapshotSource(events),
  }).catch((error: unknown) => error);
  expect(messageOf(failure)).toBe('no room for logs');
  expect(calls).toHaveLength(0);
  expect(events).toEqual(['prepared', 'released']);
});

test('a snapshot that cannot be built yields no verdict and boots no VM', async () => {
  const events: string[] = [];
  const { calls, deps } = harness({});
  const report = await runLane(localRequest, {
    ...deps,
    openSource: async () =>
      snapshotSource(events, async () => {
        throw new SourceError('git fetch failed: missing object');
      }),
  });
  expect(report).toMatchObject({ reason: 'infrastructure', sha: SHA, verdict: 'none' });
  expect(report.detail).toContain('missing object');
  expect(calls).toHaveLength(0);
});

test('a snapshot that cannot be removed is a warning, and the verdict stands', async () => {
  const { deps, warnings } = harness({});
  const report = await runLane(localRequest, {
    ...deps,
    openSource: async () => ({
      ...snapshotSource([]),
      guestSource: async () => ({
        location: { kind: 'local', path: '/snapshots/1' },
        release: async () => {
          throw new Error('busy');
        },
      }),
    }),
  });
  expect(report.verdict).toBe('pass');
  expect(warnings.join('\n')).toContain('/snapshots/1');
  expect(warnings.join('\n')).toContain('busy');
});

test('a missing workflow file is a fail verdict and boots no VM', async () => {
  const { calls, deps } = harness({});
  const report = await runLane(request, deps);
  expect(report).toMatchObject({ reason: 'lane-unreadable', verdict: 'fail' });
  expect(report.detail).toContain('.github/workflows/ci.yml');
  expect(calls).toHaveLength(0);
});

test('a lane the reader rejects is a fail verdict and boots no VM', async () => {
  const unsupported = WORKFLOW.replace('runs-on: macos-latest', 'runs-on: ubuntu-latest');
  const { calls, deps } = harness({ '.github/workflows/ci.yml': unsupported });
  const report = await runLane(request, deps);
  expect(report).toMatchObject({ reason: 'lane-unreadable', verdict: 'fail' });
  expect(report.detail).toMatch(/job "build".*ubuntu-latest/);
  expect(calls).toHaveLength(0);
});

/** The usage error `runLane` throws for `lane`, or undefined when it does not throw one. */
async function selectionFailure(workflow: string, overrides: Partial<PushRunRequest>) {
  const { calls, deps } = harness({ '.github/workflows/ci.yml': workflow });
  const failure = await runLane({ ...request, ...overrides }, deps).catch(
    (error: unknown) => error,
  );
  expect(calls).toHaveLength(0);
  expect(failure).toBeInstanceOf(RunUsageError);
  return messageOf(failure);
}

test.each([
  [
    'a missing job',
    WORKFLOW,
    { lane: { ...request.lane, job: 'missing' } },
    /no job named "missing"/,
  ],
  [
    'matrix values for a job with no matrix',
    WORKFLOW,
    { matrix: { os: 'macos-latest' } },
    /matrix/,
  ],
  [
    'an upstream value the caller did not supply',
    needingChanges(WORKFLOW, '    if: needs.changes.outputs.code\n'),
    {},
    /missing upstream value needs.changes.outputs.code/,
  ],
  [
    'a --needs entry for a job the lane does not need',
    WORKFLOW,
    { needs: { changes: { outputs: { code: 'true' } } } },
    /"changes" is not in the job's needs/,
  ],
] as const)('%s is a usage error and boots no VM', async (_name, workflow, overrides, message) => {
  expect(await selectionFailure(workflow, overrides)).toMatch(message);
});

test('a job whose if: is false is a usage error saying it is skipped and has no verdict', async () => {
  const skipped = WORKFLOW.replace(
    'runs-on:',
    "if: github.event_name == 'pull_request'\n    runs-on:",
  );
  const message = await selectionFailure(skipped, {});
  expect(message).toContain('skipped for this event');
  expect(message).toContain('no verdict');
});

test('a setup action the resolver rejects is a fail verdict and boots no VM', async () => {
  const workflow = WORKFLOW.replace('oven-sh/setup-bun@v2', 'someone/unknown-action@v1');
  const { calls, deps } = harness({ '.github/workflows/ci.yml': workflow });
  const report = await runLane(request, deps);
  expect(report).toMatchObject({ reason: 'toolchain-unresolvable', verdict: 'fail' });
  expect(calls).toHaveLength(0);
});

test('a source that cannot be opened yields no verdict and boots no VM', async () => {
  const { calls, deps } = harness({});
  const report = await runLane(request, {
    ...deps,
    openSource: async () => {
      throw new SourceError('The commit "main" does not exist in the repository.');
    },
  });
  expect(report).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(report.detail).toContain('does not exist');
  expect(calls).toHaveLength(0);
});

test('--ref-name defaults to the commit argument when that names a branch or a tag', async () => {
  const { calls, deps } = harness({ '.github/workflows/ci.yml': WORKFLOW });
  await runLane({ ...request, commit: 'main' }, deps);
  expect(calls[0]!.event).toMatchObject({ refName: 'main', refType: 'branch' });
});

test('a tag commit argument infers the tag ref type unless one is given', async () => {
  const { calls, deps } = harness({ '.github/workflows/ci.yml': WORKFLOW });
  const withTag: RunLaneDeps = {
    ...deps,
    openSource: async () => source({ '.github/workflows/ci.yml': WORKFLOW }, 'tag'),
  };
  await runLane({ ...request, commit: 'v1.0.0' }, withTag);
  expect(calls[0]!.event).toMatchObject({ refName: 'v1.0.0', refType: 'tag' });
});

test('a sha commit argument without --ref-name is a usage error and boots no VM', async () => {
  const { calls, deps } = harness({ '.github/workflows/ci.yml': WORKFLOW });
  const failure = await runLane({ ...request, commit: SHA }, deps).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RunUsageError);
  expect(calls).toHaveLength(0);
});

test('explicit ref options and needs reach the event', async () => {
  const { calls, deps } = harness({
    '.github/workflows/ci.yml': needingChanges(WORKFLOW),
  });
  await runLane(
    {
      ...request,
      commit: SHA,
      needs: { changes: { outputs: { code: 'true' } } },
      refName: 'v0.29.0',
      refType: 'tag',
    },
    deps,
  );
  expect(calls[0]!.event).toMatchObject({
    needs: { changes: { outputs: { code: 'true' } } },
    refName: 'v0.29.0',
    refType: 'tag',
  });
});

test('an explicit log directory wins over the default', async () => {
  const { deps } = harness({ '.github/workflows/ci.yml': WORKFLOW });
  const report = await runLane({ ...request, logDir: '/mine' }, deps);
  expect(report.logDir).toBe('/mine');
});

test.each([
  ['pass', 0],
  ['fail', 1],
  ['none', 3],
] as const)('verdict %s exits %i', (verdict, code) => {
  expect(exitCodeForVerdict(verdict)).toBe(code);
});

test('the report carries the VM result for a failing and an infrastructure run', async () => {
  const failed: RunResult = { ...passed, reason: 'step-failed', verdict: 'fail' };
  const { deps } = harness({ '.github/workflows/ci.yml': WORKFLOW }, failed);
  expect(await runLane(request, deps)).toMatchObject({ reason: 'step-failed', verdict: 'fail' });
  const lost: RunResult = {
    ...passed,
    detail: 'tart clone failed',
    reason: 'infrastructure',
    steps: [],
    verdict: 'none',
  };
  const second = harness({ '.github/workflows/ci.yml': WORKFLOW }, lost);
  expect(await runLane(request, second.deps)).toMatchObject({
    detail: 'tart clone failed',
    verdict: 'none',
  });
});

test('the report names a VM the run leaked, and omits the field otherwise', async () => {
  const leaked: RunResult = { ...passed, leakedVm: 'hugi-run-abc' };
  const { deps } = harness({ '.github/workflows/ci.yml': WORKFLOW }, leaked);
  expect(await runLane(request, deps)).toMatchObject({ leakedVm: 'hugi-run-abc' });
  const clean = harness({ '.github/workflows/ci.yml': WORKFLOW }, passed);
  expect(await runLane(request, clean.deps)).not.toHaveProperty('leakedVm');
});

/** A source whose reads of `failing` throw `error`; other paths read from `files`. */
function failingSource(files: Record<string, string>, failing: string, error: Error): HostSource {
  return {
    changedFiles: async () => [],
    guestSource: async () => REMOTE_GUEST,
    readFile: async (path) => {
      if (path === failing) {
        throw error;
      }
      return files[path];
    },
    refKind: 'branch',
    sha: SHA,
  };
}

test('a workflow read that fails after the source opened yields no verdict and boots no VM', async () => {
  const { calls, deps } = harness({});
  const lost = new SourceError('Cannot read .github/workflows/ci.yml: lazy fetch failed');
  const report = await runLane(request, {
    ...deps,
    openSource: async () => failingSource({}, '.github/workflows/ci.yml', lost),
  });
  expect(report).toMatchObject({ reason: 'infrastructure', sha: SHA, verdict: 'none' });
  expect(report.detail).toContain('lazy fetch failed');
  expect(calls).toHaveLength(0);
});

test('a toolchain file read that fails yields no verdict, not a toolchain failure', async () => {
  const workflow = WORKFLOW.replace(
    '{ bun-version: 1.4.4 }',
    '{ bun-version-file: .tool-versions }',
  );
  const files = { '.github/workflows/ci.yml': workflow };
  const { calls, deps } = harness(files);
  const lost = new SourceError('Cannot read .tool-versions: lazy fetch failed');
  const report = await runLane(request, {
    ...deps,
    openSource: async () => failingSource(files, '.tool-versions', lost),
  });
  expect(report).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
  expect(report.detail).toContain('lazy fetch failed');
  expect(calls).toHaveLength(0);
});

test('a workflow path that names a directory is an unreadable lane', async () => {
  const { calls, deps } = harness({});
  const tree = new NotAFileError('.github/workflows/ci.yml is not a file at the commit.');
  const report = await runLane(request, {
    ...deps,
    openSource: async () => failingSource({}, '.github/workflows/ci.yml', tree),
  });
  expect(report).toMatchObject({ reason: 'lane-unreadable', verdict: 'fail' });
  expect(calls).toHaveLength(0);
});

test('a commit that names both a branch and a tag is a usage error and boots no VM', async () => {
  const { calls, deps } = harness({});
  const failure = await runLane(request, {
    ...deps,
    openSource: async () => {
      throw new AmbiguousRefError('main');
    },
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RunUsageError);
  expect(failure instanceof Error && failure.message).toContain('--ref-type');
  expect(calls).toHaveLength(0);
});

test('a tag commit argument infers the tag ref type even when --ref-name is given', async () => {
  const { calls, deps } = harness({ '.github/workflows/ci.yml': WORKFLOW });
  const withTag: RunLaneDeps = {
    ...deps,
    openSource: async () => source({ '.github/workflows/ci.yml': WORKFLOW }, 'tag'),
  };
  await runLane({ ...request, commit: 'v1.0.0', refName: 'release-1' }, withTag);
  expect(calls[0]!.event).toMatchObject({ refName: 'release-1', refType: 'tag' });
});

describe('with a real local repository', () => {
  let scratch: string;
  let repository: string;
  const handle = processHandle();

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'hugi-run-lane-'));
    repository = join(scratch, 'project');
    await mkdir(join(repository, '.github', 'workflows'), { recursive: true });
    await writeFile(join(repository, '.github', 'workflows', 'ci.yml'), WORKFLOW);
    const git = async (...args: string[]) => {
      const exit = await handle.spawn('git', ['-C', repository, ...args], {
        cwd: scratch,
        // An inherited GIT_DIR (a git hook sets one) would point these commands at another repository.
        env: {
          ...Object.fromEntries(
            Object.entries(handle.env).filter(([name]) => !name.startsWith('GIT_')),
          ),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }).exited;
      expect(exit.kind === 'exited' && exit.code).toBe(0);
    };
    await git('init', '--quiet', '--initial-branch=main');
    await git('add', '-A');
    await git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x');
  });
  afterAll(() => rm(scratch, { force: true, recursive: true }));

  /** Run the lane with the real host source, building snapshots under `scratch/tmp`. */
  async function runReal(runInVm: RunLaneDeps['runInVm']) {
    const tempDir = join(scratch, 'tmp');
    await mkdir(tempDir, { recursive: true });
    const { deps } = harness({});
    const outcome = await runLane(
      { ...request, repository: { kind: 'local', path: repository } },
      {
        ...deps,
        openSource: (spec, commit) =>
          openHostSource(spec, commit, {
            cacheDir: join(scratch, 'cache'),
            cwd: scratch,
            env: handle.env,
            spawn: (command, args, options) =>
              handle.spawn(command, args, { cwd: scratch, env: handle.env, ...options }),
            tempDir,
            uid: handle.uid,
          }),
        runInVm,
      },
    ).catch((error: unknown) => error);
    return { outcome, tempDir };
  }

  test.each([
    ['returns', async () => passed],
    [
      'throws',
      async () => {
        throw new Error('tart vanished');
      },
    ],
  ] as const)('the snapshot is gone once the VM runner %s', async (_how, finish) => {
    const shared: string[] = [];
    const { tempDir } = await runReal(async (vmRequest) => {
      if (vmRequest.source.kind === 'local') {
        shared.push(vmRequest.source.path);
        expect(await readdir(vmRequest.source.path)).toContain('HEAD');
      }
      return finish();
    });
    expect(shared).toHaveLength(1);
    expect(shared[0]!.startsWith(tempDir)).toBe(true);
    expect(await readdir(tempDir)).toEqual([]);
  });
});

describe('the report carries the toolchain resolution', () => {
  const workflow = WORKFLOW.replace(
    '      - run: echo hello',
    '      - uses: actions/upload-artifact@v4\n        with: { name: out, path: out, if-no-files-found: error }\n      - run: echo hello',
  );
  const files = {
    '.github/workflows/ci.yml': workflow,
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.90.0"\n',
  };
  /** The VM skips every action step and runs the one `run:` step. */
  const ran: RunResult = {
    ...passed,
    steps: [
      { index: 0, name: 'Install tools', outcome: 'success', seconds: 2 },
      {
        index: 1,
        name: 'actions/checkout@v7',
        note: `checked out ${SHA}`,
        outcome: 'success',
        seconds: 1,
      },
      { index: 2, name: 'oven-sh/setup-bun@v2', outcome: 'skipped', seconds: 0 },
      { index: 3, name: 'actions/upload-artifact@v4', outcome: 'skipped', seconds: 0 },
      { index: 4, name: 'run', outcome: 'success', seconds: 1 },
    ],
  };

  test('action steps read as resolved to their tools or a no-op, never skipped', async () => {
    const { deps } = harness(files, ran);
    const report = await runLane(request, deps);
    expect(report.steps.map((step) => step.outcome)).toEqual([
      'success',
      'success',
      'resolved',
      'resolved',
      'success',
    ]);
    // The checkout step is one the runner performs, so it keeps its own result.
    expect(report.steps[1]).toMatchObject({ index: 1, note: `checked out ${SHA}` });
    expect(report.steps[2]).toMatchObject({ action: { kind: 'tools', tools: ['bun@1.4.4'] } });
    expect(report.steps[3]).toMatchObject({
      action: { kind: 'noop', reason: expect.stringContaining('existence check is skipped') },
    });
  });

  test('the resolution, with its tools and notes, is in the report', async () => {
    const { deps } = harness(files, ran);
    const report = await runLane(request, deps);
    expect(report.toolchain?.tools).toEqual(['bun@1.4.4', 'rust@1.90.0']);
    expect(report.toolchain?.notes).toEqual([
      'rust-toolchain.toml: rustup in the guest handles components and profile.',
    ]);
    expect(report.toolchain?.actions).toHaveLength(3);
  });
});

describe('a pull request runs at its merge commit', () => {
  const pullRequest: RunLaneRequest = {
    event: 'pull_request',
    image: 'hugi-golden',
    lane: request.lane,
    matrix: {},
    needs: {},
    pullRequest: 7,
    repository: {
      cloneUrl: 'https://github.com/example/project.git',
      kind: 'github',
      name: 'example/project',
    },
    toolSource: 'workflow',
  };
  const workflow = WORKFLOW.replace('on: push', 'on: pull_request');

  test('the pull request is read, its merge opened, and the event carries both', async () => {
    const { calls, deps } = harness({ '.github/workflows/ci.yml': workflow });
    const read: [string, number][] = [];
    const opened: PullRequestFacts[] = [];
    const report = await runLane(pullRequest, {
      ...deps,
      openPullRequestSource: async (spec, facts) => {
        expect(spec.name).toBe('example/project');
        opened.push(facts);
        return source({ '.github/workflows/ci.yml': workflow });
      },
      readPullRequest: async (repository, number) => {
        read.push([repository, number]);
        return PULL_REQUEST;
      },
    });
    expect(read).toEqual([['example/project', 7]]);
    expect(opened).toEqual([PULL_REQUEST]);
    expect(calls[0]!.event).toEqual({
      event: 'pull_request',
      needs: {},
      pullRequest: { baseRef: 'main', headRef: 'feature', headSha: HEAD_SHA, number: 7 },
      repository: 'example/project',
      sha: SHA,
    });
    expect(
      calls[0]!.plan.steps.some((step) => step.kind === 'run' && step.script.includes('7/merge')),
    ).toBe(true);
    expect(report).toMatchObject({
      pullRequest: { headSha: HEAD_SHA, number: 7 },
      sha: SHA,
      verdict: 'pass',
    });
  });

  test('a pull request GitHub cannot read yields no verdict and boots no VM', async () => {
    const { calls, deps } = harness({});
    const report = await runLane(pullRequest, {
      ...deps,
      readPullRequest: async () => {
        throw new PullRequestReadError("GitHub's anonymous rate limit is used up.");
      },
    });
    expect(report).toMatchObject({ reason: 'infrastructure', verdict: 'none' });
    expect(report.detail).toContain('rate limit');
    expect(calls).toHaveLength(0);
  });

  test('a pull request with no current merge yields no verdict and boots no VM', async () => {
    const { calls, deps } = harness({});
    const report = await runLane(pullRequest, {
      ...deps,
      openPullRequestSource: async () => {
        throw new NoCurrentMergeError('conflict', 'Pull request 7 has a merge conflict.');
      },
    });
    expect(report).toMatchObject({
      pullRequest: { headSha: HEAD_SHA, number: 7 },
      reason: 'infrastructure',
      verdict: 'none',
    });
    expect(report.detail).toContain('merge conflict');
    expect(calls).toHaveLength(0);
  });
});

describe('a lane that takes its tools from the mise config (ADR-0006)', () => {
  const miseRequest: PushRunRequest = { ...request, toolSource: 'mise' };

  test('the choice reaches the VM request, and the default is workflow', async () => {
    const { calls, deps } = harness({ '.github/workflows/ci.yml': WORKFLOW });
    await runLane(miseRequest, deps);
    await runLane(request, deps);
    expect(calls.map((call) => call.toolSource)).toEqual(['mise', 'workflow']);
  });

  test('a lane with no actions/checkout step fails before the VM boots', async () => {
    const workflow = WORKFLOW.replace('      - uses: actions/checkout@v7\n', '');
    const { calls, deps } = harness({ '.github/workflows/ci.yml': workflow });
    const report = await runLane(miseRequest, deps);
    expect(report).toMatchObject({ reason: 'toolchain-unresolvable', verdict: 'fail' });
    expect(report.detail).toContain('actions/checkout');
    expect(calls).toHaveLength(0);
  });

  test('the same lane under the default has no such fault', async () => {
    const workflow = WORKFLOW.replace('      - uses: actions/checkout@v7\n', '');
    const { calls, deps } = harness({ '.github/workflows/ci.yml': workflow });
    await runLane(request, deps);
    expect(calls).toHaveLength(1);
  });
});
