/* Workflow expression delimiters are literal input to the reader. */
/* eslint-disable no-template-curly-in-string */
import { describe, expect, test } from 'bun:test';

import { stringify } from 'yaml';

import { LaneReadError, readLane } from './reader';
import type { EventContext, LaneRef } from './step-plan';

const lane: LaneRef = { job: 'build', matrix: {}, workflow: '.github/workflows/ci.yml' };
const event: EventContext = {
  event: 'push',
  refName: 'main',
  refType: 'branch',
  repository: 'example/project',
  sha: 'abc123',
};
const paths = { temp: '/tmp/runner', workspace: '/work' };

function read(text: string, selected: LaneRef = lane) {
  return readLane(text, selected, event, paths);
}

function workflow(job: Record<string, unknown>, top: Record<string, unknown> = {}) {
  return stringify({ ...top, jobs: { build: { 'runs-on': 'macos-latest', steps: [], ...job } } });
}

test('a missing job fails with a typed lane read error naming the job', () => {
  expect(() => read('jobs: {}')).toThrow(LaneReadError);
  expect(() => read('jobs: {}')).toThrow(/job "build".*missing/);
});

test('a lane must resolve to a macOS runner label', () => {
  expect(() => read('jobs: {build: {runs-on: ubuntu-latest, steps: []}}')).toThrow(
    /job "build".*runs-on.*ubuntu-latest/,
  );
});

test('matrix values must select a complete combination after include and exclude', () => {
  const text = workflow({
    strategy: {
      matrix: {
        exclude: [{ node: 20, os: 'macos-latest' }],
        include: [
          { flavor: 'native', node: 22, os: 'macos-latest' },
          { node: 24, os: 'macos-15' },
        ],
        node: [20, 22],
        os: ['macos-latest', 'ubuntu-latest'],
      },
    },
  });
  const invalid: LaneRef['matrix'][] = [
    { node: '20', os: 'macos-latest' },
    { os: 'macos-latest' },
    { node: '22', os: 'macos-99' },
  ];
  for (const matrix of invalid) {
    expect(() => read(text, { ...lane, matrix })).toThrow(/matrix/);
  }
  expect(
    read(text, { ...lane, matrix: { flavor: 'native', node: '22', os: 'macos-latest' } }).steps,
  ).toEqual([]);
  expect(read(text, { ...lane, matrix: { node: '24', os: 'macos-15' } }).steps).toEqual([]);
  expect(() => read(workflow({}), { ...lane, matrix: { os: 'macos-latest' } })).toThrow(/matrix/);
});

test('run steps preserve their script and original position in the step plan', () => {
  expect(
    read(
      workflow({
        steps: [{ name: 'Verify', run: 'echo "$HOME"\nprintf done\n' }, { run: 'true' }],
      }),
    ),
  ).toEqual({
    env: {},
    lane,
    name: 'build',
    steps: [
      {
        continueOnError: false,
        env: {},
        index: 1,
        kind: 'run',
        name: 'Verify',
        script: 'echo "$HOME"\nprintf done\n',
        shell: 'default',
        when: 'success',
      },
      {
        continueOnError: false,
        env: {},
        index: 2,
        kind: 'run',
        name: 'step 2',
        script: 'true',
        shell: 'default',
        when: 'success',
      },
    ],
    timeoutMinutes: 360,
  });
});

test('secrets in a run fail the whole read and name the job, step, and expression', () => {
  const text = workflow({
    steps: [{ run: 'true' }, { name: 'Publish', run: 'echo ${{ secrets.X }}' }],
  });
  expect(() => read(text)).toThrow(LaneReadError);
  expect(() => read(text)).toThrow(/job "build".*step 2 "Publish".*secrets.X/);
});

test.each(['steps.build.outputs.path', 'github.actor', "format('{0}', matrix.os)"])(
  'an unsupported expression %s fails with the expression and step',
  (expression) => {
    expect(() =>
      read(workflow({ steps: [{ name: 'Verify', run: `echo \${{ ${expression} }}` }] })),
    ).toThrow(/job "build".*step 1 "Verify".*unsupported expression/);
  },
);

