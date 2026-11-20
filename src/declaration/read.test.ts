/* Workflow expression delimiters are literal input to the reader. */
/* eslint-disable no-template-curly-in-string */
import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';

import { stringify } from 'yaml';

// The spy needs the module's namespace to count how often a workflow is validated.
// eslint-disable-next-line import/no-namespace
import * as laneMatrix from '../lane/matrix';
// eslint-disable-next-line import/no-namespace
import * as laneParse from '../lane/parse';
import { DECLARATION_PATH, MAX_CAUSE_LENGTH, readDeclaration } from './read';
import type { CommitFiles } from './read';
import { resolveWorkflowPath } from './schema';

function fixture(directory: string, name: string): Promise<string> {
  return Bun.file(join(import.meta.dir, directory, name)).text();
}

const NORN_CI = await fixture('../lane/fixtures', 'norn-ci.yml');
const MIMIR_RELEASE = await fixture('../lane/fixtures', 'mimir-release.yml');
const LOOM_CI = await fixture('../lane/fixtures', 'loom-ci.yml');
const LOOM_HUGI_CI = await fixture('fixtures', 'loom-hugi-ci.yml');
const LOOM_RESTRUCTURED_CI = await fixture('fixtures', 'loom-ci-restructured.yml');

/** A commit made of in-memory files. */
function commit(files: Record<string, string>): CommitFiles {
  return (path) => Promise.resolve(files[path] ?? null);
}

/** A workflow with one job per name, each macOS unless the job says otherwise. */
function workflow(jobs: Record<string, Record<string, unknown>>): string {
  return stringify({
    jobs: Object.fromEntries(
      Object.entries(jobs).map(([id, job]) => [
        id,
        { 'runs-on': 'macos-latest', steps: [{ run: 'true' }], ...job },
      ]),
    ),
    on: 'push',
  });
}

const CI = '.github/workflows/ci.yml';

/** A workflow with one macOS job `a` under the given `on:` block. */
function withOn(on: unknown): string {
  return stringify({ jobs: { a: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] } }, on });
}

/** A workflow whose job `a` has one matrix axis, `v`, holding the one value. */
function oneRow(value: unknown): string {
  return workflow({ a: { strategy: { matrix: { v: [value] } } } });
}

/** A commit whose `job` has one matrix axis, `key`, over the given values. */
function mixed(axis: unknown[], key: string) {
  return { [CI]: workflow({ job: { strategy: { matrix: { [key]: axis } } } }) };
}

async function read(declaration: string, files: Record<string, string> = {}) {
  return readDeclaration(commit({ [DECLARATION_PATH]: declaration, ...files }));
}

async function refusalOf(declaration: string, files: Record<string, string> = {}) {
  const result = await read(declaration, files);
  if (result.kind !== 'refused') {
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  }
  return result.cause;
}

describe('a commit without a declaration', () => {
  test('has no lanes', async () => {
    expect(await readDeclaration(commit({}))).toEqual({ kind: 'none' });
  });
});

describe('the repositories Hugi shadows first', () => {
  test('norn declares one macOS job of ci.yml', async () => {
    const result = await read('lanes:\n  - workflow: ci.yml\n    jobs: [platform]\n', {
      [CI]: NORN_CI,
    });
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [{ job: 'platform', matrix: {}, tools: 'workflow', workflow: CI }],
    });
  });

  test('mimir selects the macOS row of the build matrix, with its complete row', async () => {
    const result = await read(
      'lanes:\n  - workflow: release.yml\n    jobs: [build]\n    matrix: { os: macos-latest }\n',
      { '.github/workflows/release.yml': MIMIR_RELEASE },
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        {
          job: 'build',
          matrix: { asset: 'mimir-darwin-arm64', os: 'macos-latest' },
          tools: 'workflow',
          workflow: '.github/workflows/release.yml',
        },
      ],
    });
  });

  test('mimir without a filter is refused, because its other rows run on Linux', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: release.yml\n    jobs: [build]\n', {
      '.github/workflows/release.yml': MIMIR_RELEASE,
    });
    expect(cause).toMatch(/lanes\[0\] job "build".*ubuntu-latest/);
  });

  test('loom declares the jobs of a Hugi workflow by path', async () => {
    const result = await read(
      'lanes:\n  - workflow: .github/hugi/ci.yml\n    jobs: [node_macos, bun_macos]\n',
      { '.github/hugi/ci.yml': LOOM_HUGI_CI },
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        { job: 'node_macos', matrix: {}, tools: 'workflow', workflow: '.github/hugi/ci.yml' },
        { job: 'bun_macos', matrix: {}, tools: 'workflow', workflow: '.github/hugi/ci.yml' },
      ],
    });
  });

  test('loom after the restructure declares its macOS jobs of ci.yml beside the Linux ones', async () => {
    const result = await read('lanes:\n  - workflow: ci.yml\n    jobs: [node_macos, bun_macos]\n', {
      [CI]: LOOM_RESTRUCTURED_CI,
    });
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        { job: 'node_macos', matrix: {}, tools: 'workflow', workflow: CI },
        { job: 'bun_macos', matrix: {}, tools: 'workflow', workflow: CI },
      ],
    });
  });

  test('a needs-free matrix job selects its macOS row by filter', async () => {
    const result = await read(
      'lanes:\n  - workflow: ci.yml\n    jobs: [node_matrix]\n    matrix: { os: macos-latest }\n',
      { [CI]: LOOM_RESTRUCTURED_CI },
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        { job: 'node_matrix', matrix: { os: 'macos-latest' }, tools: 'workflow', workflow: CI },
      ],
    });
  });

  test("loom's current matrix jobs are refused, because they declare needs", async () => {
    const cause = await refusalOf(
      'lanes:\n  - workflow: ci.yml\n    jobs: [node_matrix]\n    matrix: { os: macos-latest }\n',
      { [CI]: LOOM_CI },
    );
    expect(cause).toMatch(/lanes\[0\] job "node_matrix" in .*ci\.yml.*needs/);
  });
});

