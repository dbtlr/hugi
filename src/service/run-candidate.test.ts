import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stringify } from 'yaml';

import { GitHubReadError } from '../github/client';
import type { PullRequestFacts } from '../github/pull-request';
import type { Candidate } from '../queue/types';
import { readRunRecord } from '../runs/record';
import { NoCurrentMergeError, SourceError } from '../source/host-source';
import type { OpenedSource } from '../source/host-source';
import type { RunRequest, RunResult } from '../vm';
import { createRunCandidate } from './run-candidate';
import type { CandidateRunStart, RunCandidateDeps } from './run-candidate';

const HEAD = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const PUSH_SHA = 'a'.repeat(40);
const REPOSITORY = 'example/project';
const CI = '.github/workflows/ci.yml';

const WORKFLOW = stringify({
  jobs: {
    build: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] },
    release: {
      if: "github.event_name == 'push'",
      'runs-on': 'macos-latest',
      steps: [{ run: 'true' }],
    },
  },
  on: { pull_request: null, push: { branches: ['main'] } },
});

/** A workflow whose build job checks the repository out, as a `tools: mise` lane needs. */
const CHECKED_OUT = stringify({
  jobs: {
    build: { 'runs-on': 'macos-latest', steps: [{ uses: 'actions/checkout@v7' }, { run: 'true' }] },
  },
  on: { pull_request: null, push: null },
});

const declaration = (jobs: string[]) => stringify({ lanes: [{ jobs, workflow: 'ci.yml' }] });

const FILES = { '.github/hugi.yaml': declaration(['build', 'release']), [CI]: WORKFLOW };

const passed: RunResult = {
  reason: 'passed',
  steps: [{ index: 1, name: 'Run echo', outcome: 'success', seconds: 1 }],
  timings: { bootSeconds: 1, cloneSeconds: 1, totalSeconds: 3 },
  verdict: 'pass',
};

const FACTS: PullRequestFacts = {
  baseRef: 'main',
  headRef: 'feature',
  headSha: HEAD,
  mergeCommitSha: MERGE,
  mergeable: true,
  number: 7,
  state: 'open',
};

function source(sha: string, files: Record<string, string>): OpenedSource {
  return {
    changedFiles: async () => [],
    commitMessage: async () => 'a change',
    guestSource: async () => ({
      location: { cloneUrl: `https://github.com/${REPOSITORY}.git`, kind: 'remote' },
      release: async () => {},
    }),
    readFile: async (path) => files[path],
    sha,
  };
}

const lane = (job: string) => ({ job, matrix: {}, tools: 'workflow' as const, workflow: CI });

const pushCandidate = (job = 'build'): Candidate => ({
  commit: PUSH_SHA,
  event: { branch: 'main', kind: 'push' },
  lane: lane(job),
  repository: REPOSITORY,
  statusName: `hugi / ${job}`,
});

const pullCandidate = (job = 'build'): Candidate => ({
  commit: HEAD,
  event: {
    kind: 'pull_request',
    pullRequest: { baseRef: 'main', headRef: 'feature', headSha: HEAD, number: 7 },
  },
  lane: lane(job),
  repository: REPOSITORY,
  statusName: `hugi / ${job}`,
});

let runsDir: string;
beforeAll(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'hugi-run-candidate-'));
});
afterAll(async () => {
  await rm(runsDir, { force: true, recursive: true });
});

type Overrides = Partial<RunCandidateDeps> & {
  readonly files?: Record<string, string>;
  readonly result?: RunResult;
};

function harness(overrides: Overrides = {}) {
  const files = overrides.files ?? FILES;
  const events: string[] = [];
  const vmCalls: { request: RunRequest; vmId: string }[] = [];
  const starts: CandidateRunStart[] = [];
  const opened: string[] = [];
  const deps: RunCandidateDeps = {
    configPath: join(runsDir, 'no-config.yaml'),
    fault: () => {},
    newVmId: () => 'vm123456',
    now: () => new Date('2026-11-20T10:00:00.000Z'),
    openPullRequestSource: async (spec, facts) => {
      opened.push(`${spec.name}#${facts.number}`);
      return source(MERGE, files);
    },
    openSource: async () => source(PUSH_SHA, files),
    readPullRequest: async () => FACTS,
    runInVm: async (request, vmId) => {
      events.push('vm');
      vmCalls.push({ request, vmId });
      return overrides.result ?? passed;
    },
    runsDir,
    warn: () => {},
    ...overrides,
  };
  const hooks = {
    started: async (start: CandidateRunStart) => {
      events.push('started');
      starts.push(start);
    },
  };
  return { deps, events, hooks, opened, starts, vmCalls };
}

