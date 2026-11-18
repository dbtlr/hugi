/**
 * The workflow keys the reader understands. A key outside these lists is one
 * GitHub would reject or one whose effect the plan cannot carry, so it fails
 * the read instead of being dropped.
 */

/**
 * Job keys. `permissions`, `outputs`, and `concurrency` are accepted and
 * ignored: they shape the token, downstream jobs, and scheduling, not what the
 * lane's steps run. Job-level `continue-on-error` is left out on purpose: no
 * enrolled lane uses it yet, and accepting it means deciding what a failed run
 * of an allowed-to-fail lane reports.
 */
const JOB_KEYS = [
  'concurrency',
  'defaults',
  'env',
  'if',
  'name',
  'needs',
  'outputs',
  'permissions',
  'runs-on',
  'steps',
  'strategy',
  'timeout-minutes',
];

const STRATEGY_KEYS = ['fail-fast', 'matrix', 'max-parallel'];
const DEFAULTS_KEYS = ['run'];
const RUN_DEFAULTS_KEYS = ['shell', 'working-directory'];

const STEP_KEYS = ['continue-on-error', 'env', 'id', 'if', 'name', 'timeout-minutes'];
const RUN_STEP_KEYS = [...STEP_KEYS, 'run', 'shell', 'working-directory'];
const ACTION_STEP_KEYS = [...STEP_KEYS, 'uses', 'with'];

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], where: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`unsupported key in ${where}: ${unknown.join(', ')}`);
  }
}

export function checkJobKeys(job: Record<string, unknown>) {
  checkKeys(job, JOB_KEYS, 'the job');
}

export function checkStrategyKeys(strategy: Record<string, unknown>) {
  checkKeys(strategy, STRATEGY_KEYS, 'strategy');
}

export function checkDefaultsKeys(defaults: Record<string, unknown>, where: string) {
  checkKeys(defaults, DEFAULTS_KEYS, where);
}

export function checkRunDefaultsKeys(run: Record<string, unknown>, where: string) {
  checkKeys(run, RUN_DEFAULTS_KEYS, where);
}

export function checkStepKeys(step: Record<string, unknown>) {
  checkKeys(step, Object.hasOwn(step, 'uses') ? ACTION_STEP_KEYS : RUN_STEP_KEYS, 'the step');
}

/**
 * GitHub does not support YAML merge keys, and the parser keeps `<<` as an
 * ordinary key, so a merge would silently become an unknown env name or input.
 */
export function rejectMergeKeys(value: unknown, where: string) {
  if (Array.isArray(value)) {
    value.forEach((item) => rejectMergeKeys(item, where));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '<<') {
        throw new Error(`unsupported YAML merge key (<<) in ${where}`);
      }
      rejectMergeKeys(item, where);
    }
  }
}
