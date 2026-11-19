import type { Context, Value } from './expressions';
import { refValues } from './refs';
import type { EventContext, RunnerPaths } from './step-plan';

type Values = Readonly<Record<string, Value>>;

/** The values a lane's expressions can read, grouped by the context that holds them. */
export type LaneValues = {
  readonly github: Values;
  readonly runner: Values;
  readonly matrix: Values;
  readonly needs: Values;
};

const STEP_ENV_REASON =
  'a step cannot read env, because earlier steps can change it through GITHUB_ENV';

/** The `github.*` values; the event payload, `github.event.*`, is not among them. */
function githubValues(event: EventContext, paths: RunnerPaths): Values {
  const refs = refValues(event);
  return {
    'github.base_ref': refs.baseRef,
    'github.event_name': event.event,
    'github.head_ref': refs.headRef,
    'github.ref': refs.ref,
    'github.ref_name': refs.refName,
    'github.ref_type': refs.refType,
    'github.repository': event.repository,
    'github.sha': event.sha,
    'github.workspace': paths.workspace,
  };
}

/**
 * Every job in the job's `needs:` gets a result; one the caller did not supply,
 * or supplied without a result, counts as succeeded. Outputs exist only as supplied.
 */
function needsValues(jobs: readonly string[], supplied: EventContext['needs']): Values {
  const entries: [string, Value][] = [];
  for (const job of jobs) {
    const facts = supplied?.[job];
    entries.push([`needs.${job}.result`, facts?.result ?? 'success']);
    for (const [key, value] of Object.entries(facts?.outputs ?? {})) {
      entries.push([`needs.${job}.outputs.${key}`, value]);
    }
  }
  return Object.fromEntries(entries);
}

export function laneValues(
  event: EventContext,
  paths: RunnerPaths,
  matrix: Readonly<Record<string, Value>>,
  needs: readonly string[],
): LaneValues {
  return {
    github: githubValues(event, paths),
    matrix: Object.fromEntries(
      Object.entries(matrix).map(([key, value]) => [`matrix.${key}`, value]),
    ),
    needs: needsValues(needs, event.needs),
    runner: { 'runner.arch': 'ARM64', 'runner.os': 'macOS', 'runner.temp': paths.temp },
  };
}

/**
 * `disallowed` names the contexts GitHub refuses in `where`; `unsupplied`, the ones GitHub allows
 * there but Hugi has no values for.
 */
function scope(
  lane: LaneValues,
  values: readonly Values[],
  where: string,
  disallowed: readonly string[],
  unsupplied: readonly string[] = [],
): Context {
  return {
    unavailable: {
      ...Object.fromEntries(
        disallowed.map((name) => [name, `GitHub does not allow the ${name} context in ${where}`]),
      ),
      ...Object.fromEntries(
        unsupplied.map((name) => [name, `Hugi cannot supply the ${name} context in ${where}`]),
      ),
    },
    values: Object.assign({}, lane.github, ...values),
  };
}

// Each scope follows GitHub's context-availability table for that workflow key.

export function workflowEnvScope(lane: LaneValues): Context {
  return scope(lane, [], 'workflow env', [
    'env',
    'job',
    'matrix',
    'needs',
    'runner',
    'steps',
    'strategy',
  ]);
}

export function jobIfScope(lane: LaneValues): Context {
  return scope(
    lane,
    [lane.needs],
    'a job-level if',
    ['env', 'job', 'matrix', 'runner', 'secrets', 'steps', 'strategy'],
    ['inputs', 'vars'],
  );
}

/** Job env may read needs, matrix, and github, but not the workflow env: GitHub refuses `env` there. */
export function jobEnvScope(lane: LaneValues): Context {
  return scope(lane, [lane.needs, lane.matrix], 'job env', ['env', 'job', 'runner', 'steps']);
}

/** The job's `name`, `runs-on`, and `timeout-minutes`. */
export function jobSettingScope(lane: LaneValues): Context {
  return scope(lane, [lane.needs, lane.matrix], 'job name, runs-on, or timeout-minutes', [
    'env',
    'job',
    'runner',
    'secrets',
    'steps',
  ]);
}

export function stepScope(lane: LaneValues): Context {
  return {
    unavailable: { env: STEP_ENV_REASON },
    values: { ...lane.github, ...lane.needs, ...lane.matrix, ...lane.runner },
  };
}
