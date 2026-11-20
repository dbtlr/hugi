import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockProcess } from '@loomcli/testing';

import { createApp } from '../app';
import { describeStatus } from '../github/statuses';
import { laneStatusOf } from '../runs/describe';
import { readRunRecord, writeRunRecord } from '../runs/record';
import { sampleRecord } from '../runs/testing';
import type { HostSource } from '../source/host-source';
import type { RunRequest, RunResult } from '../vm';
import type { RunLaneRequest } from './run-lane';
import { storeRun } from './run-record';

const SHA = 'b'.repeat(40);
const WORKFLOW = `
on: push
jobs:
  build:
    runs-on: macos-latest
    steps:
      - run: echo hi
      - run: exit 3
`;

const source: HostSource = {
  changedFiles: async () => [],
  guestSource: async () => ({
    location: { cloneUrl: 'https://github.com/example/project.git', kind: 'remote' },
    release: async () => {},
  }),
  readFile: async (path) => (path === '.github/workflows/ci.yml' ? WORKFLOW : undefined),
  refKind: 'branch',
  sha: SHA,
};

let state: string;
beforeEach(async () => {
  seenAtBoot.length = 0;
  state = await mkdtemp(join(tmpdir(), 'hugi-run-record-'));
});
afterEach(async () => {
  await rm(state, { force: true, recursive: true });
});

/** A VM that fails its second step, leaving the step logs in the run's log directory. */
/** What the VM saw in the run directory when it was asked to run: the record, if any. */
const seenAtBoot: string[] = [];

async function failingVm(request: RunRequest): Promise<RunResult> {
  seenAtBoot.push(
    await readFile(join(request.logDir, 'run.json'), 'utf8').catch(() => 'no record'),
  );
  await writeFile(join(request.logDir, '01-run.log'), 'hi\n');
  await writeFile(join(request.logDir, '02-run.log'), 'boom\n');
  return {
    detail: 'step 2 exited with code 3',
    reason: 'step-failed',
    steps: [
      {
        index: 1,
        logFile: join(request.logDir, '01-run.log'),
        name: 'run',
        outcome: 'success',
        seconds: 1,
      },
      {
        exitCode: 3,
        index: 2,
        logFile: join(request.logDir, '02-run.log'),
        name: 'run 2',
        outcome: 'failure',
        seconds: 1,
      },
    ],
    timings: { bootSeconds: 1, cloneSeconds: 1, totalSeconds: 3 },
    verdict: 'fail',
  };
}

async function hugiRun(env: Record<string, string> = {}) {
  const mock = mockProcess({
    argv: ['run', 'example/project', 'main', 'ci.yml:build'],
    env: {
      HOME: '/home/mock',
      XDG_CONFIG_HOME: join(state, 'config'),
      XDG_STATE_HOME: state,
      ...env,
    },
    stdin: '',
  });
  const exitCode = await createApp({
    openSource: async () => source,
    runInVm: failingVm,
  }).run({ process: mock });
  return { exitCode, stderr: mock.stderr.text };
}

const runsDir = () => join(state, 'hugi', 'runs');

test('a run writes its record into its run directory', async () => {
  const { exitCode } = await hugiRun();
  expect(exitCode).toBe(1);
  const [id] = await readdir(runsDir());
  const record = await readRunRecord(join(runsDir(), id ?? ''));
  expect(record).toMatchObject({
    commit: { head: SHA },
    event: 'push',
    lane: {
      job: 'build',
      matrix: {},
      statusName: 'hugi / build',
      workflow: '.github/workflows/ci.yml',
    },
    reason: 'step-failed',
    repository: 'example/project',
    runId: id,
    verdict: 'fail',
  });
  if (record.state !== 'finished') {
    throw new Error('the record is not finished');
  }
  expect(record.steps.map((step) => [step.index, step.outcome, step.log])).toEqual([
    [1, 'success', '01-run.log'],
    [2, 'failure', '02-run.log'],
  ]);
  expect(Date.parse(record.endedAt)).toBeGreaterThanOrEqual(Date.parse(record.startedAt));
  const status = laneStatusOf(record);
  expect(status).toBeDefined();
  expect(describeStatus(status!)).toBe(`Failed at run 2: step 2 exited with code 3 [run ${id}]`);
  expect(`hugi logs ${/\[run ([^\]]+)\]/u.exec(describeStatus(status!))?.[1]}`).toBe(
    `hugi logs ${id}`,
  );
});

