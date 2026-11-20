/**
 * `hugi logs <run>`: a run's summary and the log of its failing step, or of every step.
 * `hugi logs --service`: the last records of Hugi's own log.
 */
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { applicationDirectory, Command, FatalError, UsageError } from '@loomcli/core';
import type { View } from '@loomcli/core';
import { json } from '@loomcli/plugins/format';
import { helpCommand } from '@loomcli/plugins/help/extension';

import { errnoCode } from '../errno';
import { messageOf } from '../errors';
import { failingStep } from '../runs/describe';
import { RunRecordError } from '../runs/record';
import type { FinishedRecord, RecordedStep, RunRecord } from '../runs/record';
import { findRun, RunLookupError } from '../runs/store';
import { resolveRunsDir } from '../source/locations';
import { isMapping } from '../yaml/strict';

const DESCRIPTION = "Print a run's summary and the log of its failing step.";

const DETAILS = `<run> is a run id, the name of the run's directory under the runs directory (\`$XDG_STATE_HOME/hugi/runs\`); a prefix of it is enough while it names one run. A commit status description ends its run with \`[run <id>]\`.

Without options it prints the summary and the failing step's log. --all prints every step's log. --format json prints the run's record with each printed log's path and contents.

--service replaces <run>: it prints the last records of Hugi's log (\`~/Library/Logs/hugi/hugi.jsonl\` on macOS), the log \`hugi serve\` writes, as time, level, message and any other fields, one line each. --lines <n> (1 to 10000, default 50) sets how many. --format json prints the records as a JSON array; a line that is not JSON appears as {"raw": "..."}.`;

/** Exit 1: no such run, or its record cannot be read. */
class RunNotFoundError extends FatalError {
  override readonly name = 'RunNotFoundError';
  static override readonly exitCode = 1;
}

/** Exit 2: the arguments of `hugi logs` do not fit together. */
class LogsUsageError extends UsageError {
  override readonly name = 'LogsUsageError';
}

/** Exit 1: the service log cannot be found or read. */
class ServiceLogError extends FatalError {
  override readonly name = 'ServiceLogError';
  static override readonly exitCode = 1;
}

/** A printed log: where it is, and what it holds (absent when the file could not be read). */
export type PrintedLog = {
  readonly index: number;
  readonly name: string;
  readonly path: string;
  readonly contents?: string;
  /** Why the log could not be read. */
  readonly error?: string;
};

/** What `hugi logs` says about a directory that has no record. */
export const ORPHAN_NOTE = 'no record, left by a run that did not finish';

export type LogsReport = {
  readonly runId: string;
  readonly runDir: string;
  /** Absent for an orphan: a run directory with no record. */
  readonly record?: RunRecord;
  /** Set for an orphan. */
  readonly note?: string;
  readonly logs: readonly PrintedLog[];
};

/** The steps whose logs to print: every step with a log for `--all`, else the failing step's. */
function stepsToPrint(record: RunRecord, all: boolean): RecordedStep[] {
  if (record.state === 'running') {
    return [];
  }
  if (all) {
    return record.steps.filter((step) => step.log !== undefined);
  }
  const failing = failingStep(record);
  return failing?.log === undefined ? [] : [failing];
}

/**
 * Read one step's log; one that is missing, a link, or not a regular file is reported in the
 * result, not thrown and not followed.
 */
async function readLog(runDir: string, step: RecordedStep): Promise<PrintedLog> {
  const path = join(runDir, step.log ?? '');
  const base = { index: step.index, name: step.name, path };
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      return {
        ...base,
        error: 'the log is a symbolic link, so Hugi will not read it',
      };
    }
    if (!info.isFile()) {
      return {
        ...base,
        error: 'the log is not a regular file, so Hugi will not read it',
      };
    }
    return { ...base, contents: await readFile(path, 'utf8') };
  } catch (error) {
    return { ...base, error: messageOf(error) };
  }
}

function describeVerdict(record: FinishedRecord): string {
  const why = record.detail === undefined ? record.reason : `${record.reason}: ${record.detail}`;
  return `${record.verdict} (${why})`;
}

function renderOrphan(report: LogsReport): string {
  return [
    `run:      ${report.runId}`,
    `state:    orphan (${ORPHAN_NOTE})`,
    `dir:      ${report.runDir}`,
  ].join('\n');
}

