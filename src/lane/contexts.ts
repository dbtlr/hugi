import type { Context, Value } from './expressions';
import type { EventContext, RunnerPaths } from './step-plan';

type Values = Readonly<Record<string, Value>>;

/** The values a lane's expressions can read, grouped by the context that holds them. */
export type LaneValues = {
  readonly github: Values;
  readonly runner: Values;
  readonly matrix: Values;
  readonly needs: Values;
  /** Full `github.*` expressions this event cannot supply, with the reason. */
  readonly githubGaps: Readonly<Record<string, string>>;
};

const PULL_REQUEST_REF_REASON =
  'not supported for pull_request events until the contract carries the PR number';

const STEP_ENV_REASON =
  'a step cannot read env, because earlier steps can change it through GITHUB_ENV';

function githubValues(event: EventContext, paths: RunnerPaths): Values {
  return {
    'github.event_name': event.event,
    'github.ref_type': event.refType,
    'github.repository': event.repository,
    'github.sha': event.sha,
    'github.workspace': paths.workspace,
    ...(event.event === 'pull_request'
      ? {}
      : {
          'github.ref': `refs/${event.refType === 'tag' ? 'tags' : 'heads'}/${event.refName}`,
          'github.ref_name': event.refName,
        }),
  };
}

function githubGaps(event: EventContext): Record<string, string> {
  return event.event === 'pull_request'
    ? { 'github.ref': PULL_REQUEST_REF_REASON, 'github.ref_name': PULL_REQUEST_REF_REASON }
    : {};
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
    githubGaps: githubGaps(event),
    matrix: Object.fromEntries(
      Object.entries(matrix).map(([key, value]) => [`matrix.${key}`, value]),
    ),
    needs: needsValues(needs, event.needs),
    runner: { 'runner.arch': 'ARM64', 'runner.os': 'macOS', 'runner.temp': paths.temp },
  };
}

function scope(
  lane: LaneValues,
  values: readonly Values[],
  where: string,
  disallowed: readonly string[],
): Context {
  return {
    unavailable: {
      ...lane.githubGaps,
      ...Object.fromEntries(
        disallowed.map((name) => [name, `GitHub does not allow the ${name} context in ${where}`]),
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
  return scope(lane, [lane.needs], 'a job-level if', [
    'env',
    'inputs',
    'job',
    'matrix',
    'runner',
    'secrets',
    'steps',
    'strategy',
    'vars',
  ]);
}

/** Job env may also read the workflow env above it. */
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
    unavailable: { ...lane.githubGaps, env: STEP_ENV_REASON },
    values: { ...lane.github, ...lane.needs, ...lane.matrix, ...lane.runner },
  };
}
