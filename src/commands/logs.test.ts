import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockProcess } from '@loomcli/testing';

import { createApp } from '../app';
import { writeRunRecord } from '../runs/record';
import { sampleRecord, sampleRunningRecord } from '../runs/testing';
import { readTailLines, serviceLogPath, TAIL_CHUNK_BYTES, TAIL_MAX_BYTES } from './logs';

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

// `hugi logs --service`: the service log, under a home of its own.
let serviceHome: string;
let serviceLog: string;
beforeEach(async () => {
  serviceHome = await mkdtemp(join(tmpdir(), 'hugi-service-logs-'));
  serviceLog = join(serviceHome, 'Library', 'Logs', 'hugi', 'hugi.jsonl');
  await mkdir(join(serviceHome, 'Library', 'Logs', 'hugi'), { recursive: true });
});
afterEach(async () => {
  await rm(serviceHome, { force: true, recursive: true });
});

async function hugiService(...argv: string[]) {
  const mock = mockProcess({
    argv: ['logs', ...argv],
    env: { HOME: serviceHome },
    home: serviceHome,
    platform: 'darwin',
    stdin: '',
  });
  const exitCode = await createApp().run({ process: mock });
  return { exitCode, stderr: mock.stderr.text, stdout: mock.stdout.text };
}

const serviceRecord = (index: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    level: 'info',
    message: `event ${index}`,
    time: `2026-11-19T10:00:${String(index % 60).padStart(2, '0')}.000Z`,
    ...extra,
  });

const writeServiceLog = (lines: readonly string[]) =>
  writeFile(serviceLog, `${lines.join('\n')}\n`);

test('the service log path follows the platform, from Loom’s directory rules', () => {
  expect(serviceLogPath({}, '/Users/u', 'darwin')).toBe('/Users/u/Library/Logs/hugi/hugi.jsonl');
  expect(serviceLogPath({ XDG_STATE_HOME: '/state' }, '/home/u', 'linux')).toBe(
    '/state/hugi/hugi.jsonl',
  );
});

test('prints the last 50 records as time, level and message, one line each', async () => {
  await writeServiceLog(Array.from({ length: 60 }, (_, index) => serviceRecord(index)));
  const { exitCode, stdout } = await hugiService('--service');
  expect(exitCode).toBe(0);
  const lines = stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(50);
  expect(lines[0]).toBe('2026-11-19T10:00:10.000Z info event 10');
  expect(lines.at(-1)).toBe('2026-11-19T10:00:59.000Z info event 59');
});

test('--lines picks the count', async () => {
  await writeServiceLog(Array.from({ length: 10 }, (_, index) => serviceRecord(index)));
  const { stdout } = await hugiService('--service', '--lines', '3');
  expect(stdout.trimEnd().split('\n')).toHaveLength(3);
  expect(stdout).toContain('event 9');
  expect(stdout).not.toContain('event 6');
});

test('other fields follow the message, compactly', async () => {
  await writeServiceLog([
    serviceRecord(1, {
      fields: { note: 'two words', repository: 'dbtlr/hugi', waiting: 2 },
      run: 'abc',
    }),
  ]);
  const { stdout } = await hugiService('--service');
  expect(stdout.trimEnd()).toBe(
    '2026-11-19T10:00:01.000Z info event 1 note="two words" repository=dbtlr/hugi waiting=2 run=abc',
  );
});

test('a line that is not JSON prints raw, and a JSON value that is not a record does too', async () => {
  await writeServiceLog([serviceRecord(1), 'half a li', '42']);
  const { stdout } = await hugiService('--service');
  expect(stdout.trimEnd().split('\n')).toEqual([
    '2026-11-19T10:00:01.000Z info event 1',
    'half a li',
    '42',
  ]);
});

test('--format json prints an array of the records, with raw lines as {raw}', async () => {
  await writeServiceLog([serviceRecord(1), 'half a li']);
  const { exitCode, stdout } = await hugiService('--service', '--format', 'json');
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual([JSON.parse(serviceRecord(1)), { raw: 'half a li' }]);
});

test('a missing log fails with exit 1 naming the path', async () => {
  const { exitCode, stderr } = await hugiService('--service');
  expect(exitCode).toBe(1);
  expect(stderr).toContain(`No service log exists yet at ${serviceLog}`);
});

test('an empty log prints nothing and succeeds', async () => {
  await writeFile(serviceLog, '');
  const { exitCode, stdout } = await hugiService('--service');
  expect(exitCode).toBe(0);
  expect(stdout).toBe('');
});

test('only the tail of a large log is read, and a partial first line is dropped', async () => {
  const line = serviceRecord(1, { fields: { pad: 'x'.repeat(900) } });
  await writeServiceLog(Array.from({ length: 3000 }, () => line));
  await writeFile(serviceLog, `${await Bun.file(serviceLog).text()}${serviceRecord(7)}\n`);
  const { stdout } = await hugiService('--service', '--lines', '2');
  const lines = stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe('2026-11-19T10:00:07.000Z info event 7');
  expect(lines[0]).toStartWith('2026-11-19T10:00:01.000Z info event 1 pad=');
});