describe('matrix filters and lane rows', () => {
  const matrixJob = {
    name: 'test ${{ matrix.os }}',
    'runs-on': '${{ matrix.os }}',
    strategy: {
      matrix: {
        include: [{ extra: 'x', os: 'macos-15', version: 2 }],
        os: ['macos-latest', 'macos-14'],
        version: [1, 2],
      },
    },
  };
  const files = { [CI]: workflow({ test: matrixJob }) };

  test('a filter on a key only an include entry adds selects that row', async () => {
    const includes = [{ extra: 'x', os: 'macos-15' }, { os: 'macos-14' }];
    const result = await read(
      'lanes:\n  - workflow: ci.yml\n    jobs: [test]\n    matrix: { extra: x }\n',
      { [CI]: workflow({ test: { ...matrixJob, strategy: { matrix: { include: includes } } } }) },
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        { job: 'test', matrix: { extra: 'x', os: 'macos-15' }, tools: 'workflow', workflow: CI },
      ],
    });
  });

  test('an entry with no filter selects every row, including include-only keys', async () => {
    const result = await read('lanes:\n  - workflow: ci.yml\n    jobs: [test]\n', files);
    expect(result.kind).toBe('lanes');
    if (result.kind === 'lanes') {
      expect(result.lanes.map((lane) => lane.matrix)).toEqual([
        { os: 'macos-latest', version: 1 },
        { os: 'macos-latest', version: 2 },
        { os: 'macos-14', version: 1 },
        { os: 'macos-14', version: 2 },
        { extra: 'x', os: 'macos-15', version: 2 },
      ]);
    }
  });

  test('a filter keeps the rows it matches and leaves omitted keys free', async () => {
    const result = await read(
      'lanes:\n  - workflow: ci.yml\n    jobs: [test]\n    matrix: { os: macos-14 }\n',
      files,
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        { job: 'test', matrix: { os: 'macos-14', version: 1 }, tools: 'workflow', workflow: CI },
        { job: 'test', matrix: { os: 'macos-14', version: 2 }, tools: 'workflow', workflow: CI },
      ],
    });
  });

  test('a filter value matches as --matrix does: by GitHub equality, numbers by text', async () => {
    const result = await read(
      "lanes:\n  - workflow: ci.yml\n    jobs: [test]\n    matrix: { os: MACOS-14, version: '2' }\n",
      files,
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        { job: 'test', matrix: { os: 'macos-14', version: 2 }, tools: 'workflow', workflow: CI },
      ],
    });
  });

  test('a boolean in the matrix also matches its written text', async () => {
    const result = await read(
      "lanes:\n  - workflow: ci.yml\n    jobs: [flag]\n    matrix: { fast: 'true' }\n",
      { [CI]: workflow({ flag: { strategy: { matrix: { fast: [true, false] } } } }) },
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [{ job: 'flag', matrix: { fast: true }, tools: 'workflow', workflow: CI }],
    });
  });

  test('a filter key in no row is refused, naming the key', async () => {
    expect(
      await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [test]\n    matrix: { arch: arm64 }\n',
        files,
      ),
    ).toMatch(/lanes\[0\] job "test".*matrix key "arch" is in no row/);
  });

  test('a filter that selects no row is refused', async () => {
    expect(
      await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [test]\n    matrix: { os: macos-14, version: 3 }\n',
        files,
      ),
    ).toMatch(/lanes\[0\] job "test".*selects no row/);
  });

  test('a filter on a job with no matrix is refused', async () => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [plain]\n    matrix: { os: x }\n', {
        [CI]: workflow({ plain: {} }),
      }),
    ).toMatch(/job "plain".*no matrix/);
  });

  test('a matrix built by an expression cannot be expanded when the file is read', async () => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [built]\n', {
        [CI]: workflow({ built: { strategy: { matrix: '${{ fromJSON(needs.x.outputs.m) }}' } } }),
      }),
    ).toMatch(/job "built".*matrix cannot be expanded/);
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [built]\n', {
        [CI]: workflow({ built: { strategy: { matrix: { os: '${{ fromJSON(x) }}' } } } }),
      }),
    ).toMatch(/job "built".*matrix cannot be expanded/);
  });

  test('an expression in an axis or include value cannot be expanded when the file is read', async () => {
    const strategy = {
      matrix: { include: [{ extra: '${{ vars.E }}' }], version: ['${{ fromJSON(vars.V) }}'] },
    };
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [built]\n', {
        [CI]: workflow({ built: { strategy } }),
      }),
    ).toMatch(/job "built".*matrix cannot be expanded.*expression/);
  });

  test('a complete row that selects two rows by --matrix is refused', async () => {
    expect(
      await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [job]\n',
        mixed([1, '1'], 'version'),
      ),
    ).toMatch(/job "job".*more than one combination/);
    expect(
      await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [job]\n',
        mixed([true, 'True'], 'v'),
      ),
    ).toMatch(/job "job".*more than one combination/);
  });

  test.each([
    ['a key with an equals sign', 'a=b', /do not select/],
    ['an empty key', '', /a matrix key is empty/],
    ['a reserved name', 'constructor', /matrix key "constructor" is a reserved name/],
  ])('a row the CLI cannot express is refused: %s', async (_name, key, cause) => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [job]\n', {
        [CI]: workflow({
          job: { strategy: { matrix: { include: [{ [key]: 'x' }], os: ['macos-latest'] } } },
        }),
      }),
    ).toMatch(cause);
  });

  test('a lane whose runs-on is not a macOS label is refused, naming the row', async () => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [test]\n', {
        [CI]: workflow({
          test: {
            'runs-on': '${{ matrix.os }}',
            strategy: { matrix: { os: ['macos-latest', 'ubuntu-latest'] } },
          },
        }),
      }),
    ).toMatch(/job "test".*"os":"ubuntu-latest".*unsupported runs-on label: ubuntu-latest/);
  });

  test('a job on a Linux runner is refused', async () => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [lin]\n', {
        [CI]: workflow({ lin: { 'runs-on': 'ubuntu-latest' } }),
      }),
    ).toMatch(/job "lin".*unsupported runs-on label/);
  });
});

