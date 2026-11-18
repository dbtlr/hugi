/**
 * Whole-file checks GitHub makes before it runs any job. The reader reads only the lane's own job,
 * so without these a workflow GitHub refuses as invalid would still run, and pass, here. Each
 * check throws a plain error; the reader reports it as a `LaneReadError`, a fail verdict.
 */
import { mapping, scalar } from './parse';

/** The top-level keys GitHub accepts in a workflow file. */
const WORKFLOW_KEYS = new Set([
  'concurrency',
  'defaults',
  'env',
  'jobs',
  'name',
  'on',
  'permissions',
  'run-name',
]);

/**
 * The keys GitHub accepts in any job, including ones the lane reader does not support in the lane
 * itself (a container, services, a reusable workflow). The lane's own job is held to the
 * reader's stricter set separately.
 */
const ANY_JOB_KEYS = new Set([
  'concurrency',
  'container',
  'continue-on-error',
  'defaults',
  'env',
  'environment',
  'if',
  'name',
  'needs',
  'outputs',
  'permissions',
  'runs-on',
  'secrets',
  'services',
  'snapshot',
  'steps',
  'strategy',
  'timeout-minutes',
  'uses',
  'with',
]);

/** GitHub's pattern for job and step ids: a letter or `_`, then letters, digits, `-`, and `_`. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

function invalid(reason: string): Error {
  return new Error(`invalid workflow: ${reason}`);
}

/** The jobs a job's `needs:` names: a single job or a list of them. */
export function neededJobs(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).map((job) => scalar(job, 'needs'));
}

/** `on:` names an event, a list of events, or a mapping of events to their filters. */
function isTrigger(on: unknown): boolean {
  if (typeof on === 'string') {
    return on !== '';
  }
  if (Array.isArray(on)) {
    return on.length > 0 && on.every((event) => typeof event === 'string' && event !== '');
  }
  return typeof on === 'object' && on !== null && Object.keys(on).length > 0;
}

function checkTopLevel(workflow: Record<string, unknown>) {
  if (!Object.hasOwn(workflow, 'on')) {
    throw invalid('the workflow has no on: trigger');
  }
  if (!isTrigger(workflow.on)) {
    throw invalid('on: must name an event, a list of events, or a mapping of events');
  }
  const unknown = Object.keys(workflow).filter((key) => !WORKFLOW_KEYS.has(key));
  if (unknown.length > 0) {
    throw invalid(`unknown top-level key ${unknown.join(', ')}`);
  }
}

function checkSteps(id: string, steps: unknown) {
  if (!Array.isArray(steps)) {
    return;
  }
  const seen = new Set<string>();
  for (const step of steps) {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      continue;
    }
    const fields = mapping(step, 'step');
    if (!Object.hasOwn(fields, 'id')) {
      continue;
    }
    const stepId = scalar(fields.id, 'step id');
    if (!IDENTIFIER.test(stepId)) {
      throw invalid(`job "${id}" has an invalid step id "${stepId}"`);
    }
    if (seen.has(stepId)) {
      throw invalid(`job "${id}" uses the step id "${stepId}" more than once`);
    }
    seen.add(stepId);
  }
}

function checkJob(id: string, value: unknown, jobIds: readonly string[]): string[] {
  if (!IDENTIFIER.test(id)) {
    throw invalid(
      `job id "${id}" must start with a letter or _ and contain only letters, digits, - and _`,
    );
  }
  const job = mapping(value, `jobs.${id}`);
  const unknown = Object.keys(job).filter((key) => !ANY_JOB_KEYS.has(key));
  if (unknown.length > 0) {
    throw invalid(`job "${id}" has an unknown key ${unknown.join(', ')}`);
  }
  // A job runs on a runner or calls a reusable workflow; GitHub requires one of the two.
  if (!Object.hasOwn(job, 'runs-on') && !Object.hasOwn(job, 'uses')) {
    throw invalid(`job "${id}" needs runs-on or uses`);
  }
  const needs = neededJobs(job.needs);
  for (const target of needs) {
    if (!jobIds.includes(target)) {
      throw invalid(`job "${id}" needs "${target}", which is not a job in the workflow`);
    }
  }
  checkSteps(id, job.steps);
  return needs;
}

/** Refuse a `needs` cycle, naming the jobs on it. */
function checkAcyclic(needs: ReadonlyMap<string, readonly string[]>) {
  const done = new Set<string>();
  const visit = (id: string, path: readonly string[]) => {
    if (path.includes(id)) {
      throw invalid(`needs cycle ${[...path.slice(path.indexOf(id)), id].join(' -> ')}`);
    }
    if (done.has(id)) {
      return;
    }
    for (const target of needs.get(id) ?? []) {
      visit(target, [...path, id]);
    }
    done.add(id);
  };
  for (const id of needs.keys()) {
    visit(id, []);
  }
}

/** Throw unless GitHub would accept the workflow file as a whole. */
export function validateWorkflow(workflow: Record<string, unknown>) {
  checkTopLevel(workflow);
  const jobs = mapping(workflow.jobs, 'jobs');
  const jobIds = Object.keys(jobs);
  const needs = new Map(jobIds.map((id) => [id, checkJob(id, jobs[id], jobIds)] as const));
  checkAcyclic(needs);
}