function renderSummary(report: LogsReport): string {
  const { record } = report;
  if (record === undefined) {
    return renderOrphan(report);
  }
  const commit =
    record.commit.merge === undefined
      ? record.commit.head
      : `${record.commit.head} (merge ${record.commit.merge})`;
  const identity = [
    `run:      ${record.runId}`,
    `lane:     ${record.lane.statusName} (${record.lane.workflow}:${record.lane.job})`,
    `repo:     ${record.repository}`,
    `commit:   ${commit}`,
    `event:    ${record.event}`,
  ];
  if (record.state === 'running') {
    return [...identity, `started:  ${record.startedAt}`, 'state:    running'].join('\n');
  }
  const seconds = (Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 1000;
  return [
    ...identity,
    `started:  ${record.startedAt} (${seconds.toFixed(1)}s)`,
    `verdict:  ${describeVerdict(record)}`,
    'steps:',
    ...record.steps.map(
      (step) =>
        `  ${String(step.index).padStart(2)} ${step.outcome.padEnd(8)} ${step.name}${step.log === undefined ? '' : `  ${step.log}`}`,
    ),
  ].join('\n');
}

function renderLog(log: PrintedLog): string {
  const heading = `--- step ${log.index}: ${log.name} (${log.path}) ---`;
  if (log.contents === undefined) {
    return `${heading}\nthe log could not be read: ${log.error}`;
  }
  return `${heading}\n${log.contents.endsWith('\n') ? log.contents : `${log.contents}\n`}`.trimEnd();
}

/** The summary, then each printed log under a heading; a note when there is no log to show. */
export function renderLogsReport(report: LogsReport): string {
  const parts = [renderSummary(report), ...report.logs.map(renderLog)];
  if (report.logs.length === 0 && report.record?.state === 'finished') {
    parts.push('No log to show: no failing step has one. Pass --all to print every step log.');
  }
  return `${parts.join('\n\n')}\n`;
}

/** The file name Loom's logging plugin gives Hugi's log in its directory. */
const SERVICE_LOG_FILE = 'hugi.jsonl';

/** The default log directory is `logs` for the application `hugi`, as the logging plugin resolves it. */
export function serviceLogPath(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platform: string,
): string {
  const lookup = applicationDirectory('logs', 'hugi', { env, home, platform });
  if ('variable' in lookup) {
    throw new ServiceLogError(
      `Hugi cannot place its service log: ${lookup.variable} is unset, empty, or not an absolute path.`,
    );
  }
  return join(lookup.path, SERVICE_LOG_FILE);
}

/** A log line that is a JSON object is a record; anything else is kept raw. */
export type ServiceLogEntry = Readonly<Record<string, unknown>>;

/** The default and the bounds of `--lines`. */
const DEFAULT_LINES = 50;
const MAX_LINES = 10_000;
/** How much the tail reader reads at a time, backward from the end. */
export const TAIL_CHUNK_BYTES = 64 * 1024;

/** The most the tail reader reads, backward from the end: 10,000 records of ordinary length fit. */
export const TAIL_MAX_BYTES = 1024 * 1024;
const NEWLINE_BYTE = 10;

function parseLineCount(text: string | undefined): number {
  if (text === undefined) {
    return DEFAULT_LINES;
  }
  const count = /^\d+$/u.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_LINES) {
    throw new LogsUsageError(
      `--lines is "${text}", but it must be a whole number from 1 to ${MAX_LINES}.`,
    );
  }
  return count;
}

/** The part of a file handle the tail reader uses; the seam a test replaces to count its reads. */
export type TailFile = {
  readonly stat: () => Promise<{ readonly size: number }>;
  readonly read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ readonly bytesRead: number }>;
  readonly close: () => Promise<void>;
};

/**
 * The last `count` non-empty lines of a file, reading backward in chunks and at most
 * `TAIL_MAX_BYTES`, so a large log is never loaded whole. A first line that the read began in the
 * middle of is dropped: one cut by a chunk, and one that begins before the bound, so a run of long
 * lines can yield fewer than `count`.
 */
export async function readTailLines(
  path: string,
  count: number,
  openFile: (path: string) => Promise<TailFile> = async (file) => open(file, 'r'),
): Promise<string[]> {
  const handle = await openFile(path);
  try {
    const { size } = await handle.stat();
    const floor = Math.max(0, size - TAIL_MAX_BYTES);
    let position = size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    // `count` complete lines need `count` newlines after the first line the read may have cut.
    while (position > floor && newlines <= count) {
      const length = Math.min(TAIL_CHUNK_BYTES, position - floor);
      position -= length;
      const chunk = Buffer.alloc(length);
      // Each read depends on how many lines the last ones gave.
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      // A file that shrank after `stat` reads short; the rest of the buffer is zero fill.
      const kept = chunk.subarray(0, bytesRead);
      newlines += kept.filter((byte) => byte === NEWLINE_BYTE).length;
      chunks.push(kept);
      if (bytesRead < length) {
        break;
      }
    }
    const lines = Buffer.concat(chunks.toReversed()).toString('utf8').split('\n');
    if (position > 0) {
      lines.shift();
    }
    return lines.filter((line) => line !== '').slice(-count);
  } finally {
    await handle.close();
  }
}

