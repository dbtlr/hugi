import { describe, expect, test } from 'bun:test';

import type { FinishedRecord, RecordedStep } from '../runs/record';
import { sampleRecord, sampleRunningRecord } from '../runs/testing';
import { renderRunPage } from './render';
import type { RunPageData, StepLogView } from './run-data';
import { RUN_PAGE_STYLE } from './style';

const NOW = new Date('2026-11-19T10:10:00.000Z');
const HOUR = 3_600_000;

const text = (value: string, cut = false): StepLogView => ({ cut, kind: 'text', text: value });

/** A finished run's page data, each step with a log given `log` text unless `logs` says otherwise. */
function finished(
  overrides: Partial<FinishedRecord> = {},
  logs?: readonly (StepLogView | undefined)[],
): RunPageData {
  const record = sampleRecord(overrides);
  return {
    kind: 'finished',
    logs: logs ?? record.steps.map((step) => (step.log === undefined ? undefined : text('log'))),
    record,
  };
}

const page = (data: RunPageData, now = NOW) => renderRunPage(data, now);
const body = (data: RunPageData) => page(data).html;

/** The text of the page's verdict heading. */
function verdictOf(markup: string): string {
  return /<h1[^>]*>(?<verdict>[\s\S]*?)<\/h1>/u.exec(markup)?.groups?.verdict ?? '';
}

/** Each step row's markup, in page order. */
function rowsOf(markup: string): string[] {
  return markup.split('<li class="row').slice(1);
}

/** The rows that are open. */
function openRowsOf(markup: string): string[] {
  return rowsOf(markup).filter((row) => row.includes('<details open>'));
}

describe('the verdict sentence', () => {
  test('a failed run states its detail, capitalised, with a full stop added', () => {
    const markup = body(
      finished({ detail: 'step 8 "Early host reads" failed with exit code 101' }),
    );
    expect(verdictOf(markup)).toBe(
      'Step 8 &quot;Early host reads&quot; failed with exit code 101.',
    );
  });

  test('a failed run with no detail states its reason', () => {
    expect(verdictOf(body(finished({ reason: 'job timed out' })))).toBe('Job timed out.');
  });

  test('a cause that ends in a full stop gets no second one', () => {
    expect(verdictOf(body(finished({ detail: 'the VM was lost.' })))).toBe('The VM was lost.');
  });

  test('a passed run says Passed', () => {
    const markup = body(finished({ steps: [], verdict: 'pass' }));
    expect(verdictOf(markup)).toBe('Passed.');
    expect(markup).toContain('class="verdict pass"');
  });

  test('a run with no verdict says so, with its cause written the same way', () => {
    const markup = body(finished({ detail: 'the VM was lost mid-run', verdict: 'none' }));
    expect(verdictOf(markup)).toBe('No verdict: The VM was lost mid-run.');
    expect(markup).toContain('class="verdict none"');
  });

  test('a failed verdict is set in the failure colour', () => {
    expect(body(finished())).toContain('class="verdict fail"');
  });
});

describe('the facts', () => {
  test('a push names its lane, repository, commit, start and duration', () => {
    const markup = body(finished());
    expect(markup).toContain('hugi / test (macos-15, 16)');
    expect(markup).toContain('href="https://github.com/dbtlr/hugi"');
    expect(markup).toContain(`href="https://github.com/dbtlr/hugi/commit/${'a'.repeat(40)}"`);
    expect(markup).toContain('19 Nov 2026, 10:00 UTC');
    expect(markup).toContain('5 min 0 s');
    expect(markup).not.toContain('merge commit');
  });

  test('a pull request names its head commit and the merge commit it tested', () => {
    const markup = body(
      finished({ commit: { head: 'a'.repeat(40), merge: 'b'.repeat(40) }, event: 'pull_request' }),
    );
    expect(markup).toContain('Head commit');
    expect(markup).toContain('Tested merge commit');
    expect(markup).toContain('bbbbbbb');
  });

  test('a local repository is named but not linked', () => {
    const markup = body(finished({ repository: 'local/hugi' }));
    expect(markup).toContain('local/hugi');
    expect(markup).not.toContain('https://github.com');
  });

  test('the duration reads in hours past an hour', () => {
    expect(body(finished({ endedAt: '2026-11-19T11:03:09.000Z' }))).toContain('1 h 3 min');
  });

  test('the run id is shown', () => {
    expect(body(finished())).toContain('2026-11-19T100000Z-aaaaaaaaa-abc123');
  });
});

/** A step numbered `index` with a log of its own. */
const step = (index: number, outcome: string, extra: Partial<RecordedStep> = {}) => ({
  index,
  log: `${String(index).padStart(2, '0')}-step.log`,
  name: `Step ${index}`,
  outcome,
  ...extra,
});