describe('workflows and jobs', () => {
  test('a missing workflow file is refused, naming its path', async () => {
    expect(await refusalOf('lanes:\n  - workflow: gone.yml\n    jobs: [a]\n')).toBe(
      'lanes[0]: the workflow file .github/workflows/gone.yml does not exist at the commit',
    );
  });

  test('a workflow the lane reader rejects is refused', async () => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [a]\n', {
        [CI]: 'jobs:\n  a: {runs-on: macos-latest, steps: []}\n',
      }),
    ).toMatch(/lanes\[0\] job "a".*invalid workflow: the workflow has no on: trigger/);
  });

  describe('a workflow whose on: GitHub would refuse is refused', () => {
    const DECLARATION = 'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n';

    test.each([
      ['only negative branches', { push: { branches: ['!main'] } }, /on\.push\.branches needs/],
      [
        'an unknown filter key',
        { pull_request: { branch: ['main'] } },
        /on\.pull_request .*"branch"/,
      ],
      [
        'branches beside branches-ignore',
        { pull_request: null, push: { branches: ['a'], 'branches-ignore': ['b'] } },
        /on\.push cannot have both branches and branches-ignore/,
      ],
      ['an empty on: list', [], /on: a list/],
    ])('%s', async (_name, on, problem) => {
      const cause = await refusalOf(DECLARATION, { [CI]: withOn(on) });
      expect(cause).toMatch(
        /^lanes\[0\] job "a" in \.github\/workflows\/ci\.yml: invalid workflow: /,
      );
      expect(cause).toMatch(problem);
    });

    test('an unparsable pattern is named by position, not quoted', async () => {
      const pattern = 'docs/[secret-z-a]';
      const cause = await refusalOf(DECLARATION, {
        [CI]: withOn({ push: { paths: ['src/**', pattern] } }),
      });
      expect(cause).toMatch(
        /ci\.yml: invalid workflow: on\.push\.paths\[1\] is not a valid pattern/,
      );
      expect(cause).not.toContain(pattern);
    });

    test('an unknown filter key with a line break stays one line', async () => {
      const cause = await refusalOf(DECLARATION, {
        [CI]: withOn({ push: { 'bad\nkey': ['main'] } }),
      });
      expect(cause).not.toContain('\n');
      expect(cause).toMatch(/on\.push has an unknown filter key/);
    });
  });

  test('a missing job is refused', async () => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [nope]\n', {
        [CI]: workflow({ a: {} }),
      }),
    ).toMatch(/lanes\[0\] job "nope".*no job named "nope"/);
  });

  test('a job with needs is refused', async () => {
    expect(
      await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [b]\n', {
        [CI]: workflow({ a: {}, b: { needs: 'a' } }),
      }),
    ).toMatch(/lanes\[0\] job "b".*needs/);
  });
});

