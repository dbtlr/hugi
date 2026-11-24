/**
 * The run page as HTML (README, "The run page"): pure functions from what was read of a run to a
 * status code and a page. Every value from a record or a log goes through `html`, which escapes it.
 */
import { isRepositoryName } from '../config/schema';
import { failingStep } from '../runs/describe';
import type { FinishedRecord, RecordedStep, RunRecord } from '../runs/record';
import { html, SafeHtml } from './html';
import type { RunPageData, StepLogView } from './run-data';
import { RUN_PAGE_STYLE } from './style';

/** A page to answer with. */
export type RenderedPage = {
  readonly status: number;
  readonly html: string;
  /** Ask the browser to reload after this many seconds (a `Refresh` header). */
  readonly refreshSeconds?: number;
};

/** How often a running run's page reloads, and for how long after the run started. */
export const RUNNING_REFRESH_SECONDS = 30;
export const RUNNING_REFRESH_LIMIT_MS = 6 * 3_600_000;

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHORT_SHA_LENGTH = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `text` as a sentence: its first letter capitalised, and a full stop added unless it ends in one. */
export function sentenceOf(text: string): string {
  const trimmed = text.trim();
  const capitalised = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return capitalised.endsWith('.') ? capitalised : `${capitalised}.`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** An ISO time as `19 Nov 2026, 10:00 UTC`. */
function timeOf(iso: string): string {
  const at = new Date(iso);
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/** How long a run took, as `42 s`, `7 min 16 s` or `1 h 3 min`. */
function durationOf(startedAt: string, endedAt: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  }
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

/** The repository's page on GitHub, unless it is a local repository. */
function githubUrlOf(repository: string): string | undefined {
  return repository.startsWith('local/') || !isRepositoryName(repository)
    ? undefined
    : `https://github.com/${repository}`;
}

function commitOf(record: RunRecord, sha: string, linked: boolean): SafeHtml {
  const short = html`<code>${sha.slice(0, SHORT_SHA_LENGTH)}</code>`;
  const repository = githubUrlOf(record.repository);
  return linked && repository !== undefined && FULL_SHA.test(sha)
    ? html`<a href="${repository}/commit/${sha}">${short}</a>`
    : short;
}

function contextOf(record: RunRecord): SafeHtml {
  const url = githubUrlOf(record.repository);
  const repository =
    url === undefined ? record.repository : html`<a href="${url}">${record.repository}</a>`;
  return html`<p class="context"><strong>${record.lane.statusName}</strong> on ${repository}</p>`;
}

function factsOf(record: RunRecord): SafeHtml {
  const { head, merge } = record.commit;
  const commits =
    record.event === 'pull_request'
      ? html`<div>
            <dt>Head commit</dt>
            <dd>${commitOf(record, head, true)}, the pull request’s head</dd>
          </div>
          ${
            merge === undefined
              ? ''
              : html`<div>
                  <dt>Tested merge commit</dt>
                  <dd>${commitOf(record, merge, false)}</dd>
                </div>`
          }`
      : html`<div>
          <dt>Commit</dt>
          <dd>${commitOf(record, head, true)}, a push</dd>
        </div>`;
  const took =
    record.state === 'finished'
      ? html`<div>
          <dt>Took</dt>
          <dd>${durationOf(record.startedAt, record.endedAt)}</dd>
        </div>`
      : '';
  return html`<dl class="facts">
    ${commits}
    <div>
      <dt>Started</dt>
      <dd>${timeOf(record.startedAt)}</dd>
    </div>
    ${took}
    <div>
      <dt>Workflow</dt>
      <dd><code>${record.lane.workflow}</code></dd>
    </div>
  </dl>`;
}

/** A finished run's verdict as a sentence, and the colour it is set in. */
function verdictOf(record: FinishedRecord): { readonly sentence: string; readonly tone: string } {
  const cause = record.detail ?? record.reason;
  switch (record.verdict) {
    case 'pass': {
      return { sentence: 'Passed.', tone: 'pass' };
    }
    case 'fail': {
      return { sentence: sentenceOf(cause), tone: 'fail' };
    }
    case 'none': {
      return { sentence: `No verdict: ${sentenceOf(cause)}`, tone: 'none' };
    }
    default: {
      const _exhaustive: never = record.verdict;
      return _exhaustive;
    }
  }
}

/** A step's outcome as the page words it, and the colour it is set in. */
function outcomeOf(step: RecordedStep): { readonly label: string; readonly tone: string } {
  const continued = step.continuedOnError === true;
  switch (step.outcome) {
    case 'success': {
      return { label: 'passed', tone: 'pass' };
    }
    case 'failure': {
      return continued
        ? { label: 'failed, continued', tone: 'continued' }
        : { label: 'failed', tone: 'fail' };
    }
    case 'timeout': {
      return continued
        ? { label: 'timed out, continued', tone: 'continued' }
        : { label: 'timed out', tone: 'fail' };
    }
    case 'skipped': {
      return { label: 'did not run', tone: 'muted' };
    }
    case 'resolved': {
      return { label: 'resolved before the run', tone: 'muted' };
    }
    default: {
      return { label: step.outcome, tone: 'muted' };
    }
  }
}

const REFUSALS = {
  missing: 'Its log file is missing.',
  'not-a-file': 'Its log file is not a regular file, so Hugi will not read it.',
  'symbolic-link': 'Its log file is a symbolic link, so Hugi will not read it.',
  unreadable: 'Its log file cannot be read',
} as const;

/** What a step shows when opened: its log, or why there is none. */
function logOf(log: StepLogView | undefined): SafeHtml {
  if (log === undefined) {
    return html`<p class="note">This step wrote no log.</p>`;
  }
  if (log.kind === 'refused') {
    const words = REFUSALS[log.problem];
    return html`<p class="note">
      ${log.detail === undefined ? words : `${words}: ${log.detail}`}
    </p>`;
  }
  if (log.text === '' && !log.cut) {
    return html`<p class="note">This step wrote no output.</p>`;
  }
  const cut = log.cut
    ? html`<p class="note">
        This log is longer than 1 MiB, so only its last 1 MiB is shown, from the first whole line.
      </p>`
    : '';
  return html`<div class="log-scroll">
      <pre class="log"><code>${log.text}</code></pre>
    </div>
    ${cut}`;
}

function cellsOf(step: RecordedStep, chevron: boolean): SafeHtml {
  const outcome = outcomeOf(step);
  const marker = chevron
    ? html`<span class="chev" aria-hidden="true"></span>`
    : html`<span></span>`;
  return html`<span class="n">${step.index}</span>${marker}<span class="name">${step.name}</span
    ><span class="out ${outcome.tone}">${outcome.label}</span>`;
}

function stepRow(step: RecordedStep, log: StepLogView | undefined, explains: boolean): SafeHtml {
  if (!explains && step.log === undefined) {
    return html`<li class="row nolog">${cellsOf(step, false)}</li>`;
  }
  const opening = explains
    ? html`<li class="row explains"><details open>`
    : html`<li class="row"><details>`;
  return html`${opening}<summary>${cellsOf(step, true)}</summary>${logOf(log)}</details></li>`;
}

function skippedRow(steps: readonly RecordedStep[], later: boolean): SafeHtml {
  const count = steps.length;
  const label = `${count} ${later ? 'later ' : ''}steps did not run`;
  return html`<li class="row skips">
    <details>
      <summary>
        <span class="n"></span><span class="chev" aria-hidden="true"></span
        ><span class="name">${label}</span><span class="out muted">skipped</span>
      </summary>
      <ul class="skiplist">
        ${steps.map((step) => html`<li>${step.index}. ${step.name}</li>`)}
      </ul>
    </details>
  </li>`;
}

/** A step with its log, or a run of two or more consecutive steps that did not run. */
type StepEntry =
  | { readonly kind: 'step'; readonly step: RecordedStep; readonly log: StepLogView | undefined }
  | { readonly kind: 'skipped'; readonly steps: RecordedStep[] };

function entriesOf(
  steps: readonly RecordedStep[],
  logs: readonly (StepLogView | undefined)[],
): StepEntry[] {
  const entries: StepEntry[] = [];
  for (const [position, step] of steps.entries()) {
    const last = entries.at(-1);
    const skipped = step.outcome === 'skipped';
    if (skipped && last?.kind === 'skipped') {
      last.steps.push(step);
    } else if (skipped && steps[position + 1]?.outcome === 'skipped') {
      entries.push({ kind: 'skipped', steps: [step] });
    } else {
      entries.push({ kind: 'step', log: logs[position], step });
    }
  }
  return entries;
}

function stepsOf(record: FinishedRecord, logs: readonly (StepLogView | undefined)[]): SafeHtml {
  const explaining = failingStep(record);
  let failedYet = false;
  const rows = entriesOf(record.steps, logs).map((entry) => {
    if (entry.kind === 'skipped') {
      return skippedRow(entry.steps, failedYet);
    }
    const explains = entry.step === explaining;
    failedYet ||= explains;
    return stepRow(entry.step, entry.log, explains);
  });
  return html`<ol class="steps">
    ${rows}
  </ol>`;
}

/** The stylesheet is Hugi's own constant, not a value from a run, so it is markup as written. */
const STYLE = new SafeHtml(RUN_PAGE_STYLE);

/** A whole page: the document around `main`. */
function documentOf(title: string, main: SafeHtml): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          ${STYLE}
        </style>
      </head>
      <body>
        <main class="page">${main}</main>
      </body>
    </html> `.markup;
}

function finishedPage(
  record: FinishedRecord,
  logs: readonly (StepLogView | undefined)[],
): RenderedPage {
  const verdict = verdictOf(record);
  const explaining = failingStep(record);
  const position = explaining === undefined ? -1 : record.steps.indexOf(explaining);
  const opensAtLog = logs[position]?.kind === 'text' && logs[position]?.text !== '';
  const titleState = { fail: 'failed', none: 'no verdict', pass: 'passed' }[record.verdict];
  return {
    html: documentOf(
      `${record.lane.statusName}: ${titleState}`,
      html`<header>
          ${contextOf(record)}
          <h1 class="verdict ${verdict.tone}">${verdict.sentence}</h1>
          ${factsOf(record)}
        </header>
        ${stepsOf(record, logs)}
        <p class="foot">
          Run ${record.runId}.${opensAtLog ? ' The open log starts at its last line.' : ''}
        </p>`,
    ),
    status: 200,
  };
}

function runningPage(record: RunRecord, now: Date): RenderedPage {
  const refreshing = now.getTime() - Date.parse(record.startedAt) < RUNNING_REFRESH_LIMIT_MS;
  const heading = refreshing ? 'Still running.' : 'Not finished.';
  const lede = refreshing
    ? `Its record has not finished, so there are no steps or logs to show yet. This page reloads every ${RUNNING_REFRESH_SECONDS} seconds.`
    : 'Its record has not finished, though the run started more than 6 hours ago: it was probably stopped before it could finish. This page no longer reloads.';
  return {
    html: documentOf(
      `${record.lane.statusName}: running`,
      html`<header>
          ${contextOf(record)}
          <h1 class="verdict none">${heading}</h1>
          <p class="lede">${lede}</p>
          ${factsOf(record)}
        </header>
        <p class="foot">Run ${record.runId}.</p>`,
    ),
    status: 200,
    ...(refreshing ? { refreshSeconds: RUNNING_REFRESH_SECONDS } : {}),
  };
}

/** A page with a heading and a few sentences, for every answer that is not a run's own page. */
function messagePage(status: number, title: string, heading: string, lede: SafeHtml): RenderedPage {
  return {
    html: documentOf(
      title,
      html`<h1 class="verdict none">${heading}</h1>
        ${lede}`,
    ),
    status,
  };
}

/** The page for what was read of a run, at time `now`. */
export function renderRunPage(data: RunPageData, now: Date): RenderedPage {
  switch (data.kind) {
    case 'finished': {
      return finishedPage(data.record, data.logs);
    }
    case 'running': {
      return runningPage(data.record, now);
    }
    case 'orphan': {
      return messagePage(
        200,
        'Run with no record',
        'No record.',
        html`<p class="lede">
            This run directory has no record: it was left by a run that did not finish, so there are
            no steps or logs to show.
          </p>
          <p class="foot">Run ${data.runId}.</p>`,
      );
    }
    case 'refused': {
      return messagePage(
        500,
        'Run record refused',
        'This run’s record cannot be shown.',
        html`<p class="lede">Hugi refuses the record, as <code>hugi logs</code> does:</p>
          <pre class="reason">${data.reason}</pre>`,
      );
    }
    case 'not-found': {
      return renderNotFound();
    }
    default: {
      const _exhaustive: never = data;
      return _exhaustive;
    }
  }
}

/** Any path that is not a run's page, and a run that is not in the runs directory. */
export function renderNotFound(): RenderedPage {
  return messagePage(
    404,
    'No run page here',
    'No run page here.',
    html`<p class="lede">
      Hugi has no run at this address. A run page is at <code>/runs/</code> followed by the run id,
      and retention deletes old runs, so a Details link stops working once its run is gone.
    </p>`,
  );
}

/** A method other than GET or HEAD. */
export function renderWrongMethod(): RenderedPage {
  return messagePage(
    405,
    'Method not allowed',
    'This page can only be read.',
    html`<p class="lede">A run page answers GET and HEAD requests only.</p>`,
  );
}

/** A request whose Host the page does not answer for. */
export function renderWrongHost(): RenderedPage {
  return messagePage(
    421,
    'Wrong host',
    'This server does not answer for that host.',
    html`<p class="lede">Open the run page at the address in the Details link.</p>`,
  );
}

/** An unexpected error: no detail, which is in the service log instead. */
export function renderUnexpectedError(): RenderedPage {
  return messagePage(
    500,
    'Run page error',
    'Something went wrong.',
    html`<p class="lede">Hugi could not show this page. The service log has the error.</p>`,
  );
}
