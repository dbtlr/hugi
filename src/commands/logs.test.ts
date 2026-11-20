import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockProcess } from '@loomcli/testing';

import { createApp } from '../app';
import { writeRunRecord } from '../runs/record';
import { sampleRecord, sampleRunningRecord } from '../runs/testing';

const ID = '2026-11-19T100000Z-aaaaaaaaa-abc123';

let state: string;
let runsDir: string;
beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), 'hugi-logs-'));
  runsDir = join(state, 'hugi', 'runs');
  await mkdir(join(runsDir, ID), { recursive: true });
  await writeRunRecord(
    join(runsDir, ID),
    sampleRecord({ detail: 'step 1 (Build) exited with code 3' }),
  );
  await writeFile(join(runsDir, ID, '01-build.log'), 'compiling\nerror: boom\n');
});
afterEach(async () => {
  await rm(state, { force: true, recursive: true });
});

async function hugi(...argv: string[]) {
  const mock = mockProcess({
    argv: ['logs', ...argv],
    env: { HOME: '/home/mock', XDG_STATE_HOME: state },
    stdin: '',
  });
  const exitCode = await createApp().run({ process: mock });
  return { exitCode, stderr: mock.stderr.text, stdout: mock.stdout.text };
}

test('prints the summary and the failing step log', async () => {
  const { exitCode, stdout } = await hugi(ID);
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`run:      ${ID}`);
  expect(stdout).toContain('lane:     hugi / test (macos-15, 16) (ci.yml:test)');
  expect(stdout).toContain('verdict:  fail (step-failed: step 1 (Build) exited with code 3)');
  expect(stdout).toContain('--- step 1: Build');
  expect(stdout).toContain('error: boom');
});

test('accepts a unique prefix of the run id', async () => {
  const { exitCode, stdout } = await hugi('2026-11-19T1000');
  expect(exitCode).toBe(0);
  expect(stdout).toContain(`run:      ${ID}`);
});

test('--all prints every step log, and says a missing one could not be read', async () => {
  await writeRunRecord(
    join(runsDir, ID),
    sampleRecord({
      steps: [
        { index: 1, log: '01-build.log', name: 'Build', outcome: 'failure' },
        { index: 2, log: '02-test.log', name: 'Test', outcome: 'success' },
      ],
    }),
  );
  const failing = await hugi(ID);
  expect(failing.stdout).not.toContain('--- step 2');
  const { stdout } = await hugi(ID, '--all');
  expect(stdout).toContain('--- step 1: Build');
  expect(stdout).toContain('--- step 2: Test');
  expect(stdout).toContain('the log could not be read');
});

test('a run with no failing step says so and points at --all', async () => {
  await writeRunRecord(join(runsDir, ID), sampleRecord({ steps: [], verdict: 'pass' }));
  const { exitCode, stdout } = await hugi(ID);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('No log to show');
});

test('--format json carries the record and each printed log with its path and contents', async () => {
  const { stdout } = await hugi(ID, '--format', 'json');
  const report = JSON.parse(stdout);
  expect(report.record.runId).toBe(ID);
  expect(report.record.lane.statusName).toBe('hugi / test (macos-15, 16)');
  expect(report.logs).toEqual([
    {
      contents: 'compiling\nerror: boom\n',
      index: 1,
      name: 'Build',
      path: join(runsDir, ID, '01-build.log'),
    },
  ]);
});

test('an unknown run id fails with a message naming the runs directory', async () => {
  const { exitCode, stderr } = await hugi('nope');
  expect(exitCode).toBe(1);
  expect(stderr).toContain('No run "nope"');
  expect(stderr).toContain(runsDir);
});

test('the failing step is printed even when it is not the first step', async () => {
  await writeRunRecord(
    join(runsDir, ID),
    sampleRecord({
      steps: [
        { index: 1, log: '01-setup.log', name: 'Setup', outcome: 'success' },
        { index: 2, log: '02-build.log', name: 'Build', outcome: 'failure' },
        { index: 3, name: 'Test', outcome: 'skipped' },
      ],
    }),
  );
  await writeFile(join(runsDir, ID, '01-setup.log'), 'all fine\n');
  await writeFile(join(runsDir, ID, '02-build.log'), 'the real error\n');
  const { exitCode, stdout } = await hugi(ID);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('--- step 2: Build');
  expect(stdout).toContain('the real error');
  expect(stdout).not.toContain('all fine');
  expect(stdout).not.toContain('--- step 1');
});