test('known event, runner, and matrix contexts expand in runs, names, and runner labels', () => {
  const text = workflow({
    name: '${{ matrix.os }} / ${{ github.repository }}',
    'runs-on': '${{ matrix.os }}',
    steps: [
      {
        run: '${{ github.workspace }} ${{ github.sha }} ${{ github.ref_name }} ${{ github.ref_type }} ${{ github.event_name }} ${{ github.repository }} ${{ runner.os }} ${{ runner.arch }} ${{ runner.temp }} ${{ matrix.os }}',
      },
    ],
    strategy: { matrix: { os: ['macos-latest'] } },
  });
  const plan = read(text, { ...lane, matrix: { os: 'macos-latest' } });
  expect(plan.name).toBe('macos-latest / example/project');
  expect(plan.steps[0]).toMatchObject({
    script: '/work abc123 main branch push example/project macOS ARM64 /tmp/runner macos-latest',
  });
});

test('workflow, job, and step environments layer with run defaults and limits', () => {
  const text = workflow(
    {
      defaults: { run: { shell: 'sh' } },
      env: { COUNT: 12, LIMIT: 25, ROOT: '${{ github.workspace }}/job' },
      steps: [
        {
          'continue-on-error': true,
          env: { ROOT: '${{ github.workspace }}/step' },
          name: 'Inherited',
          run: 'echo "$ROOT" "$BASE" "$COUNT"',
          'timeout-minutes': 25,
        },
        {
          'continue-on-error': false,
          run: 'pwd',
          shell: 'bash',
          'working-directory': '${{ github.workspace }}/subdir',
        },
      ],
      'timeout-minutes': 25,
    },
    {
      defaults: { run: { shell: 'bash', 'working-directory': '${{ github.workspace }}/default' } },
      env: { BASE: '${{ github.workspace }}', ROOT: 'workflow' },
    },
  );
  const plan = read(text);
  expect(plan.env).toEqual({ BASE: '/work', COUNT: '12', LIMIT: '25', ROOT: '/work/job' });
  expect(plan.timeoutMinutes).toBe(25);
  expect(plan.steps).toEqual([
    {
      continueOnError: true,
      env: { ROOT: '/work/step' },
      index: 1,
      kind: 'run',
      name: 'Inherited',
      script: 'echo "$ROOT" "$BASE" "$COUNT"',
      shell: 'sh',
      timeoutMinutes: 25,
      when: 'success',
      workingDirectory: 'default',
    },
    {
      continueOnError: false,
      env: {},
      index: 2,
      kind: 'run',
      name: 'step 2',
      script: 'pwd',
      shell: 'bash',
      when: 'success',
      workingDirectory: 'subdir',
    },
  ]);
});

test('an unsupported shell names the step and shell', () => {
  expect(() =>
    read(workflow({ steps: [{ name: 'PowerShell', run: 'true', shell: 'pwsh' }] })),
  ).toThrow(/step 1 "PowerShell".*shell.*pwsh/);
});

test.each([
  'docker://alpine:3',
  './local-action',
  'actions/checkout',
  'owner/repo@',
  'owner//repo@v1',
])('an unsupported action reference %s fails with the step', (uses) => {
  expect(() => read(workflow({ steps: [{ name: 'Setup', uses }] }))).toThrow(
    /step 1 "Setup".*unsupported action reference/,
  );
});

test('remote actions retain their reference and expanded with values without a supported-actions list', () => {
  const plan = read(
    workflow({
      steps: [
        {
          env: { TEMP: '${{ runner.temp }}' },
          uses: 'unknown-owner/any-action/subpath@release/v1',
          with: { count: 2, enabled: false, workspace: '${{ github.workspace }}' },
        },
      ],
    }),
  );
  expect(plan.steps).toEqual([
    {
      continueOnError: false,
      env: { TEMP: '/tmp/runner' },
      index: 1,
      kind: 'action',
      name: 'unknown-owner/any-action/subpath@release/v1',
      uses: 'unknown-owner/any-action/subpath@release/v1',
      when: 'success',
      with: { count: '2', enabled: 'false', workspace: '/work' },
    },
  ]);
});