test('a push candidate runs its lane at its commit on its branch, and its verdict carries the run id', async () => {
  const { deps, events, hooks, starts, vmCalls } = harness();
  const outcome = await createRunCandidate(deps)(pushCandidate(), hooks);
  expect(events).toEqual(['started', 'vm']);
  const { request, vmId } = vmCalls[0]!;
  expect(vmId).toBe('vm123456');
  expect(request.image).toBe('hugi-golden');
  expect(request.toolSource).toBe('workflow');
  expect(request.event).toMatchObject({ event: 'push', refName: 'main', refType: 'branch' });
  expect(request.event.needs).toEqual({});
  const runId = starts[0]!.runId;
  expect(starts[0]).toMatchObject({ target: { repository: REPOSITORY, sha: PUSH_SHA }, vmId });
  expect(outcome).toEqual({
    kind: 'finished',
    lane: { job: 'build', matrix: {}, workflow: CI },
    status: { runId, state: 'success' },
    target: { repository: REPOSITORY, sha: PUSH_SHA },
  });
  const record = await readRunRecord(join(runsDir, runId));
  expect(record).toMatchObject({ state: 'finished', verdict: 'pass' });
});

test("a lane's tools come from its declaration entry", async () => {
  const { deps, hooks, vmCalls } = harness({ files: { ...FILES, [CI]: CHECKED_OUT } });
  const candidate = { ...pushCandidate(), lane: { ...lane('build'), tools: 'mise' as const } };
  await createRunCandidate(deps)(candidate, hooks);
  expect(vmCalls[0]!.request.toolSource).toBe('mise');
});

test('a run with no verdict finishes with no status and says why', async () => {
  const lost: RunResult = {
    ...passed,
    detail: 'the VM went away',
    reason: 'infrastructure',
    verdict: 'none',
  };
  const { deps, hooks } = harness({ result: lost });
  const outcome = await createRunCandidate(deps)(pushCandidate(), hooks);
  expect(outcome).toMatchObject({ cause: 'the VM went away', kind: 'finished', status: undefined });
});

test('a VM run that throws is logged as a fault in Hugi, and its record is finished with no verdict', async () => {
  const faults: string[] = [];
  const { deps, hooks, starts } = harness({
    fault: (message) => faults.push(message),
    runInVm: async () => {
      throw new Error('tart vanished');
    },
  });
  const outcome = await createRunCandidate(deps)(pushCandidate(), hooks);
  expect(outcome).toMatchObject({ kind: 'finished', status: undefined });
  expect(faults).toEqual([expect.stringContaining('tart vanished')]);
  expect(faults[0]).toContain(`hugi / build at ${PUSH_SHA}`);
  const record = await readRunRecord(join(runsDir, starts[0]!.runId));
  expect(record).toMatchObject({ state: 'finished', verdict: 'none' });
});

test('a lane that cannot be read fails with its cause and no run id, and boots no VM', async () => {
  const { deps, hooks, starts, vmCalls } = harness({
    files: { '.github/hugi.yaml': declaration(['build']) },
  });
  const outcome = await createRunCandidate(deps)(pushCandidate(), hooks);
  expect(vmCalls).toHaveLength(0);
  expect(starts).toHaveLength(0);
  expect(outcome).toEqual({
    kind: 'finished',
    lane: { job: 'build', matrix: {}, workflow: CI },
    status: { cause: `${CI} does not exist at ${PUSH_SHA}.`, state: 'failure' },
    target: { repository: REPOSITORY, sha: PUSH_SHA },
  });
});

test("a pull request lane whose job's if: is false at the merge is dropped with no status, to wait", async () => {
  const { deps, hooks, vmCalls } = harness();
  // The next poll may select the lane again, so it waits as after a run with no verdict.
  expect(await createRunCandidate(deps)(pullCandidate('release'), hooks)).toMatchObject({
    kind: 'dropped',
    waits: true,
  });
  expect(vmCalls).toHaveLength(0);
});