describe('the steps', () => {
  test.each([
    ['success', 'passed'],
    ['failure', 'failed'],
    ['timeout', 'timed out'],
    ['resolved', 'resolved before the run'],
    ['weird-new-outcome', 'weird-new-outcome'],
  ])('outcome %s reads %s', (outcome, label) => {
    const markup = body(finished({ steps: [step(1, outcome)], verdict: 'pass' }));
    expect(rowsOf(markup)[0]).toContain(`>${label}</span>`);
  });

  test('a failure or timeout continue-on-error let pass reads as continued', () => {
    const markup = body(
      finished({
        steps: [
          step(1, 'failure', { continuedOnError: true }),
          step(2, 'timeout', { continuedOnError: true }),
        ],
        verdict: 'pass',
      }),
    );
    const [first = '', second = ''] = rowsOf(markup);
    expect(first).toContain('>failed, continued</span>');
    expect(second).toContain('>timed out, continued</span>');
  });

  test('every step is shown in the record order with its number and name', () => {
    const markup = body(
      finished({
        steps: [step(0, 'success'), step(3, 'success'), step(1, 'success')],
        verdict: 'pass',
      }),
    );
    const rows = rowsOf(markup);
    expect(rows.map((row) => /class="n">(?<n>\d+)</u.exec(row)?.groups?.n)).toEqual([
      '0',
      '3',
      '1',
    ]);
    expect(rows[1]).toContain('Step 3');
  });

  test('the step that set the verdict is open, past a failure continue-on-error let pass', () => {
    const markup = body(
      finished({
        steps: [
          step(1, 'failure', { continuedOnError: true }),
          step(2, 'failure'),
          step(3, 'failure'),
        ],
      }),
    );
    const open = openRowsOf(markup);
    expect(open).toHaveLength(1);
    expect(open[0]).toContain('Step 2');
    expect(open[0]?.startsWith(' explains"')).toBe(true);
  });

  test('a timeout that set the verdict is open', () => {
    const open = openRowsOf(body(finished({ steps: [step(1, 'success'), step(2, 'timeout')] })));
    expect(open).toHaveLength(1);
    expect(open[0]).toContain('Step 2');
  });

  test('a run with no failing step has no open step, whatever its verdict', () => {
    expect(openRowsOf(body(finished({ steps: [step(1, 'success')], verdict: 'pass' })))).toEqual(
      [],
    );
    expect(openRowsOf(body(finished({ steps: [step(1, 'success')], verdict: 'fail' })))).toEqual(
      [],
    );
  });

  test('a run with no verdict opens the step that failed', () => {
    const open = openRowsOf(body(finished({ steps: [step(1, 'failure')], verdict: 'none' })));
    expect(open).toHaveLength(1);
  });

  test('the open step with no log shows that it wrote none', () => {
    const markup = body(
      finished({ steps: [{ index: 4, name: 'Lost', outcome: 'failure' }] }, [undefined]),
    );
    const [open = ''] = openRowsOf(markup);
    expect(open).toContain('This step wrote no log.');
  });

  test('a step with a log opens to it, closed unless it explains the verdict', () => {
    const markup = body(
      finished({ steps: [step(1, 'success')], verdict: 'pass' }, [text('built ok\n')]),
    );
    const [row = ''] = rowsOf(markup);
    expect(row).toContain('<details>');
    expect(row).toContain('built ok');
  });

  test('a step with no log is a plain row', () => {
    const markup = body(
      finished({ steps: [{ index: 0, name: 'Swatinem/rust-cache@v2', outcome: 'resolved' }] }, [
        undefined,
      ]),
    );
    const [row = ''] = rowsOf(markup);
    expect(row).not.toContain('<details');
  });

  test('an empty log says the step wrote no output', () => {
    const markup = body(finished({ steps: [step(1, 'success')], verdict: 'pass' }, [text('')]));
    expect(markup).toContain('This step wrote no output.');
  });

  test('a cut log says it shows only its last 1 MiB', () => {
    const markup = body(finished({ steps: [step(1, 'failure')] }, [text('tail\n', true)]));
    expect(openRowsOf(markup)[0]).toContain('last 1 MiB');
  });

  test.each([
    ['missing', undefined, 'missing'],
    ['symbolic-link', undefined, 'symbolic link'],
    ['not-a-file', undefined, 'not a regular file'],
    [
      'unreadable',
      "EACCES: permission denied, open 'run/01-step.log'",
      'EACCES: permission denied',
    ],
  ] as const)('a log that is %s is reported in its place', (problem, detail, words) => {
    const markup = body(
      finished({ steps: [step(1, 'failure'), step(2, 'success')] }, [
        { kind: 'refused', problem, ...(detail === undefined ? {} : { detail }) },
        text('the rest still shows'),
      ]),
    );
    expect(openRowsOf(markup)[0]).toContain(words);
    expect(markup).toContain('the rest still shows');
  });

  test('consecutive steps that did not run fold into one row', () => {
    const markup = body(
      finished({
        steps: [
          step(1, 'failure'),
          { index: 2, name: 'Two', outcome: 'skipped' },
          { index: 3, name: 'Three', outcome: 'skipped' },
          { index: 4, name: 'Four', outcome: 'skipped' },
        ],
      }),
    );
    const rows = rowsOf(markup);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('3 later steps did not run');
    expect(rows[1]).toContain('2. Two');
    expect(rows[1]).toContain('4. Four');
  });

  test('a step that ran after a failure splits the steps that did not run', () => {
    const markup = body(
      finished({
        steps: [
          step(1, 'failure'),
          { index: 2, name: 'Two', outcome: 'skipped' },
          step(3, 'success', { name: 'Always upload' }),
          { index: 4, name: 'Four', outcome: 'skipped' },
          { index: 5, name: 'Five', outcome: 'skipped' },
        ],
      }),
    );
    const rows = rowsOf(markup);
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain('1 later step did not run');
    expect(rows[2]).toContain('Always upload');
    expect(rows[3]).toContain('2 later steps did not run');
  });

  test('steps that did not run before any failure are not called later', () => {
    const markup = body(
      finished({
        steps: [{ index: 1, name: 'One', outcome: 'skipped' }, step(2, 'success')],
        verdict: 'pass',
      }),
    );
    expect(rowsOf(markup)[0]).toContain('1 step did not run');
  });
});