test('a job whose condition is false does not produce a step plan', () => {
  expect(() => read(workflow({ if: "github.event_name == 'pull_request'" }))).toThrow(
    /job "build".*job does not run for this event/,
  );
});

test.each([
  "contains(github.ref_name, 'main')",
  'steps.tests.outputs.ok',
  'runner.os === "macOS"',
  'cancelled()',
])('an unsupported condition %s fails naming the step and condition', (condition) => {
  expect(() =>
    read(workflow({ steps: [{ if: condition, name: 'Conditional', run: 'true' }] })),
  ).toThrow(/step 1 "Conditional".*unsupported condition/);
});

test('read-time conditions drop steps while status conditions reduce to StepWhen', () => {
  const conditions = [
    undefined,
    'success()',
    'always()',
    'failure()',
    '!cancelled()',
    "runner.os == 'Linux'",
    "${{ runner.os == 'macOS' && (github.event_name == 'push' || matrix.os == 'ignored') }}",
    "success() && github.ref_name == 'main'",
    "failure() || runner.os == 'macOS'",
    "failure() && github.event_name == 'pull_request'",
    "!startsWith(github.ref, 'refs/tags/') && runner.arch != 'X64'",
    "always() && runner.os == 'Linux'",
  ];
  const text = workflow({
    steps: conditions.map((condition, index) => ({
      if: condition,
      name: `condition ${index + 1}`,
      run: 'true',
    })),
    strategy: { matrix: { os: ['macos-latest'] } },
  });
  expect(
    read(text, { ...lane, matrix: { os: 'macos-latest' } }).steps.map(({ index, when }) => [
      index,
      when,
    ]),
  ).toEqual([
    [1, 'success'],
    [2, 'success'],
    [3, 'always'],
    [4, 'failure'],
    [5, 'always'],
    [7, 'success'],
    [8, 'success'],
    [9, 'always'],
    [11, 'success'],
  ]);
});

test('caller-supplied upstream outputs and results resolve without running upstream jobs', () => {
  const text = workflow({
    if: "needs.changes.outputs.code == 'true'",
    needs: ['changes'],
    steps: [{ run: 'echo ${{ needs.changes.outputs.code }} ${{ needs.changes.result }}' }],
  });
  const supplied = {
    ...event,
    needs: { changes: { outputs: { code: 'true' }, result: 'success' as const } },
  };
  expect(readLane(text, lane, supplied, paths).steps[0]).toMatchObject({
    script: 'echo true success',
  });
  expect(() => read(text)).toThrow(/missing upstream value needs.changes.outputs.code/);
  expect(() =>
    readLane(text, lane, { ...event, needs: { changes: { outputs: { code: 'false' } } } }, paths),
  ).toThrow(/job does not run for this event/);
  expect(
    readLane(text, lane, { ...event, needs: { changes: { outputs: { code: 'true' } } } }, paths)
      .steps[0],
  ).toMatchObject({ script: 'echo true success' });
});

test('malformed YAML and malformed steps fail atomically with lane diagnostics', () => {
  expect(() => read('jobs: [')).toThrow(LaneReadError);
  expect(() => read('jobs: {build: {runs-on: macos-latest, runs-on: ubuntu-latest}}')).toThrow(
    /job "build"/,
  );
  expect(() =>
    read(workflow({ steps: [{ name: 'Ambiguous', run: 'true', uses: 'actions/checkout@v7' }] })),
  ).toThrow(/step 1 "Ambiguous".*exactly one of run or uses/);
  expect(() => read(workflow({ steps: [{ name: 'Empty' }] }))).toThrow(
    /step 1 "Empty".*exactly one of run or uses/,
  );
});

test('malformed expression delimiters cannot escape into the step plan', () => {
  expect(() =>
    read(workflow({ steps: [{ name: 'Broken expression', run: 'echo ${{ github.sha' }] })),
  ).toThrow(/step 1 "Broken expression".*expression.*github.sha/);
});