describe('lane identity', () => {
  const files = {
    '.github/hugi/ci.yml': workflow({ a: {} }),
    '.github/workflows/ci.yml': workflow({ a: {} }),
  };

  test('the same file named two ways is one entry for identity', async () => {
    expect(
      await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n  - workflow: .github/workflows/ci.yml\n    jobs: [a]\n',
        files,
      ),
    ).toMatch(/two lanes have the identity of job "a" with row \{\}/);
  });

  test('the workflow path is not part of identity', async () => {
    expect(
      await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n  - workflow: .github/hugi/ci.yml\n    jobs: [a]\n',
        files,
      ),
    ).toMatch(/two lanes have the identity of job "a"/);
  });

  test('rows are compared as the filter compares values', async () => {
    const matrixed = workflow({ a: { strategy: { matrix: { n: [1], os: ['macos-latest'] } } } });
    expect(
      await refusalOf(
        "lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: { os: macos-latest }\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: { n: '1' }\n",
        { [CI]: matrixed },
      ),
    ).toMatch(/two lanes have the identity/);
  });

  test('a string row and a boolean row of one job are one identity across workflows', async () => {
    expect(
      await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n  - workflow: .github/hugi/ci.yml\n    jobs: [a]\n',
        { '.github/hugi/ci.yml': oneRow(true), '.github/workflows/ci.yml': oneRow('true') },
      ),
    ).toMatch(/two lanes have the identity of job "a" with row \{"v":true\}/);
  });

  test('include rows of different keys are different lanes', async () => {
    const result = await read('lanes:\n  - workflow: ci.yml\n    jobs: [a]\n', {
      [CI]: workflow({
        a: {
          'runs-on': '${{ matrix.os }}',
          strategy: { matrix: { include: [{ os: 'macos-14' }, { os: 'macos-14', xcode: 15 }] } },
        },
      }),
    });
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [
        { job: 'a', matrix: { os: 'macos-14' }, tools: 'workflow', workflow: CI },
        { job: 'a', matrix: { os: 'macos-14', xcode: 15 }, tools: 'workflow', workflow: CI },
      ],
    });
  });

  test('different rows of one job, and the same job id with another row, are distinct', async () => {
    const result = await read(
      'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: { n: 1 }\n  - workflow: .github/hugi/ci.yml\n    jobs: [a]\n    matrix: { n: 2 }\n',
      {
        '.github/hugi/ci.yml': workflow({ a: { strategy: { matrix: { n: [1, 2] } } } }),
        '.github/workflows/ci.yml': workflow({ a: { strategy: { matrix: { n: [1, 2] } } } }),
      },
    );
    expect(result.kind).toBe('lanes');
  });
});

