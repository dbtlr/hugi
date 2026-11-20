/** `hugi logs <run>`: a run's summary and the log of its failing step, or of every step. */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command, FatalError } from '@loomcli/core';
import type { View } from '@loomcli/core';
import { json } from '@loomcli/plugins/format';
import { helpCommand } from '@loomcli/plugins/help/extension';

import { messageOf } from '../errors';
import { failingStep } from '../runs/describe';
import { RunRecordError } from '../runs/record';
import type { FinishedRecord, RecordedStep, RunRecord } from '../runs/record';
import { findRun, RunLookupError } from '../runs/store';
import { resolveRunsDir } from '../source/locations';

const DESCRIPTION = "Print a run's summary and the log of its failing step.";

const DETAILS = `<run> is a run id, the name of the run's directory under the runs directory (\`$XDG_STATE_HOME/hugi/runs\`); a prefix of it is enough while it names one run. A commit status description ends its run with \`[run <id>]\`.

Without options it prints the summary and the failing step's log. --all prints every step's log. --format json prints the run's record with each printed log's path and contents.`;

/** Exit 1: no such run, or its record cannot be read. */
class RunNotFoundError extends FatalError {
  override readonly name = 'RunNotFoundError';
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

const textView: View<LogsReport> = { render: renderLogsReport };

export function logsCommand() {
  return new Command('logs', { description: DESCRIPTION })
    .extend(helpCommand({ details: DETAILS }))
    .argument('run', {
      description: 'A run id, or a unique prefix of one.',
      required: true,
    })
    .option('all', {
      description: "Print every step's log, not only the failing one.",
      type: 'boolean',
    })
    .result<LogsReport>({ views: { json: json(), text: textView } })
    .views({ text: textView }, { default: 'text' })
    .action(async ({ args, host, options, out }) => {
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