test('runner label arrays resolve their matrix expressions', () => {
  expect(
    read(
      workflow({
        'runs-on': ['${{ matrix.os }}'],
        strategy: { matrix: { os: ['macos-15'] } },
      }),
      { ...lane, matrix: { os: 'macos-15' } },
    ).steps,
  ).toEqual([]);
});

test('missing environment values and secrets in action inputs fail with their step', () => {
  expect(() =>
    read(workflow({ steps: [{ name: 'Unknown env', run: 'echo ${{ env.FROM_PREVIOUS_STEP }}' }] })),
  ).toThrow(/step 1 "Unknown env".*env.FROM_PREVIOUS_STEP/);
  expect(() =>
    read(
      workflow({
        steps: [
          {
            name: 'Secret input',
            uses: 'actions/checkout@v7',
            with: { token: '${{ secrets.X }}' },
          },
        ],
      }),
    ),
  ).toThrow(/step 1 "Secret input".*secrets.X/);
});

test('a runtime guard that cannot reduce to StepWhen fails with the condition', () => {
  expect(() =>
    read(
      workflow({
        steps: [{ if: 'failure() || cancelled()', name: 'Only cancelled', run: 'true' }],
      }),
    ),
  ).toThrow(/step 1 "Only cancelled".*failure\(\) \|\| cancelled\(\).*cannot reduce/);
});

test('tag conditions, YAML booleans, and escaped single quotes decide at read time', () => {
  const text = workflow({
    if: "startsWith(github.ref, 'refs/tags/')",
    steps: [
      { if: true, run: 'echo tag' },
      { if: false, run: 'false' },
      { if: "'it''s' == 'IT''S'", run: 'echo quoted' },
    ],
  });
  expect(
    readLane(text, lane, { ...event, refName: 'v1', refType: 'tag' }, paths).steps.map(
      ({ index }) => index,
    ),
  ).toEqual([1, 3]);
});

test.each([0, -1, 'never', true, 1.5])(
  'invalid timeout-minutes %s fails with its step',
  (value) => {
    expect(() =>
      read(
        workflow({ steps: [{ name: 'Invalid timeout', run: 'true', 'timeout-minutes': value }] }),
      ),
    ).toThrow(/step 1 "Invalid timeout".*timeout-minutes/);
  },
);

test('step names expand for both the step plan and failure diagnostics', () => {
  expect(
    read(workflow({ steps: [{ name: 'Verify ${{ runner.os }}', run: 'true' }] })).steps[0]?.name,
  ).toBe('Verify macOS');
  expect(() =>
    read(workflow({ steps: [{ name: 'Verify ${{ runner.os }}', run: '${{ secrets.X }}' }] })),
  ).toThrow(/step 1 "Verify macOS".*secrets.X/);
});

test.each(['owner/repo/..@v1', 'owner/repo/.@v1', 'owner/repo@${{github.sha}}'])(
  'a malformed action reference %s cannot become an action step',
  (uses) => {
    expect(() => read(workflow({ steps: [{ uses }] }))).toThrow(/unsupported action reference/);
  },
);

test('matrix includes replace previous additions and do not merge added combinations', () => {
  const text = workflow({
    strategy: {
      matrix: {
        animal: ['cat', 'dog'],
        fruit: ['apple', 'pear'],
        include: [
          { color: 'green' },
          { animal: 'cat', color: 'pink' },
          { fruit: 'apple', shape: 'circle' },
          { fruit: 'banana' },
          { animal: 'cat', fruit: 'banana' },
        ],
      },
    },
  });
  expect(
    read(text, {
      ...lane,
      matrix: { animal: 'cat', color: 'pink', fruit: 'apple', shape: 'circle' },
    }).steps,
  ).toEqual([]);
  expect(
    read(text, { ...lane, matrix: { animal: 'dog', color: 'green', fruit: 'pear' } }).steps,
  ).toEqual([]);
  expect(read(text, { ...lane, matrix: { fruit: 'banana' } }).steps).toEqual([]);
  expect(read(text, { ...lane, matrix: { animal: 'cat', fruit: 'banana' } }).steps).toEqual([]);
  expect(() =>
    read(text, { ...lane, matrix: { animal: 'cat', color: 'pink', fruit: 'banana' } }),
  ).toThrow(/matrix/);
});