describe('status names', () => {
  test('two rows of one job whose status names collide refuse the declaration', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [build]\n', {
      [CI]: workflow({
        build: { strategy: { matrix: { include: [{ extra: '2', os: '1' }], os: ['1, 2'] } } },
      }),
    });
    expect(cause).toMatch(
      /two lanes have the status name "hugi \/ build \(1, 2\)": job "build" with row \{"os":"1, 2"\} in \.github\/workflows\/ci\.yml and job "build" with row \{"os":"1","extra":"2"\}/,
    );
  });

  test.each([
    ['a comma', { v: '1, 2' }, { v: '1', w: '2' }],
    ['parentheses', { v: 'x), (y' }, { v: 'x)', w: '(y' }],
  ])(
    'lanes in two workflows whose values hold %s and collide refuse the declaration',
    async (_label, hosted, promoted) => {
      const cause = await refusalOf(
        'lanes:\n  - workflow: ci.yml\n    jobs: [build]\n  - workflow: .github/hugi/ci.yml\n    jobs: [build]\n',
        {
          '.github/hugi/ci.yml': workflow({
            build: { strategy: { matrix: { include: [promoted] } } },
          }),
          [CI]: workflow({ build: { strategy: { matrix: { include: [hosted] } } } }),
        },
      );
      expect(cause).toMatch(/two lanes have the status name "hugi \/ build \(.*\)": job "build"/);
      expect(cause).toContain('and job "build"');
    },
  );

  test('lanes in two workflows whose status names differ only in case refuse the declaration', async () => {
    const cause = await refusalOf(
      'lanes:\n  - workflow: ci.yml\n    jobs: [build]\n  - workflow: .github/hugi/ci.yml\n    jobs: [BUILD]\n',
      {
        '.github/hugi/ci.yml': workflow({ BUILD: {} }),
        [CI]: workflow({ build: {} }),
      },
    );
    expect(cause).toMatch(
      /two lanes have the status names "hugi \/ build" and "hugi \/ BUILD", which Hugi compares as one status name: job "build" with row \{\} in \.github\/workflows\/ci\.yml and job "BUILD"/,
    );
  });

  test('the case collision is found whichever case the first lane uses', async () => {
    const cause = await refusalOf(
      'lanes:\n  - workflow: ci.yml\n    jobs: [BUILD]\n  - workflow: .github/hugi/ci.yml\n    jobs: [build]\n',
      {
        '.github/hugi/ci.yml': workflow({ build: {} }),
        [CI]: workflow({ BUILD: {} }),
      },
    );
    expect(cause).toMatch(
      /two lanes have the status names "hugi \/ BUILD" and "hugi \/ build", which Hugi compares as one status name/,
    );
  });

  test('rows whose values differ only by a final and a medial sigma refuse the declaration', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [build]\n', {
      [CI]: workflow({ build: { strategy: { matrix: { v: ['aσ', 'aΣ'] } } } }),
    });
    expect(cause).toMatch(
      /two lanes have the status names "hugi \/ build \(aσ\)" and "hugi \/ build \(aΣ\)", which Hugi compares as one status name/,
    );
  });

  test('rows whose values differ only by an accent refuse the declaration', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [build]\n', {
      [CI]: workflow({ build: { strategy: { matrix: { v: ['café', 'cafe'] } } } }),
    });
    expect(cause).toMatch(
      /two lanes have the status names "hugi \/ build \(café\)" and "hugi \/ build \(cafe\)", which Hugi compares as one status name/,
    );
  });

  test('a status name with a character outside the BMP refuses the declaration, naming the lane', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [build]\n', {
      [CI]: workflow({ build: { strategy: { matrix: { v: ['ship 🚀'] } } } }),
    });
    expect(cause).toContain('job "build" with row {"v":"ship 🚀"}');
    expect(cause).toContain(
      'GitHub accepts no 4-byte or unpaired surrogate characters in a status name',
    );
  });

  test('a status name holding a lone surrogate is refused, the reason first', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [build]\n', {
      [CI]: workflow({ build: { strategy: { matrix: { v: ['a\uD83Db'] } } } }),
    });
    expect(cause).toMatch(
      /^GitHub accepts no 4-byte or unpaired surrogate characters in a status name/u,
    );
    expect(cause).toContain('job "build"');
  });

  test('the reason comes before a long row, so a cut message still says what to change', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [build]\n', {
      [CI]: workflow({ build: { strategy: { matrix: { v: [`${'x'.repeat(310)} 🚀`] } } } }),
    });
    expect(cause).toMatch(/^GitHub accepts no 4-byte/u);
  });

  test('lanes whose status names differ are accepted', async () => {
    const result = await read('lanes:\n  - workflow: ci.yml\n    jobs: [build]\n', {
      [CI]: workflow({
        build: { strategy: { matrix: { include: [{ extra: '3', os: '1' }], os: ['1, 2'] } } },
      }),
    });
    expect(result.kind).toBe('lanes');
  });
});

