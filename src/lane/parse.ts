import { parse } from 'yaml';

import { LaneSelectionError } from './errors';
import { validateWorkflow } from './workflow';

export function scalar(value: unknown, field: string): string {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return String(value);
  }
  throw new Error(`${field} must be a string, number, or boolean`);
}

export function mapping(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  return Object.fromEntries(Object.entries(value));
}

/** The workflow, once GitHub would accept it as a whole. */
export function loadWorkflow(text: string): Record<string, unknown> {
  const workflow = mapping(parse(text), 'workflow');
  validateWorkflow(workflow);
  return workflow;
}

/** The job a validated workflow holds under `jobId`. */
export function jobOf(workflow: Record<string, unknown>, jobId: string): Record<string, unknown> {
  const jobs = mapping(workflow.jobs, 'jobs');
  if (!Object.hasOwn(jobs, jobId)) {
    throw new LaneSelectionError(`the workflow has no job named "${jobId}"`);
  }
  return mapping(jobs[jobId], `jobs.${jobId}`);
}

/** The workflow and the lane's job, once GitHub would accept the workflow as a whole. */
export function loadJob(text: string, jobId: string) {
  const workflow = loadWorkflow(text);
  return { job: jobOf(workflow, jobId), workflow };
}