test("a push lane whose job's if: is false at run start is dropped to wait, as hugi run's usage error", async () => {
  const files = {
    ...FILES,
    [CI]: WORKFLOW.replace("github.event_name == 'push'", "github.event_name == 'never'"),
  };
  const { deps, hooks, vmCalls } = harness({ files });
  // The poll selected the lane and would select it again, so it waits as after no verdict.
  expect(await createRunCandidate(deps)(pushCandidate('release'), hooks)).toMatchObject({
    kind: 'dropped',
    waits: true,
  });
  expect(vmCalls).toHaveLength(0);
});

test('a pull request runs on the merge it opened once, and its statuses record that merge', async () => {
  const { deps, hooks, opened, starts, vmCalls } = harness();
  const outcome = await createRunCandidate(deps)(pullCandidate(), hooks);
  expect(opened).toEqual([`${REPOSITORY}#7`]);
  expect(vmCalls[0]!.request.event).toMatchObject({
    event: 'pull_request',
    pullRequest: { headSha: HEAD, number: 7 },
    sha: MERGE,
  });
  const target = { mergeSha: MERGE, repository: REPOSITORY, sha: HEAD };
  expect(starts[0]!.target).toEqual(target);
  expect(outcome).toMatchObject({ kind: 'finished', status: { state: 'success' }, target });
});

test('a pull request whose head moved since the poll is dropped without opening its merge', async () => {
  const { deps, hooks, opened } = harness({
    readPullRequest: async () => ({ ...FACTS, headSha: 'e'.repeat(40) }),
  });
  const outcome = await createRunCandidate(deps)(pullCandidate(), hooks);
  expect(outcome).toMatchObject({ kind: 'dropped' });
  expect(outcome).not.toHaveProperty('waits');
  expect(opened).toHaveLength(0);
});

test('a failed read of the pull request at run start finishes with no verdict', async () => {
  const { deps, hooks } = harness({
    readPullRequest: async () => {
      throw new GitHubReadError(REPOSITORY, 'GET /repos/example/project/pulls/7', 'rate limited');
    },
  });
  expect(await createRunCandidate(deps)(pullCandidate(), hooks)).toEqual({
    cause: 'rate limited',
    kind: 'finished',
    lane: { job: 'build', matrix: {}, workflow: CI },
    status: undefined,
    target: { repository: REPOSITORY, sha: HEAD },
  });
});

test('a pull request with no current merge is dropped, with no wait', async () => {
  const { deps, hooks } = harness({
    openPullRequestSource: async () => {
      throw new NoCurrentMergeError('conflict', 'pull request 7 has a merge conflict');
    },
  });
  expect(await createRunCandidate(deps)(pullCandidate(), hooks)).toEqual({
    kind: 'dropped',
    reason: 'pull request 7 has a merge conflict',
  });
});

test('a merge that cannot be fetched finishes with no verdict', async () => {
  const { deps, hooks } = harness({
    openPullRequestSource: async () => {
      throw new SourceError('git fetch timed out');
    },
  });
  expect(await createRunCandidate(deps)(pullCandidate(), hooks)).toMatchObject({
    cause: 'git fetch timed out',
    kind: 'finished',
    status: undefined,
  });
});

test('a declaration the merge refuses posts the declaration status on the head', async () => {
  const { deps, hooks, vmCalls } = harness({
    files: { ...FILES, '.github/hugi.yaml': declaration(['missing']) },
  });
  const outcome = await createRunCandidate(deps)(pullCandidate(), hooks);
  expect(outcome).toMatchObject({
    kind: 'declaration-refused',
    target: { mergeSha: MERGE, repository: REPOSITORY, sha: HEAD },
  });
  expect(outcome.kind === 'declaration-refused' && outcome.cause).toContain('missing');
  expect(vmCalls).toHaveLength(0);
});

test('a lane the merge no longer declares is dropped to wait', async () => {
  const { deps, hooks } = harness({
    files: { ...FILES, '.github/hugi.yaml': declaration(['release']) },
  });
  expect(await createRunCandidate(deps)(pullCandidate(), hooks)).toMatchObject({
    kind: 'dropped',
    waits: true,
  });
});

test('a merge with no declaration drops the lane to wait', async () => {
  const { deps, hooks } = harness({ files: { [CI]: WORKFLOW } });
  expect(await createRunCandidate(deps)(pullCandidate(), hooks)).toMatchObject({
    kind: 'dropped',
    waits: true,
  });
});