test('after writing its record a run applies retention but never deletes itself', async () => {
  const old = '2020-01-01T000000Z-aaaaaaaaa-old123';
  await mkdir(join(runsDir(), old), { recursive: true });
  await writeRunRecord(
    join(runsDir(), old),
    sampleRecord({ endedAt: '2020-01-01T00:00:00.000Z', runId: old }),
  );
  await hugiRun();
  const names = await readdir(runsDir());
  expect(names).toHaveLength(1);
  expect(names).not.toContain(old);
});

test('the configuration sets the retention limits', async () => {
  const configDir = join(state, 'config', 'hugi');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'config.yaml'),
    'repositories: [a/b]\nallowlist: []\nruns:\n  max_age_days: 3650\n',
  );
  const old = '2020-01-01T000000Z-aaaaaaaaa-old123';
  await mkdir(join(runsDir(), old), { recursive: true });
  await writeRunRecord(
    join(runsDir(), old),
    sampleRecord({ endedAt: '2020-01-01T00:00:00.000Z', runId: old }),
  );
  await hugiRun();
  await access(join(runsDir(), old));
});

test('the record exists from the start as running, and is rewritten as finished', async () => {
  await hugiRun();
  expect(JSON.parse(seenAtBoot[0] ?? '')).toMatchObject({
    commit: { head: SHA },
    event: 'push',
    lane: { job: 'build', statusName: 'hugi / build' },
    repository: 'example/project',
    state: 'running',
  });
  const [id] = await readdir(runsDir());
  const record = await readRunRecord(join(runsDir(), id ?? ''));
  expect(record.state).toBe('finished');
  expect(record.startedAt).toBe(JSON.parse(seenAtBoot[0] ?? '').startedAt);
});

test('a refused configuration warns and skips retention, which never tells hugi run to pass --config', async () => {
  const configDir = join(state, 'config', 'hugi');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'config.yaml'), 'runs: nope\n');
  const old = '2020-01-01T000000Z-aaaaaaaaa-old123';
  await mkdir(join(runsDir(), old), { recursive: true });
  await writeRunRecord(
    join(runsDir(), old),
    sampleRecord({ endedAt: '2020-01-01T00:00:00.000Z', runId: old }),
  );
  const { stderr } = await hugiRun();
  expect(stderr).toContain('Skipping run retention');
  expect(stderr).not.toContain('--config');
  expect(await readdir(runsDir())).toContain(old);
  expect(
    await readFile(
      join(runsDir(), (await readdir(runsDir())).find((name) => name !== old) ?? '', 'run.json'),
      'utf8',
    ),
  ).toContain('"verdict": "fail"');
});

test('a configuration that cannot be read warns without telling hugi run to pass --config', async () => {
  const configDir = join(state, 'config', 'hugi');
  await mkdir(join(configDir, 'config.yaml'), { recursive: true });
  const { stderr } = await hugiRun();
  expect(stderr).toContain('Cannot read the configuration file');
  expect(stderr).not.toContain('--config');
});

test('with no configuration file the default limits apply', async () => {
  const old = '2020-01-01T000000Z-aaaaaaaaa-old123';
  await mkdir(join(runsDir(), old), { recursive: true });
  await writeRunRecord(
    join(runsDir(), old),
    sampleRecord({ endedAt: '2020-01-01T00:00:00.000Z', runId: old }),
  );
  const { stderr } = await hugiRun();
  expect(stderr).not.toContain('retention');
  expect(await readdir(runsDir())).not.toContain(old);
});

test('storeRun tells retention to keep the run it just wrote', async () => {
  const configDir = join(state, 'config', 'hugi');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'config.yaml'),
    'repositories: [a/b]\nallowlist: []\nruns:\n  max_size_gb: 1\n',
  );
  // A sparse 1 GiB + 1 byte log makes the run alone pass the size limit.
  const request: RunLaneRequest = {
    commit: 'main',
    event: 'push',
    image: 'hugi-golden',
    lane: { job: 'build', workflow: 'ci.yml' },
    matrix: {},
    needs: {},
    repository: {
      cloneUrl: 'https://github.com/example/project.git',
      kind: 'github',
      name: 'example/project',
    },
  };
  const logDir = join(runsDir(), '2026-11-19T100000Z-bbbbbbbbb-abc123');
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, '01-run.log'), '');
  await truncate(join(logDir, '01-run.log'), 1024 ** 3 + 1);
  const warnings: string[] = [];
  await storeRun({
    configPath: join(configDir, 'config.yaml'),
    report: {
      lane: { job: 'build', matrix: {}, workflow: 'ci.yml' },
      logDir,
      reason: 'step-failed',
      sha: SHA,
      steps: [],
      verdict: 'fail',
    },
    request,
    runsDir: runsDir(),
    startedAt: new Date(),
    warn: (message) => warnings.push(message),
  });
  expect(warnings).toEqual([]);
  expect(await readdir(logDir)).toContain('run.json');
});
