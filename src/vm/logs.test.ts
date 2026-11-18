import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { openLogFile } from './logs';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'hugi-logs-'));
});

afterAll(() => rm(scratch, { force: true, recursive: true }));

test('a log file collects what is written once it is closed', async () => {
  const log = await openLogFile(scratch, '01-build.log');
  log.write('one\n');
  log.write('two\n');
  await log.close();
  expect(await readFile(log.path, 'utf8')).toBe('one\ntwo\n');
});

test('a log file that cannot be opened fails at close, not as an unhandled error meanwhile', async () => {
  const unhandled: unknown[] = [];
  const record = (error: unknown) => unhandled.push(error);
  process.on('uncaughtException', record);
  try {
    await mkdir(join(scratch, '00-checkout.log'));
    const log = await openLogFile(scratch, '00-checkout.log');
    log.write('fetching\n');
    // The open fails while the run awaits other work, before anyone calls close.
    await delay(20);
    expect(unhandled).toEqual([]);
    expect(
      await log.close().then(
        () => 'closed',
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(Error);
  } finally {
    process.off('uncaughtException', record);
  }
});