test('the lane runs as the merge declares it, matched by status name', async () => {
  const promoted = '.github/workflows/hugi.yml';
  const files = {
    '.github/hugi.yaml': stringify({
      lanes: [{ jobs: ['build'], tools: 'mise', workflow: 'hugi.yml' }],
    }),
    [promoted]: CHECKED_OUT,
  };
  const { deps, hooks, starts, vmCalls } = harness({ files });
  const outcome = await createRunCandidate(deps)(pullCandidate(), hooks);
  expect(vmCalls[0]!.request.toolSource).toBe('mise');
  expect(vmCalls[0]!.request.plan.lane.workflow).toBe(promoted);
  expect(starts[0]!.lane.workflow).toBe(promoted);
  expect(outcome).toMatchObject({ kind: 'finished', lane: { job: 'build', workflow: promoted } });
});

test('each run gets its own run directory under the runs directory', async () => {
  const before = await readdir(runsDir);
  const { deps, hooks } = harness();
  await createRunCandidate(deps)(pushCandidate(), hooks);
  expect((await readdir(runsDir)).length).toBe(before.length + 1);
});

test("a pull request lane the merge's trigger leaves out is dropped to wait, and boots no VM", async () => {
  const toRelease = stringify({
    jobs: { build: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] } },
    on: { pull_request: { branches: ['release'] }, push: null },
  });
  const { deps, hooks, starts, vmCalls } = harness({
    files: { ...FILES, '.github/hugi.yaml': declaration(['build']), [CI]: toRelease },
  });
  const outcome = await createRunCandidate(deps)(pullCandidate(), hooks);
  expect(outcome).toMatchObject({ kind: 'dropped', waits: true });
  expect(outcome.kind === 'dropped' && outcome.reason).toContain('leaves hugi / build out');
  expect(vmCalls).toHaveLength(0);
  expect(starts).toHaveLength(0);
});

test('the VM the run boots is the one its started hook names', async () => {
  let made = 0;
  const { deps, hooks, starts, vmCalls } = harness({ newVmId: () => `vm${(made += 1)}` });
  await createRunCandidate(deps)(pushCandidate(), hooks);
  expect(vmCalls).toHaveLength(1);
  expect(starts[0]!.vmId).toBe(vmCalls[0]!.vmId);
});

test('a pull request run uses the facts read at run start, without reading them again', async () => {
  let reads = 0;
  const { deps, hooks, vmCalls } = harness({
    readPullRequest: async () => {
      reads += 1;
      return reads === 1 ? FACTS : { ...FACTS, headSha: 'e'.repeat(40) };
    },
  });
  await createRunCandidate(deps)(pullCandidate(), hooks);
  expect(reads).toBe(1);
  expect(vmCalls[0]!.request.event).toMatchObject({ pullRequest: { headSha: HEAD } });
});

test("the merge's declaration is read with the facts read at run start, not the poll's", async () => {
  const toMain = stringify({
    jobs: { build: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] } },
    on: { pull_request: { branches: ['main'] }, push: null },
  });
  const { deps, hooks, vmCalls } = harness({
    files: { ...FILES, '.github/hugi.yaml': declaration(['build']), [CI]: toMain },
  });
  // The poll saw the pull request aimed at develop; at run start it is aimed at main.
  const polled = pullCandidate();
  const candidate: Candidate = {
    ...polled,
    event: {
      kind: 'pull_request',
      pullRequest: { baseRef: 'develop', headRef: 'feature', headSha: HEAD, number: 7 },
    },
  };
  const outcome = await createRunCandidate(deps)(candidate, hooks);
  expect(outcome).toMatchObject({ kind: 'finished', status: { state: 'success' } });
  expect(vmCalls).toHaveLength(1);
});

test("the run itself gets the pull request facts read at run start, not the poll's", async () => {
  const { deps, hooks, vmCalls } = harness();
  // The poll saw the pull request aimed at develop; at run start GitHub reports main.
  const polled = pullCandidate();
  const candidate: Candidate = {
    ...polled,
    event: {
      kind: 'pull_request',
      pullRequest: { baseRef: 'develop', headRef: 'feature', headSha: HEAD, number: 7 },
    },
  };
  await createRunCandidate(deps)(candidate, hooks);
  const [call] = vmCalls;
  expect(call?.request.event).toMatchObject({ pullRequest: { baseRef: 'main' } });
});
