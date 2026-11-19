import { describe, expect, test } from 'bun:test';

import { TriggerError, workflowStarts } from './index';
import type { TriggerEvent } from './index';

type Counted = { event: TriggerEvent; calls: () => number };

function push(branch: string, files: string[] = []): Counted {
  let calls = 0;
  return {
    calls: () => calls,
    event: {
      branch,
      changedFiles: async () => {
        calls += 1;
        return files;
      },
      kind: 'push',
    },
  };
}

function pull(baseRef: string, files: string[] = []): Counted {
  let calls = 0;
  return {
    calls: () => calls,
    event: {
      baseRef,
      changedFiles: async () => {
        calls += 1;
        return files;
      },
      kind: 'pull_request',
    },
  };
}

describe('on: forms', () => {
  const cases: [string, unknown, boolean, boolean][] = [
    ['string push', 'push', true, false],
    ['string pull_request', 'pull_request', false, true],
    ['string other', 'schedule', false, false],
    ['list both', ['push', 'pull_request'], true, true],
    ['list one', ['pull_request'], false, true],
    ['list other', ['workflow_dispatch'], false, false],
    ['mapping null values', { pull_request: null, push: null }, true, true],
    ['mapping empty values', { pull_request: {}, push: {} }, true, true],
    ['mapping unrelated', { release: { types: ['published'] } }, false, false],
    ['mapping one', { push: null }, true, false],
  ];
  test.each(cases)('%s', async (_, on, pushes, pulls) => {
    expect(await workflowStarts(on, push('main').event)).toBe(pushes);
    expect(await workflowStarts(on, pull('main').event)).toBe(pulls);
  });
});

describe('push filters', () => {
  const cases: [string, Record<string, unknown>, string, string[], boolean][] = [
    ['branches match', { branches: ['main'] }, 'main', [], true],
    ['branches miss', { branches: ['main'] }, 'dev', [], false],
    ['branches glob', { branches: ['release/**'] }, 'release/1/x', [], true],
    ['branches negation', { branches: ['**', '!wip/**'] }, 'wip/a', [], false],
    ['branches string value', { branches: 'main' }, 'main', [], true],
    ['branches-ignore hit', { 'branches-ignore': ['main'] }, 'main', [], false],
    ['branches-ignore miss', { 'branches-ignore': ['dev'] }, 'main', [], true],
    ['tags only', { tags: ['v*'] }, 'main', [], false],
    ['tags-ignore only', { 'tags-ignore': ['v*'] }, 'main', [], false],
    ['tags and branches', { branches: ['main'], tags: ['v*'] }, 'main', [], true],
    ['paths hit', { paths: ['src/**'] }, 'main', ['src/a.ts'], true],
    ['paths miss', { paths: ['src/**'] }, 'main', ['docs/a.md'], false],
    ['paths any file hits', { paths: ['src/**'] }, 'main', ['docs/a.md', 'src/b.ts'], true],
    ['paths negation', { paths: ['**', '!docs/**'] }, 'main', ['docs/a.md'], false],
    ['paths-ignore all ignored', { 'paths-ignore': ['docs/**'] }, 'main', ['docs/a.md'], false],
    ['paths-ignore some left', { 'paths-ignore': ['docs/**'] }, 'main', ['docs/a', 'src/b'], true],
    ['paths-ignore no files', { 'paths-ignore': ['docs/**'] }, 'main', [], false],
    ['branch ok, paths miss', { branches: ['main'], paths: ['src/**'] }, 'main', ['x'], false],
    ['branch miss, paths ok', { branches: ['main'], paths: ['src/**'] }, 'dev', ['src/a'], false],
    ['both ok', { branches: ['main'], paths: ['src/**'] }, 'main', ['src/a'], true],
  ];
  test.each(cases)('%s', async (_, filters, branch, files, expected) => {
    expect(await workflowStarts({ push: filters }, push(branch, files).event)).toBe(expected);
  });
});

