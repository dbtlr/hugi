import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeRunRecord } from '../runs/record';
import { sampleRecord, sampleRunningRecord } from '../runs/testing';
import { LOG_LIMIT_BYTES } from './log-text';
import { loadRunPage } from './run-data';

const ID = '2026-11-19T100000Z-aaaaaaaaa-abc123';

let root: string;
let runsDir: string;
let runDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hugi-web-'));
  runsDir = join(root, 'runs');
  runDir = join(runsDir, ID);
  await mkdir(runDir, { recursive: true });
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

test('an id with no run directory is not found', async () => {
  await rm(runDir, { recursive: true });
  expect(await loadRunPage(runsDir, ID)).toEqual({ kind: 'not-found' });
});

test('a run directory that is a symbolic link is not found, though it leads to a run', async () => {
  const elsewhere = join(root, 'elsewhere');
  await mkdir(elsewhere);
  await writeRunRecord(elsewhere, sampleRecord());
  await rm(runDir, { recursive: true });
  await symlink(elsewhere, runDir);
  expect(await loadRunPage(runsDir, ID)).toEqual({ kind: 'not-found' });
});

test('a file named like a run is not found', async () => {
  await rm(runDir, { recursive: true });
  await writeFile(runDir, 'not a directory');
  expect(await loadRunPage(runsDir, ID)).toEqual({ kind: 'not-found' });
});

test('a run directory with no record is an orphan', async () => {
  expect(await loadRunPage(runsDir, ID)).toEqual({ kind: 'orphan', runId: ID });
});

test.each([
  ['an unreadable record', 'garbage', `The run record ${ID}/run.json is not valid JSON`],
  ['a foreign record', '{"version":2}', `${ID}/run.json is not a Hugi run record (version 1).`],
  [
    'a record of another run',
    JSON.stringify(sampleRecord({ runId: '2026-11-19T100000Z-aaaaaaaaa-other1' })),
    `${ID}/run.json belongs to run 2026-11-19T100000Z-aaaaaaaaa-other1, not to ${ID}.`,
  ],
])(
  '%s is refused with the reason, its path relative to the runs directory',
  async (_n, text, reason) => {
    await writeFile(join(runDir, 'run.json'), text);
    const page = await loadRunPage(runsDir, ID);
    expect(page.kind).toBe('refused');
    const shown = page.kind === 'refused' ? page.reason : '';
    expect(shown).toContain(reason);
    expect(shown).not.toContain(root);
  },
);

test('a record that is a symbolic link is refused, not followed', async () => {
  await writeRunRecord(root, sampleRecord());
  await symlink(join(root, 'run.json'), join(runDir, 'run.json'));
  expect(await loadRunPage(runsDir, ID)).toEqual({
    kind: 'refused',
    reason: `${ID}/run.json is not a regular file, so Hugi will not read it.`,
  });
});

test('a running record is loaded as running', async () => {
  const record = sampleRunningRecord();
  await writeRunRecord(runDir, record);
  expect(await loadRunPage(runsDir, ID)).toEqual({ kind: 'running', record });
});

test('a finished record comes with the log of each step that has one, in the record order', async () => {
  const record = sampleRecord({
    steps: [
      { index: 0, log: '00-install-tools.log', name: 'Install tools', outcome: 'success' },
      { index: 0, name: 'Swatinem/rust-cache@v2', outcome: 'resolved' },
      { index: 1, log: '01-build.log', name: 'Build', outcome: 'failure' },
      { index: 2, name: 'Test', outcome: 'skipped' },
    ],
  });
  await writeRunRecord(runDir, record);
  await writeFile(join(runDir, '00-install-tools.log'), '');
  await writeFile(join(runDir, '01-build.log'), '\u001B[31merror\u001B[0m: boom\r\n');
  expect(await loadRunPage(runsDir, ID)).toEqual({
    kind: 'finished',
    logs: [
      { cut: false, kind: 'text', text: '' },
      undefined,
      { cut: false, kind: 'text', text: 'error: boom\n' },
      undefined,
    ],
    record,
  });
});

test('a step log that is missing, a link, or not a file is reported in its place', async () => {
  const record = sampleRecord({
    steps: [
      { index: 1, log: '01-missing.log', name: 'Missing', outcome: 'success' },
      { index: 2, log: '02-link.log', name: 'Link', outcome: 'success' },
      { index: 3, log: '03-dir.log', name: 'Directory', outcome: 'success' },
      { index: 4, log: '04-fine.log', name: 'Fine', outcome: 'success' },
    ],
    verdict: 'pass',
  });
  await writeRunRecord(runDir, record);
  await writeFile(join(root, 'secret.txt'), 'top secret');
  await symlink(join(root, 'secret.txt'), join(runDir, '02-link.log'));
  await mkdir(join(runDir, '03-dir.log'));
  await writeFile(join(runDir, '04-fine.log'), 'fine\n');
  const page = await loadRunPage(runsDir, ID);
  expect(page.kind === 'finished' ? page.logs : []).toEqual([
    { kind: 'refused', problem: 'missing' },
    { kind: 'refused', problem: 'symbolic-link' },
    { kind: 'refused', problem: 'not-a-file' },
    { cut: false, kind: 'text', text: 'fine\n' },
  ]);
});

test('a log longer than 1 MiB is cut to its last 1 MiB, from the first whole line', async () => {
  const record = sampleRecord();
  await writeRunRecord(runDir, record);
  const tail = `last line\n${'y'.repeat(LOG_LIMIT_BYTES - 20)}\nthe end\n`;
  await writeFile(join(runDir, '01-build.log'), `${'x'.repeat(5000)}\npartial ${tail}`);
  const page = await loadRunPage(runsDir, ID);
  const [log] = page.kind === 'finished' ? page.logs : [];
  expect(log).toEqual({ cut: true, kind: 'text', text: tail.slice(tail.indexOf('\n') + 1) });
});