function pullRequest(text: string) {
  return readLane(text, lane, { ...event, event: 'pull_request' }, paths);
}

test('matrix values keep their YAML type in conditions and expansions', () => {
  const text = workflow({
    steps: [
      {
        if: '!matrix.skip',
        name: 'Not skipped',
        run: 'echo ${{ matrix.shard }} ${{ matrix.flag }}',
      },
      { if: 'matrix.flag == true', name: 'Flagged', run: 'true' },
      { if: 'matrix.shard', name: 'Nonzero shard', run: 'true' },
    ],
    strategy: { matrix: { flag: [true], shard: [0, 1], skip: [false] } },
  });
  const plan = read(text, { ...lane, matrix: { flag: true, shard: 0, skip: false } });
  expect(plan.steps.map(({ name }) => name)).toEqual(['Not skipped', 'Flagged']);
  expect(plan.steps[0]).toMatchObject({ script: 'echo 0 true' });
});

test('matrix values select a combination by GitHub equality and keep the workflow type', () => {
  const text = workflow({
    steps: [{ if: 'matrix.shard', name: 'Nonzero shard', run: 'true' }],
    strategy: { matrix: { os: ['macos-latest'], shard: [0, 1] } },
  });
  expect(read(text, { ...lane, matrix: { os: 'macos-latest', shard: '0' } }).steps).toEqual([]);
  expect(() => read(text, { ...lane, matrix: { os: 'macos-latest', shard: 'zero' } })).toThrow(
    /matrix values do not select a combination/,
  );
});

test.each([
  ['if', { if: "env.FLAG == 'on'", run: 'true' }],
  ['run', { run: 'echo ${{ env.FLAG }}' }],
  ['with', { uses: 'actions/checkout@v7', with: { ref: '${{ env.FLAG }}' } }],
  ['working-directory', { run: 'true', 'working-directory': '${{ env.FLAG }}' }],
  ['env', { env: { COPY: '${{ env.FLAG }}' }, run: 'true' }],
  ['name', { name: 'Step ${{ env.FLAG }}', run: 'true' }],
  ['timeout-minutes', { run: 'true', 'timeout-minutes': '${{ env.FLAG }}' }],
])(
  'a step %s that reads env fails, because earlier steps can change env through GITHUB_ENV',
  (_field, step) => {
    const text = workflow({ env: { FLAG: 'on' }, steps: [step] });
    expect(() => read(text)).toThrow(/job "build".*step 1.*env\.FLAG.*GITHUB_ENV/);
  },
);

test('job env may read github but not the workflow env, as GitHub allows', () => {
  const ok = workflow({ env: { JOB: '${{ github.workspace }}/job' } }, { env: { TOP: 'top' } });
  expect(read(ok).env).toEqual({ JOB: '/work/job', TOP: 'top' });
  const bad = workflow({ env: { JOB: '${{ env.TOP }}/job' } }, { env: { TOP: 'top' } });
  expect(() => read(bad)).toThrow(/env context in job env/);
});

test.each([[['macos-14', 'macos-15']], [['macos-latest', 'macos-latest-xlarge']]])(
  'runs-on %j names two hosted images, which no runner carries, and fails',
  (labels) => {
    expect(() => read(workflow({ 'runs-on': labels }))).toThrow(/exactly one/);
  },
);

test('runs-on labels match case-insensitively, as GitHub labels do', () => {
  expect(read(workflow({ 'runs-on': 'macOS-latest' })).steps).toBeDefined();
});