describe('escaping', () => {
  const HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)>';

  test('step names, status names, causes, outcomes and logs are text, not markup', () => {
    const record = sampleRecord({
      detail: HOSTILE,
      lane: { job: 'j', matrix: {}, statusName: HOSTILE, workflow: HOSTILE },
      repository: `x/"><script>`,
      steps: [
        { index: 1, log: '01-x.log', name: HOSTILE, outcome: 'failure' },
        { index: 2, name: HOSTILE, outcome: HOSTILE },
        { index: 3, name: HOSTILE, outcome: 'skipped' },
      ],
    });
    const markup = renderRunPage(
      { kind: 'finished', logs: [text(HOSTILE), undefined, undefined], record },
      NOW,
    ).html;
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  test('a refused record reason is text', () => {
    const markup = page({ kind: 'refused', reason: `${HOSTILE}/run.json is not valid` }).html;
    expect(markup).not.toContain('<script>');
  });
});

describe('a run in progress', () => {
  const running: RunPageData = { kind: 'running', record: sampleRunningRecord() };

  test('shows the lane, commit and start, says its record has not finished, and has no steps', () => {
    const shown = page(running);
    expect(shown.status).toBe(200);
    expect(shown.html).toContain('hugi / test (macos-15, 16)');
    expect(shown.html).toContain('aaaaaaa');
    expect(shown.html).toContain('19 Nov 2026, 10:00 UTC');
    expect(shown.html).toContain('record has not finished');
    expect(rowsOf(shown.html)).toEqual([]);
  });

  test('reloads every 30 seconds while it started less than 6 hours ago', () => {
    const shown = page(running, new Date(Date.parse('2026-11-19T10:00:00.000Z') + 6 * HOUR - 1));
    expect(shown.refreshSeconds).toBe(30);
    expect(shown.html).toContain('reloads every 30 seconds');
  });

  test('stops reloading once it started 6 hours ago', () => {
    const shown = page(running, new Date(Date.parse('2026-11-19T10:00:00.000Z') + 6 * HOUR));
    expect(shown.refreshSeconds).toBeUndefined();
    expect(shown.html).not.toContain('reloads every 30 seconds');
  });
});

describe('the other answers', () => {
  test('a run directory with no record is shown as left by a run that did not finish', () => {
    const shown = page({ kind: 'orphan', runId: '2026-11-19T100000Z-aaaaaaaaa-abc123' });
    expect(shown.status).toBe(200);
    expect(shown.html).toContain('a run that did not finish');
  });

  test('a refused record is a 500 with the reason', () => {
    const shown = page({
      kind: 'refused',
      reason: 'run/run.json is not a Hugi run record (version 1).',
    });
    expect(shown.status).toBe(500);
    expect(shown.html).toContain('run/run.json is not a Hugi run record (version 1).');
  });

  test('an unknown run is a 404', () => {
    expect(page({ kind: 'not-found' }).status).toBe(404);
  });
});

test('the stylesheet reaches the page as written, not escaped', () => {
  expect(body(finished())).toContain(RUN_PAGE_STYLE);
});

test('a page loads nothing from elsewhere and runs no script', () => {
  const markup = body(finished());
  expect(markup).not.toContain('<script');
  expect(markup).not.toContain('<link');
  expect(markup).not.toContain('src=');
  expect(markup).toContain('<style>');
});