describe('pull_request filters', () => {
  const cases: [string, Record<string, unknown>, string, string[], boolean][] = [
    ['branches match base', { branches: ['main'] }, 'main', [], true],
    ['branches miss base', { branches: ['main'] }, 'dev', [], false],
    ['branches-ignore hit', { 'branches-ignore': ['main'] }, 'main', [], false],
    ['branches-ignore miss', { 'branches-ignore': ['main'] }, 'dev', [], true],
    ['paths hit', { paths: ['src/**'] }, 'main', ['src/a'], true],
    ['paths miss', { paths: ['src/**'] }, 'main', ['docs/a'], false],
    ['paths-ignore hit', { 'paths-ignore': ['docs/**'] }, 'main', ['docs/a'], false],
    ['paths-ignore miss', { 'paths-ignore': ['docs/**'] }, 'main', ['src/a'], true],
    ['both filters pass', { branches: ['main'], paths: ['src/**'] }, 'main', ['src/a'], true],
    ['branch fails', { branches: ['main'], paths: ['src/**'] }, 'dev', ['src/a'], false],
    ['no types', {}, 'main', [], true],
    ['types opened', { types: ['opened'] }, 'main', [], true],
    ['types synchronize', { types: ['synchronize'] }, 'main', [], true],
    ['types reopened', { types: ['reopened'] }, 'main', [], true],
    ['types string', { types: 'opened' }, 'main', [], true],
    ['types mixed', { types: ['labeled', 'opened'] }, 'main', [], true],
    ['types only labeled', { types: ['labeled'] }, 'main', [], false],
    ['types only ready_for_review', { types: ['ready_for_review'] }, 'main', [], false],
    ['types only closed', { types: ['closed'] }, 'main', [], false],
    ['types empty', { types: [] }, 'main', [], false],
  ];
  test.each(cases)('%s', async (_, filters, base, files, expected) => {
    const on = { pull_request: filters };
    expect(await workflowStarts(on, pull(base, files).event)).toBe(expected);
  });
});

describe('changedFiles', () => {
  test('is not called without a path filter', async () => {
    const p = push('main');
    await workflowStarts({ push: { branches: ['main'] } }, p.event);
    const r = pull('main');
    await workflowStarts({ pull_request: { types: ['opened'] } }, r.event);
    expect(p.calls() + r.calls()).toBe(0);
  });

  test('is not called when the workflow ignores the event', async () => {
    const p = push('main');
    await workflowStarts({ pull_request: { paths: ['a'] } }, p.event);
    expect(p.calls()).toBe(0);
  });

  test('is called once with paths and once with paths-ignore', async () => {
    const a = push('main', ['a']);
    await workflowStarts({ push: { paths: ['a'] } }, a.event);
    const b = pull('main', ['a']);
    await workflowStarts({ pull_request: { 'paths-ignore': ['b'] } }, b.event);
    expect([a.calls(), b.calls()]).toEqual([1, 1]);
  });

  test('is not called once the branch filter has failed', async () => {
    const p = push('dev', ['a']);
    expect(await workflowStarts({ push: { branches: ['main'], paths: ['a'] } }, p.event)).toBe(
      false,
    );
    expect(p.calls()).toBe(0);
  });
});

describe('TriggerError', () => {
  const cases: [string, unknown, RegExp][] = [
    [
      'branches with branches-ignore',
      { push: { branches: ['a'], 'branches-ignore': ['b'] } },
      /push.*branches.*branches-ignore/,
    ],
    [
      'paths with paths-ignore',
      { push: { paths: ['a'], 'paths-ignore': ['b'] } },
      /push.*paths.*paths-ignore/,
    ],
    [
      'pull_request both branch keys',
      { pull_request: { branches: ['a'], 'branches-ignore': ['b'] } },
      /pull_request.*branches.*branches-ignore/,
    ],
    [
      'pull_request both path keys',
      { pull_request: { paths: ['a'], 'paths-ignore': ['b'] } },
      /pull_request.*paths.*paths-ignore/,
    ],
    [
      'push tags with tags-ignore',
      { push: { tags: ['a'], 'tags-ignore': ['b'] } },
      /push.*tags.*tags-ignore/,
    ],
    ['branches wrong type', { push: { branches: 3 } }, /push.*branches/],
    ['branches non-string item', { push: { branches: [1] } }, /push.*branches/],
    ['paths wrong type', { pull_request: { paths: { a: 1 } } }, /pull_request.*paths/],
    ['types wrong type', { pull_request: { types: 4 } }, /pull_request.*types/],
    ['only negative branches', { push: { branches: ['!main'] } }, /push.*branches/],
    ['event value wrong type', { push: 'main' }, /push/],
    ['on wrong type', 5, /on:/],
    ['list item wrong type', ['push', 3], /on:/],
  ];
  test.each(cases)('%s', async (_, on, message) => {
    const event = JSON.stringify(on).includes('pull_request') ? pull('main') : push('main');
    const error = await workflowStarts(on, event.event).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TriggerError);
    expect(error instanceof Error ? error.message : '').toMatch(message);
  });

  test('a conflict under another event is not an error', async () => {
    const on = { pull_request: null, push: { branches: ['a'], 'branches-ignore': ['b'] } };
    expect(await workflowStarts(on, pull('main').event)).toBe(true);
  });
});