describe('the schema', () => {
  const valid = { [CI]: workflow({ a: {} }) };

  test.each(['__proto__', 'constructor', 'prototype'])(
    'a filter key %s is refused as it is for hugi run --matrix',
    async (key) => {
      expect(
        await refusalOf(
          `lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: { ${key}: x }\n`,
          valid,
        ),
      ).toMatch(new RegExp(`lanes\\[0\\] matrix uses the reserved name "${key}"`));
    },
  );

  test.each([
    ['a list instead of a mapping', '- workflow: ci.yml\n', /must be a mapping/],
    ['an empty file', '', /must be a mapping/],
    ['an unknown top-level key', 'lanes: []\nextra: 1\n', /unknown key "extra"/],
    ['no lanes key', '{}\n', /lanes is required/],
    ['lanes of the wrong type', 'lanes: ci.yml\n', /lanes is required and must be a list/],
    ['an empty lanes list', 'lanes: []\n', /lanes must not be empty/],
    ['an entry that is not a mapping', 'lanes: [ci.yml]\n', /lanes\[0\] must be a mapping/],
    [
      'an unknown entry key',
      'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    name: x\n',
      /lanes\[0\] has an unknown key "name"/,
    ],
    ['a missing workflow', 'lanes:\n  - jobs: [a]\n', /lanes\[0\] workflow is required/],
    [
      'a workflow of the wrong type',
      'lanes:\n  - workflow: 1\n    jobs: [a]\n',
      /lanes\[0\] workflow is required and must be a string/,
    ],
    ['missing jobs', 'lanes:\n  - workflow: ci.yml\n', /lanes\[0\] jobs must be a list/],
    [
      'jobs of the wrong type',
      'lanes:\n  - workflow: ci.yml\n    jobs: a\n',
      /jobs must be a list/,
    ],
    [
      'an empty jobs list',
      'lanes:\n  - workflow: ci.yml\n    jobs: []\n',
      /jobs must not be empty/,
    ],
    [
      'a job id that is not a string',
      'lanes:\n  - workflow: ci.yml\n    jobs: [1]\n',
      /jobs must hold only job ids/,
    ],
    [
      'a duplicate job id in an entry',
      'lanes:\n  - workflow: ci.yml\n    jobs: [a, a]\n',
      /lanes\[0\] jobs lists "a" more than once/,
    ],
    [
      'a matrix that is not a mapping',
      'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: [os]\n',
      /lanes\[0\] matrix must be a mapping/,
    ],
    [
      'a matrix value that is not a scalar',
      'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: { os: [x] }\n',
      /lanes\[0\] matrix\.os must be a string, number, or boolean/,
    ],
    [
      'a leading ./',
      'lanes:\n  - workflow: ./.github/workflows/ci.yml\n    jobs: [a]\n',
      /"\." segment/,
    ],
    [
      'a leading /',
      'lanes:\n  - workflow: /.github/workflows/ci.yml\n    jobs: [a]\n',
      /must not start with \//,
    ],
    [
      'a .. segment',
      'lanes:\n  - workflow: .github/workflows/../hugi/ci.yml\n    jobs: [a]\n',
      /"\.\." segment/,
    ],
    [
      'an empty segment',
      'lanes:\n  - workflow: .github//workflows/ci.yml\n    jobs: [a]\n',
      /an empty segment/,
    ],
    [
      'a file in the wrong directory',
      'lanes:\n  - workflow: scripts/ci.yml\n    jobs: [a]\n',
      /directly in \.github\/workflows\/ or \.github\/hugi\//,
    ],
    [
      'a file in a subdirectory of the workflows directory',
      'lanes:\n  - workflow: .github/workflows/sub/ci.yml\n    jobs: [a]\n',
      /directly in/,
    ],
    [
      'a YAML merge key',
      'lanes:\n  - workflow: ci.yml\n    <<: {jobs: [a]}\n',
      /merge keys \(<<\) are not allowed at line 3/,
    ],
    [
      'a duplicate key',
      'lanes:\n  - workflow: ci.yml\n    workflow: ci.yml\n    jobs: [a]\n',
      /unique.* line 3/,
    ],
    ['a YAML directive', '%YAML 1.1\n---\nlanes: []\n', /directives are not allowed at line 1/],
    [
      'an anchor',
      'lanes:\n  - &e {workflow: ci.yml, jobs: [a]}\n',
      /anchors are not allowed \(&e\)/,
    ],
    ['an explicit tag', 'lanes: !!seq []\n', /explicit YAML tags are not allowed/],
  ])('refuses %s', async (_name, declaration, cause) => {
    expect(await refusalOf(declaration, valid)).toMatch(cause);
  });

  test('yes and no are strings, so a filter value of yes is text', async () => {
    const result = await read(
      'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: { opt: yes }\n',
      { [CI]: workflow({ a: { strategy: { matrix: { opt: ['yes', 'no'] } } } }) },
    );
    expect(result).toEqual({
      kind: 'lanes',
      lanes: [{ job: 'a', matrix: { opt: 'yes' }, tools: 'workflow', workflow: CI }],
    });
  });
});

describe('workflow paths', () => {
  test.each([
    ['ci.yml', '.github/workflows/ci.yml'],
    ['.github/workflows/ci.yml', '.github/workflows/ci.yml'],
    ['.github/hugi/ci.yml', '.github/hugi/ci.yml'],
  ])('%s resolves to %s', (name, path) => {
    expect(resolveWorkflowPath(name)).toBe(path);
  });

  test.each(['', '.', '..', 'a/ci.yml', '.github/hugi/', '.github/ci.yml'])(
    'refuses %p',
    (name) => {
      expect(() => resolveWorkflowPath(name)).toThrow();
    },
  );
});

describe('the cost of a declaration', () => {
  test('a workflow is read and validated once, however many jobs and entries use it', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `job${index}`);
    const axis = Array.from({ length: 8 }, (_value, index) => index);
    const text = workflow(
      Object.fromEntries(ids.map((id) => [id, { strategy: { matrix: { n: axis } } }])),
    );
    const declaration =
      `lanes:\n  - workflow: ci.yml\n    jobs: [${ids.slice(0, 15).join(', ')}]\n` +
      `  - workflow: .github/workflows/ci.yml\n    jobs: [${ids.slice(15).join(', ')}]\n`;
    const reads: string[] = [];
    const spy = spyOn(laneParse, 'loadWorkflow');
    const result = await readDeclaration((path) => {
      reads.push(path);
      return Promise.resolve(path === DECLARATION_PATH ? declaration : text);
    });
    expect(result.kind).toBe('lanes');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reads.toSorted()).toEqual([CI, DECLARATION_PATH].toSorted());
    spy.mockRestore();
  });
});

const ONE_JOB = 'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n';