function entryOf(line: string): ServiceLogEntry {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isMapping(parsed)) {
      return parsed;
    }
  } catch {
    // Not JSON: kept raw below.
  }
  return { raw: line };
}

/** A field value as `key=value`: bare when it is a plain word, else as JSON. */
function fieldText(value: unknown): string {
  return typeof value === 'string' && /^[^\s"=]+$/u.test(value) ? value : JSON.stringify(value);
}

function renderEntry(entry: ServiceLogEntry): string {
  if ('raw' in entry && typeof entry.raw === 'string' && Object.keys(entry).length === 1) {
    return entry.raw;
  }
  const { fields, level, message, time, ...rest } = entry;
  const nested =
    typeof fields === 'object' && fields !== null && !Array.isArray(fields) ? fields : {};
  const head = [time, level, message].filter((part) => part !== undefined).map(String);
  const extra = Object.entries({ ...nested, ...rest }).map(
    ([key, value]) => `${key}=${fieldText(value)}`,
  );
  return [...head, ...extra].join(' ');
}

/** The service log's records, one text line each. */
export function renderServiceLog(entries: readonly ServiceLogEntry[]): string {
  return entries.length === 0 ? '' : `${entries.map(renderEntry).join('\n')}\n`;
}

const isServiceLog = (report: object): report is readonly ServiceLogEntry[] =>
  Array.isArray(report);

const textView: View<LogsReport | readonly ServiceLogEntry[]> = {
  render: (report) => (isServiceLog(report) ? renderServiceLog(report) : renderLogsReport(report)),
};

async function serviceLogEntries(path: string, count: number): Promise<ServiceLogEntry[]> {
  try {
    return (await readTailLines(path, count)).map(entryOf);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      throw new ServiceLogError(`No service log exists yet at ${path}.`);
    }
    throw new ServiceLogError(`The service log ${path} cannot be read: ${messageOf(error)}`);
  }
}

export function logsCommand() {
  return new Command('logs', { description: DESCRIPTION })
    .extend(helpCommand({ details: DETAILS }))
    .argument('run', {
      description: 'A run id, or a unique prefix of one. Not with --service.',
    })
    .option('all', {
      description: "Print every step's log, not only the failing one.",
      type: 'boolean',
    })
    .option('service', {
      description: "Print the last records of Hugi's own log instead of a run.",
      type: 'boolean',
    })
    .option('lines', {
      description: 'With --service, how many records: 1 to 10000, 50 when omitted.',
      type: 'string',
    })
    .result<LogsReport | readonly ServiceLogEntry[]>({ views: { json: json(), text: textView } })
    .views({ text: textView }, { default: 'text' })
    .action(async ({ args, host, options, out }) => {
      if (options.service) {
        if (args.run !== undefined) {
          throw new LogsUsageError('--service takes no <run>: it prints the service log.');
        }
        const count = parseLineCount(options.lines);
        const path = serviceLogPath(host.env, host.home, host.platform);
        await out.results(await serviceLogEntries(path, count));
        return;
      }
      if (options.lines !== undefined) {
        throw new LogsUsageError('--lines works only with --service.');
      }
      if (args.run === undefined) {
        throw new LogsUsageError(
          'hugi logs <run> needs a run id, or --service for the service log.',
        );
      }
      const runsDir = resolveRunsDir(host.env, host.home);
      let report: LogsReport;
      try {
        const run = await findRun(runsDir, args.run);
        const { contents } = run;
        if (contents.kind === 'unusable') {
          throw contents.error;
        }
        if (contents.kind === 'missing') {
          report = {
            logs: [],
            note: ORPHAN_NOTE,
            runDir: run.dir,
            runId: run.id,
          };
        } else {
          const logs = await Promise.all(
            stepsToPrint(contents.record, options.all).map((step) => readLog(run.dir, step)),
          );
          report = {
            logs,
            record: contents.record,
            runDir: run.dir,
            runId: run.id,
          };
        }
      } catch (error) {
        if (error instanceof RunLookupError || error instanceof RunRecordError) {
          throw new RunNotFoundError(error.message);
        }
        throw error;
      }
      await out.results(report);
    });
}