test('the reader stops at its bound from the end, leaving out a record that begins before it', async () => {
  // A few long records: the 50 lines asked for lie far beyond the bound.
  const long = serviceRecord(1, { fields: { pad: 'x'.repeat(TAIL_MAX_BYTES + 1024 * 1024) } });
  await writeServiceLog([long, long, serviceRecord(7)]);
  expect(await readTailLines(serviceLog, 50)).toEqual([serviceRecord(7)]);
});

/** An opener that counts the bytes the tail reader reads through it. */
function countingOpener() {
  const counted = { bytesRead: 0 };
  const openFile = async (path: string) => {
    const handle = await open(path, 'r');
    return {
      close: () => handle.close(),
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const read = await handle.read(buffer, offset, length, position);
        counted.bytesRead += read.bytesRead;
        return read;
      },
      stat: () => handle.stat(),
    };
  };
  return { counted, openFile };
}

test('the reader reads no more than its bound, whatever the file holds', async () => {
  const long = serviceRecord(1, { fields: { pad: 'x'.repeat(TAIL_MAX_BYTES + 1024 * 1024) } });
  await writeServiceLog([long, serviceRecord(7)]);
  const { counted, openFile } = countingOpener();
  await readTailLines(serviceLog, 50, openFile);
  expect(counted.bytesRead).toBeGreaterThan(0);
  expect(counted.bytesRead).toBeLessThanOrEqual(TAIL_MAX_BYTES);
});

test('a read shorter than asked keeps only the bytes read, never zero-filled bytes', async () => {
  // The file shrank after stat: it reports 64 bytes but holds 8.
  const content = Buffer.from('one\ntwo\n');
  const openFile = async () => ({
    close: async () => {},
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      const piece = content.subarray(position, position + length);
      piece.copy(buffer, offset);
      return { bytesRead: piece.length };
    },
    stat: async () => ({ size: 64 }),
  });
  expect(await readTailLines('ignored', 5, openFile)).toEqual(['one', 'two']);
});

test('the reader stops at the chunk that holds the lines asked for', async () => {
  // 2 MiB of short records: the last chunk alone holds the five asked for.
  const records = Array.from({ length: 30_000 }, (_, index) => `${'r'.repeat(64)} ${index}`);
  await writeFile(serviceLog, `${records.join('\n')}\n`);
  const { counted, openFile } = countingOpener();
  expect(await readTailLines(serviceLog, 5, openFile)).toEqual(records.slice(-5));
  expect(counted.bytesRead).toBe(TAIL_CHUNK_BYTES);
});

test('a chunk that ends with exactly the newlines asked for is followed by one more', async () => {
  // Three lines of 0.6 chunks: the last chunk begins inside the second line and holds two newlines.
  const length = Math.floor(TAIL_CHUNK_BYTES * 0.6);
  const [first, second, third] = ['a'.repeat(length), 'b'.repeat(length), 'c'.repeat(length)];
  await writeFile(serviceLog, `${first}\n${second}\n${third}\n`);
  expect(await readTailLines(serviceLog, 2)).toEqual([second, third]);
});

test('a multi-byte character the chunk boundary falls inside is decoded whole', async () => {
  // The last chunk begins after the first of the check mark's three bytes.
  const line = `\u2713${'c'.repeat(TAIL_CHUNK_BYTES - 3)}`;
  await writeFile(serviceLog, `a\n${line}\n`);
  expect(Buffer.byteLength(`a\n${line}\n`) - TAIL_CHUNK_BYTES).toBe(3);
  expect(await readTailLines(serviceLog, 1)).toEqual([line]);
});

test('a multi-byte character is not split at a chunk boundary', async () => {
  await writeServiceLog(
    Array.from({ length: 4000 }, () => serviceRecord(1, { message: 'héllo ✓ 日本' })),
  );
  const { stdout } = await hugiService('--service', '--lines', '1000');
  expect(stdout).not.toContain('�');
});

test.each([
  ['no run and no --service', [], 'logs <run>'],
  ['a run with --service', ['some-run', '--service'], '--service'],
  ['--lines without --service', ['some-run', '--lines', '5'], '--lines'],
  ['--all with --service', ['--service', '--all'], '--all'],
  ['--lines of 0', ['--service', '--lines', '0'], '1 to 10000'],
  ['--lines of 10001', ['--service', '--lines', '10001'], '1 to 10000'],
  ['--lines that is not a number', ['--service', '--lines', 'many'], '1 to 10000'],
  ['--lines that is fractional', ['--service', '--lines', '2.5'], '1 to 10000'],
])('%s is a usage error with exit 2', async (_name, argv, message) => {
  const { exitCode, stderr } = await hugiService(...argv);
  expect(exitCode).toBe(2);
  expect(stderr).toContain(message);
});