test.each(['github.ref', 'github.ref_name'])(
  'a pull_request lane that reads %s fails, because the contract lacks the PR number',
  (expression) => {
    const text = workflow({ steps: [{ name: 'Ref', run: `echo \${{ ${expression} }}` }] });
    expect(() => pullRequest(text)).toThrow(
      new RegExp(`step 1 "Ref".*${expression.replace('.', String.raw`\.`)}.*pull_request`, 'u'),
    );
  },
);

test('a pull_request lane still reads the event name and sha', () => {
  const text = workflow({ steps: [{ run: 'echo ${{ github.event_name }} ${{ github.sha }}' }] });
  expect(pullRequest(text).steps[0]).toMatchObject({ script: 'echo pull_request abc123' });
});

test.each([
  'macos-latest',
  'macos-14',
  'macos-15',
  'macos-26',
  'macos-latest-xlarge',
  'macos-14-xlarge',
  'macos-15-xlarge',
  'macos-26-xlarge',
])('the Apple-silicon runner label %s is accepted', (label) => {
  expect(read(workflow({ 'runs-on': label })).steps).toEqual([]);
});

test.each([
  'macos-13',
  'macos-15-large',
  'macos-latest-large',
  'macos-15-intel',
  'macos-27',
  'ubuntu-latest',
])('the runner label %s is not an Apple-silicon macOS image and fails', (label) => {
  expect(() => read(workflow({ 'runs-on': label }))).toThrow(new RegExp(`runs-on.*${label}`, 'u'));
});

test('a self-hosted label fails even beside an Apple-silicon label', () => {
  expect(() => read(workflow({ 'runs-on': ['self-hosted', 'macos-15'] }))).toThrow(
    /runs-on label: self-hosted$/,
  );
});

function shellsOf(defaults?: unknown) {
  return read(
    workflow({ defaults, steps: [{ run: 'true' }, { run: 'true', shell: 'bash' }] }),
  ).steps.map((step) => step.kind === 'run' && step.shell);
}

test('a run step with no shell gets the default shell; an explicit bash stays bash', () => {
  expect(shellsOf()).toEqual(['default', 'bash']);
  expect(shellsOf({ run: { shell: 'bash' } })).toEqual(['bash', 'bash']);
});

test.each(['matrix.os', 'env.FLAG', 'runner.os', 'vars.FLAG', 'inputs.flag'])(
  'a job-level if that reads %s fails, because only github and needs are available there',
  (expression) => {
    const text = workflow({
      env: { FLAG: 'on' },
      if: `${expression} == 'x'`,
      strategy: { matrix: { os: ['macos-latest'] } },
    });
    expect(() => read(text, { ...lane, matrix: { os: 'macos-latest' } })).toThrow(
      new RegExp(`job "build".*${expression.replace('.', String.raw`\.`)}`, 'u'),
    );
  },
);

/** Read a job that needs build_a and build_b, with the given upstream results supplied. */
function readWith(condition: string | undefined, results: Record<string, 'success' | 'failure'>) {
  const text = workflow({ if: condition, needs: ['build_a', 'build_b'] });
  const needs = Object.fromEntries(
    Object.entries(results).map(([job, result]) => [job, { outputs: {}, result }]),
  );
  return readLane(text, lane, { ...event, needs }, paths);
}

describe('job-level status functions read the results of the jobs in needs', () => {
  test.each([
    [undefined],
    ["needs.build_a.result == 'failure'"],
    ["github.event_name == 'push'"],
    ['success()'],
  ])('%s does not run the job when an upstream job failed', (condition) => {
    expect(() => readWith(condition, { build_a: 'failure' })).toThrow(
      /job does not run for this event/,
    );
  });

  test('implicit success() runs the job when every job in needs succeeded or was not supplied', () => {
    expect(readWith(undefined, { build_a: 'success' }).steps).toEqual([]);
    expect(readWith("github.event_name == 'push'", {}).steps).toEqual([]);
  });

  test('failure() runs the job only when an upstream job failed', () => {
    expect(
      readWith("failure() && needs.build_a.result == 'failure'", { build_a: 'failure' }).steps,
    ).toEqual([]);
    expect(() => readWith('failure()', { build_a: 'success' })).toThrow(
      /job does not run for this event/,
    );
  });

  test('always() runs the job whatever the upstream results', () => {
    expect(readWith('always()', { build_a: 'failure' }).steps).toEqual([]);
  });

  test('an unsupplied job in needs counts as succeeded with no outputs', () => {
    expect(() =>
      readLane(
        workflow({ if: "needs.build_a.outputs.ok == 'true'", needs: 'build_a' }),
        lane,
        event,
        paths,
      ),
    ).toThrow(/missing upstream value needs.build_a.outputs.ok/);
  });
});