/** The declaration padded with a trailing comment to exactly `bytes` bytes. */
function padded(bytes: number): string {
  return `${ONE_JOB}#${'x'.repeat(bytes - ONE_JOB.length - 1)}`;
}

/** A job whose matrix has one axis of `count` values. */
const axis = (count: number) => ({
  strategy: { matrix: { n: Array.from({ length: count }, (_, index) => index) } },
});

/** A declaration of job `a` (128 rows) and job `b` with `rows` rows, in one workflow. */
function twoJobs(rows: number) {
  return {
    declaration: 'lanes:\n  - workflow: ci.yml\n    jobs: [a, b]\n',
    files: { [CI]: workflow({ a: axis(128), b: axis(rows) }) },
  };
}

/** An entry listing one job of ci.yml. */
const jobEntry = (job: string) => `  - workflow: ci.yml\n    jobs: [${job}]\n`;

/** A workflow of one job, padded with a comment to about 600 KiB. */
const padWorkflow = (job: string) => `${workflow({ [job]: {} })}#${'x'.repeat(600 * 1024)}\n`;

describe('the bounds of a declaration', () => {
  test('accepts a declaration of 64 KiB and refuses one byte more', async () => {
    const files = { [CI]: workflow({ a: {} }) };
    expect((await read(padded(65_536), files)).kind).toBe('lanes');
    expect(await refusalOf(padded(65_537), files)).toMatch(/65537 bytes.*65536 \(64 KiB\)/);
  });

  test('refuses an oversized declaration before parsing it', async () => {
    const reads: string[] = [];
    const result = await readDeclaration((path) => {
      reads.push(path);
      return Promise.resolve('['.repeat(70_000));
    });
    expect(result).toMatchObject({ cause: expect.stringMatching(/64 KiB/), kind: 'refused' });
    expect(reads).toEqual([DECLARATION_PATH]);
  });

  test('accepts 256 lanes in total', async () => {
    const { declaration, files } = twoJobs(128);
    const result = await read(declaration, files);
    expect(result.kind === 'lanes' && result.lanes.length).toBe(256);
  });

  test('refuses the 257th lane, naming the cap', async () => {
    const { declaration, files } = twoJobs(129);
    expect(await refusalOf(declaration, files)).toMatch(/job "b".*more than 256 lanes/);
  });

  test('refuses a repeated entry at the second entry, without expanding the rest', async () => {
    // The entries after the repeat name distinct jobs, so the matrix cache cannot hide a reader
    // that keeps expanding past the first refusal.
    const others = Array.from({ length: 100 }, (_, index) => `j${index}`);
    const declaration = `lanes:\n${['a', 'a', ...others].map(jobEntry).join('')}`;
    const jobs = Object.fromEntries(['a', ...others].map((id) => [id, {}]));
    const spy = spyOn(laneMatrix, 'matrixRows');
    const cause = await refusalOf(declaration, { [CI]: workflow(jobs) });
    expect(cause).toMatch(/two lanes have the identity of job "a"/);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

/** An entry selecting row `n` of job `a`. */
const rowEntry = (n: number) => `  - workflow: ci.yml\n    jobs: [a]\n    matrix: { n: ${n} }\n`;

describe('the cost of a declared job', () => {
  test('a job listed by several entries has its matrix expanded once', async () => {
    const declaration = `lanes:\n${[0, 1, 2, 3].map(rowEntry).join('')}`;
    const spy = spyOn(laneMatrix, 'matrixRows');
    const result = await read(declaration, { [CI]: workflow({ a: axis(4) }) });
    expect(result.kind === 'lanes' && result.lanes.length).toBe(4);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('the workflows a declaration names may total at most 1 MiB, refused at the entry that passes it', async () => {
    const declaration =
      'lanes:\n  - workflow: a.yml\n    jobs: [a]\n  - workflow: b.yml\n    jobs: [b]\n';
    const spy = spyOn(laneParse, 'loadWorkflow');
    const cause = await refusalOf(declaration, {
      '.github/workflows/a.yml': padWorkflow('a'),
      '.github/workflows/b.yml': padWorkflow('b'),
    });
    expect(cause).toMatch(
      /^lanes\[1\] job "b" in .*b\.yml: the declared workflows total \d+ bytes/,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('a declared workflow over 1 MiB is refused before it is parsed', async () => {
    const spy = spyOn(laneParse, 'loadWorkflow');
    const big = `${workflow({ a: {} })}#${'x'.repeat(1024 * 1024)}\n`;
    const cause = await refusalOf(ONE_JOB, { [CI]: big });
    expect(cause).toMatch(
      /lanes\[0\] job "a" in .*: the workflow is \d+ bytes, more than the 1048576 \(1 MiB\)/,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('reading the declared workflows', () => {
  test('stops reading workflows once they pass their total', async () => {
    const declaration =
      'lanes:\n  - workflow: a.yml\n    jobs: [a]\n  - workflow: b.yml\n    jobs: [b]\n' +
      '  - workflow: c.yml\n    jobs: [c]\n';
    const files: Record<string, string> = {
      '.github/workflows/a.yml': padWorkflow('a'),
      '.github/workflows/b.yml': padWorkflow('b'),
      '.github/workflows/c.yml': padWorkflow('c'),
      [DECLARATION_PATH]: declaration,
    };
    const reads: string[] = [];
    const result = await readDeclaration((path) => {
      reads.push(path);
      return Promise.resolve(files[path] ?? null);
    });
    expect(result.kind).toBe('refused');
    expect(reads).toEqual([DECLARATION_PATH, '.github/workflows/a.yml', '.github/workflows/b.yml']);
  });
});

describe('a refusal cause is one line that quotes no repository text', () => {
  const DECLARATION = 'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n';

  test('a workflow YAML syntax error keeps its line and column only', async () => {
    const cause = await refusalOf(DECLARATION, { [CI]: 'on: push\nx: [\n' });
    expect(cause).toMatch(/^lanes\[0\] job "a" in .*ci\.yml: .* at line 3, column 1$/);
    expect(cause).not.toContain('\n');
    expect(cause).not.toContain('x: [');
  });

  test('a cause that carries repository text on its first line is cut short', async () => {
    const alias = 'Z'.repeat(50_000);
    const cause = await refusalOf(DECLARATION, { [CI]: `on: push\nx: *${alias}\n` });
    expect(cause.length).toBeLessThanOrEqual(MAX_CAUSE_LENGTH);
    expect(cause.endsWith('…')).toBe(true);
  });

  test.each([
    ['a missing workflow', `lanes:\n  - workflow: ${'w'.repeat(5000)}.yml\n    jobs: [a]\n`, {}],
    [
      'a filter key in no row',
      `lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    matrix: { ${'k'.repeat(5000)}: x }\n`,
      { [CI]: oneRow('x') },
    ],
  ])('every refusal cause is bounded: %s', async (_name, declaration, files) => {
    const cause = await refusalOf(declaration, files);
    expect(cause.length).toBeLessThanOrEqual(MAX_CAUSE_LENGTH);
  });

  test('a line break in a name the declaration gives stays out of the cause', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: "a\\nb.yml"\n    jobs: [a]\n');
    expect(cause).toMatch(/does not exist|no workflow|missing/i);
    expect(cause).not.toMatch(/[\r\n\u2028\u2029]/u);
  });

  test('a cause is cut between characters, never inside one', async () => {
    const name = `${'w'.repeat(240)}${'😀'.repeat(100)}`;
    const cause = await refusalOf(`lanes:\n  - workflow: ${name}.yml\n    jobs: [a]\n`);
    expect(cause.endsWith('…')).toBe(true);
    expect(cause.isWellFormed()).toBe(true);
  });

  test('deep nesting keeps no source excerpt', async () => {
    const deep = '['.repeat(60_000) + ']'.repeat(60_000);
    const cause = await refusalOf(DECLARATION, { [CI]: deep });
    expect(cause).toMatch(/Maximum call stack size exceeded\. at line 1, column \d+$/);
    expect(cause).not.toContain('\n');
    expect(cause).not.toContain('[[[');
  });
});

describe('a matrix key the declaration reads from a workflow', () => {
  test('a reserved name is worded for the declaration, not for a --matrix flag', async () => {
    const cause = await refusalOf('lanes:\n  - workflow: ci.yml\n    jobs: [a]\n', {
      [CI]: workflow({ a: { strategy: { matrix: { constructor: ['x'] } } } }),
    });
    expect(cause).toContain('matrix key "constructor" is a reserved name');
    expect(cause).not.toContain('--matrix');
  });
});

describe('where a lane takes its tools from (ADR-0006)', () => {
  const files = { [CI]: workflow({ a: {}, b: {} }) };

  test('is workflow when the entry says nothing', async () => {
    const result = await read('lanes:\n  - workflow: ci.yml\n    jobs: [a]\n', files);
    expect(result.kind === 'lanes' && result.lanes.map((lane) => lane.tools)).toEqual(['workflow']);
  });

  test('is carried per entry, and neither value changes a status name', async () => {
    const result = await read(
      'lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    tools: workflow\n  - workflow: ci.yml\n    jobs: [b]\n    tools: mise\n',
      files,
    );
    expect(result.kind === 'lanes' && result.lanes.map((lane) => [lane.job, lane.tools])).toEqual([
      ['a', 'workflow'],
      ['b', 'mise'],
    ]);
  });

  test.each(['"npm"', '"Mise"', 'true', '1', '[mise]', 'null', '{ mise: true }'])(
    'refuses the value %s as a schema error',
    async (value) => {
      const cause = await refusalOf(
        `lanes:\n  - workflow: ci.yml\n    jobs: [a]\n    tools: ${value}\n`,
        files,
      );
      expect(cause).toMatch(/lanes\[0\].*tools must be "workflow" or "mise"/);
    },
  );
});
