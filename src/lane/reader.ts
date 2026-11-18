import { jobRuns, stepCondition } from './conditions';
import {
  jobEnvScope,
  jobIfScope,
  jobSettingScope,
  laneValues,
  stepScope,
  workflowEnvScope,
} from './contexts';
import type { LaneValues } from './contexts';
import { JobSkippedError, LaneReadError, LaneSelectionError, withContext } from './errors';
import { expand } from './expressions';
import type { Context } from './expressions';
import { checkJobKeys, checkStepKeys, checkStrategyKeys, rejectMergeKeys } from './keys';
import { selectCombination } from './matrix';
import { loadJob, mapping, scalar } from './parse';
import {
  actionReference,
  continueOnError,
  expandMapping,
  runDefaults,
  runnerLabels,
  shell,
  timeout,
  workflowRunDefaults,
  workingDirectory,
} from './settings';
import type { EventContext, LaneRef, PlanStep, RunnerPaths, StepPlan } from './step-plan';
import { neededJobs } from './workflow';

export { JobSkippedError, LaneReadError, LaneSelectionError } from './errors';

function readStep(
  value: unknown,
  index: number,
  ctx: Context,
  defaults: Record<string, unknown>,
): PlanStep | null {
  let name = `step ${index}`;
  try {
    const step = mapping(value, `step ${index}`);
    name =
      step.name === undefined
        ? scalar(step.uses ?? name, 'step name')
        : expand(step.name, ctx, 'step name');
    if (Object.hasOwn(step, 'run') === Object.hasOwn(step, 'uses')) {
      throw new Error('a step must contain exactly one of run or uses');
    }
    checkStepKeys(step);
    const when = stepCondition(step.if, ctx);
    if (when === null) {
      return null;
    }
    const base = {
      continueOnError: continueOnError(step['continue-on-error'], ctx),
      env: expandMapping(step.env, ctx, 'env'),
      index,
      name,
      when,
      ...(step['timeout-minutes'] === undefined
        ? {}
        : { timeoutMinutes: timeout(step['timeout-minutes'], ctx) }),
    };
    if (step.uses !== undefined) {
      const uses = actionReference(step.uses);
      return { ...base, kind: 'action', uses, with: expandMapping(step.with, ctx, 'with') };
    }
    const directory = step['working-directory'] ?? defaults['working-directory'];
    return {
      ...base,
      kind: 'run',
      script: expand(step.run, ctx, 'run'),
      shell: shell(step.shell ?? defaults.shell),
      ...(directory === undefined ? {} : { workingDirectory: workingDirectory(directory, ctx) }),
    };
  } catch (cause) {
    throw withContext(`step ${index} "${name}"`, cause);
  }
}

/** Upstream values supplied for a job outside the lane's `needs:` would go unread, so refuse them. */
function refuseUnneededJobs(event: EventContext, needs: readonly string[]) {
  const listed = needs.length === 0 ? 'none' : needs.join(', ');
  for (const job of Object.keys(event.needs ?? {})) {
    if (!needs.includes(job)) {
      throw new LaneSelectionError(`"${job}" is not in the job's needs (${listed})`);
    }
  }
}

/** Fail unless the job-level `if:` holds, given the upstream results the caller supplied. */
function requireJobRuns(
  condition: unknown,
  lane: LaneValues,
  needs: readonly string[],
  event: EventContext,
) {
  const results = needs.map((job) => event.needs?.[job]?.result ?? 'success');
  const upstream = {
    allSucceeded: results.every((result) => result === 'success'),
    anyFailed: results.includes('failure'),
  };
  if (!jobRuns(condition, jobIfScope(lane), upstream)) {
    throw new JobSkippedError('job does not run for this event');
  }
}

/** Workflow-level then job-level `env:`; GitHub lets neither read the `env` context. */
function laneEnvironment(
  workflowEnv: unknown,
  jobEnv: unknown,
  lane: LaneValues,
): Record<string, string> {
  const outer = expandMapping(workflowEnv, workflowEnvScope(lane), 'env');
  return { ...outer, ...expandMapping(jobEnv, jobEnvScope(lane), 'env') };
}

/** Read a whole lane before returning any steps to the run. */
export function readLane(
  text: string,
  lane: LaneRef,
  event: EventContext,
  paths: RunnerPaths,
): StepPlan {
  try {
    const { job, workflow } = loadJob(text, lane.job);
    checkJobKeys(job);
    rejectMergeKeys(job, 'the job');
    rejectMergeKeys(workflow.env, 'workflow env');
    rejectMergeKeys(workflow.defaults, 'workflow defaults');
    if (job.strategy !== undefined) {
      checkStrategyKeys(mapping(job.strategy, 'strategy'));
    }
    const needs = neededJobs(job.needs);
    refuseUnneededJobs(event, needs);
    const values = laneValues(event, paths, selectCombination(job.strategy, lane.matrix), needs);
    requireJobRuns(job.if, values, needs, event);
    const settings = jobSettingScope(values);
    runnerLabels(job['runs-on'], settings);
    const env = laneEnvironment(workflow.env, job.env, values);
    const defaults = {
      ...workflowRunDefaults(workflow.defaults),
      ...runDefaults(job.defaults, 'job defaults'),
    };
    if (!Array.isArray(job.steps)) {
      throw new Error('steps must be a list');
    }
    const ctx = stepScope(values);
    const steps = job.steps.flatMap((step, index) => {
      const planned = readStep(step, index + 1, ctx, defaults);
      return planned === null ? [] : [planned];
    });
    return {
      env,
      lane,
      name: expand(job.name ?? lane.job, settings, 'name'),
      steps,
      timeoutMinutes: timeout(job['timeout-minutes'] ?? 360, settings),
    };
  } catch (cause) {
    throw withContext(`job "${lane.job}"`, cause, LaneReadError);
  }
}