test.each([
  ['container', { container: 'node:22' }, /container/],
  ['services', { services: { db: { image: 'postgres' } } }, /services/],
  ['an unknown job key', { iff: 'false' }, /iff/],
  ['a job-level continue-on-error', { 'continue-on-error': true }, /continue-on-error/],
  [
    'an unknown step key',
    { steps: [{ iff: 'false', name: 'Typo', run: 'true' }] },
    /step 1 "Typo".*iff/,
  ],
  [
    'shell on a uses step',
    { steps: [{ name: 'Checkout', shell: 'bash', uses: 'actions/checkout@v7' }] },
    /step 1 "Checkout".*shell/,
  ],
  [
    'working-directory on a uses step',
    { steps: [{ name: 'Checkout', uses: 'actions/checkout@v7', 'working-directory': 'app' }] },
    /step 1 "Checkout".*working-directory/,
  ],
  [
    'with on a run step',
    { steps: [{ name: 'Script', run: 'true', with: { a: 1 } }] },
    /step 1 "Script".*with/,
  ],
  ['an unknown run default', { defaults: { run: { shel: 'sh' } } }, /defaults.run.*shel/],
])('a job with %s fails the read naming the key', (_label, job, pattern) => {
  expect(() => read(workflow(job))).toThrow(LaneReadError);
  expect(() => read(workflow(job))).toThrow(pattern);
});

test('a YAML merge key anywhere in the job fails the read', () => {
  const text = `
jobs:
  build:
    runs-on: macos-latest
    env: &shared
      A: one
    steps:
      - run: 'true'
        env:
          <<: *shared
          B: two
`;
  expect(() => read(text)).toThrow(/job "build".*merge key/);
});

test.each([
  ['runner.os in workflow env', {}, { env: { OS: '${{ runner.os }}' } }, /runner\.os/],
  ['matrix in workflow env', {}, { env: { OS: '${{ matrix.os }}' } }, /matrix\.os/],
  ['runner.os in job env', { env: { OS: '${{ runner.os }}' } }, {}, /runner\.os/],
  [
    'env in job timeout-minutes',
    { env: { T: 5 }, 'timeout-minutes': '${{ env.T }}' },
    {},
    /env\.T/,
  ],
  ['runner.os in the job name', { name: 'build ${{ runner.os }}' }, {}, /runner\.os/],
])('%s is outside the contexts GitHub allows there and fails', (_label, job, top, pattern) => {
  expect(() => read(workflow(job, top), { ...lane, matrix: {} })).toThrow(pattern);
});

test('job env may read matrix, needs, and github', () => {
  const text = workflow({
    env: { ALL: '${{ matrix.os }} ${{ needs.prep.outputs.v }} ${{ github.sha }}' },
    needs: 'prep',
    strategy: { matrix: { os: ['macos-15'] } },
  });
  const plan = readLane(
    text,
    { ...lane, matrix: { os: 'macos-15' } },
    { ...event, needs: { prep: { outputs: { v: '7' } } } },
    paths,
  );
  expect(plan.env).toEqual({ ALL: 'macos-15 7 abc123' });
});

test('a malformed with input is labelled with its with key', () => {
  expect(() =>
    read(
      workflow({ steps: [{ name: 'Setup', uses: 'actions/checkout@v7', with: { list: [1] } }] }),
    ),
  ).toThrow(/step 1 "Setup".*with\.list must be/);
});
