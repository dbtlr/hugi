import { parse } from 'yaml';

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

export function loadJob(text: string, jobId: string) {
  const workflow = mapping(parse(text), 'workflow');
  const jobs = mapping(workflow.jobs, 'jobs');
  if (!Object.hasOwn(jobs, jobId)) {
    throw new Error('missing job');
  }
  return { job: mapping(jobs[jobId], `jobs.${jobId}`), workflow };
}