test('a failure continue-on-error let pass is passed over for the step that set the verdict', async () => {
  await writeRunRecord(
    join(runsDir, ID),
    sampleRecord({
      steps: [
        { continuedOnError: true, index: 1, log: '01-lint.log', name: 'Lint', outcome: 'failure' },
        { index: 2, log: '02-build.log', name: 'Build', outcome: 'failure' },
      ],
    }),
  );
  await writeFile(join(runsDir, ID, '01-lint.log'), 'an ignored warning\n');
  await writeFile(join(runsDir, ID, '02-build.log'), 'the real error\n');
  const { stdout } = await hugi(ID);
  expect(stdout).toContain('--- step 2: Build');
  expect(stdout).toContain('the real error');
  expect(stdout).not.toContain('an ignored warning');
});

test('a running run is shown as running, with no verdict or steps', async () => {
  await writeRunRecord(join(runsDir, ID), sampleRunningRecord());
  const { exitCode, stdout } = await hugi(ID);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('state:    running');
  expect(stdout).toContain('started:  2026-11-19T10:00:00.000Z');
  expect(stdout).not.toContain('verdict:');
  expect(stdout).not.toContain('No log to show');
});

test('a directory with no record is an orphan, not an error', async () => {
  const bare = '2026-11-19T110000Z-bbbbbbbbb-abc123';
  await mkdir(join(runsDir, bare));
  const { exitCode, stdout } = await hugi(bare);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('no record, left by a run that did not finish');
  const json = JSON.parse((await hugi(bare, '--format', 'json')).stdout);
  expect(json.note).toBe('no record, left by a run that did not finish');
  expect(json.record).toBeUndefined();
});

test.each([
  ['an unreadable record', 'garbage', 'not valid JSON'],
  ['a foreign record', '{"version":2}', 'not a Hugi run record'],
  [
    'a record with no commit',
    JSON.stringify({ ...sampleRecord(), commit: undefined }),
    'not a Hugi run record',
  ],
  [
    'a record whose log leaves the run directory',
    JSON.stringify(
      sampleRecord({
        steps: [{ index: 1, log: '../../secret', name: 'Build', outcome: 'failure' }],
      }),
    ),
    'not a Hugi run record',
  ],
  [
    'a record of another run',
    JSON.stringify(sampleRecord({ runId: '2026-11-19T100000Z-aaaaaaaaa-other1' })),
    'belongs to run',
  ],
  [
    'a record with a timestamp that is not ISO',
    JSON.stringify(sampleRecord({ endedAt: '2000' })),
    'not a Hugi run record',
  ],
])('%s fails with a message and exit 1', async (_name, text, message) => {
  await writeFile(join(runsDir, ID, 'run.json'), text);
  const { exitCode, stderr } = await hugi(ID);
  expect(exitCode).toBe(1);
  expect(stderr).toContain(message);
  expect(stderr).not.toContain('TypeError');
});

test('a run.json that is a symlink is refused, not followed', async () => {
  await writeRunRecord(state, sampleRecord());
  await rm(join(runsDir, ID, 'run.json'));
  await symlink(join(state, 'run.json'), join(runsDir, ID, 'run.json'));
  const { exitCode, stderr } = await hugi(ID);
  expect(exitCode).toBe(1);
  expect(stderr).toContain('not a regular file');
});

test('a step log that is a symlink is not read', async () => {
  await rm(join(runsDir, ID, '01-build.log'));
  await writeFile(join(state, 'secret.txt'), 'top secret');
  await symlink(join(state, 'secret.txt'), join(runsDir, ID, '01-build.log'));
  const { exitCode, stdout } = await hugi(ID);
  expect(exitCode).toBe(0);
  expect(stdout).toContain('symbolic link');
  expect(stdout).not.toContain('top secret');
});

test('a step log that is not a regular file is not read', async () => {
  await rm(join(runsDir, ID, '01-build.log'));
  await mkdir(join(runsDir, ID, '01-build.log'));
  const { stdout } = await hugi(ID);
  expect(stdout).toContain('not a regular file');
});
