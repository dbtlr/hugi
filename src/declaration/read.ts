/**
 * Read a repository's lane declaration (ADR-0004): `.github/hugi.yaml` at one commit, and the
 * workflow files it points at. The result is the commit's lanes, no lanes when the file is
 * absent, or one refusal whose cause names the entry, job, or key at fault. A refusal refuses the
 * whole declaration. Files are data: nothing in them runs here.
 */
import { messageOf } from '../errors';
import { hasNonBmp, laneStatusName, statusNameKey } from '../github/status-name';
import { jobSettingScope, laneValues } from '../lane/contexts';
import { matchesValue, matrixRows, readMatrixEntries, selectRow } from '../lane/matrix';
import type { Combination, MatrixEntryProblem, Scalar } from '../lane/matrix';
import { jobOf, loadWorkflow } from '../lane/parse';
import { runnerLabels } from '../lane/settings';
import type { EventContext, LaneRef, RunnerPaths } from '../lane/step-plan';
import { neededJobs } from '../lane/workflow';
import { parseStrictYaml } from '../yaml/strict';
import { DeclarationRefusalError } from './errors';
import { readEntries } from './schema';
import type { Entry, ToolsSource } from './schema';

/** Where a repository declares its lanes. */
export const DECLARATION_PATH = '.github/hugi.yaml';

/**
 * The files of the commit whose lanes are being decided: a file's text by repository-relative
 * path, or `null` when the commit has no such file.
 */
export type CommitFiles = (path: string) => Promise<string | null>;

/** A declared lane: its identity as the lane reader takes it, and where its tools come from (ADR-0006). */
export type DeclaredLane = LaneRef & { readonly tools: ToolsSource };

export type Declaration =
  /** The commit has no declaration, so it has no lanes and Hugi posts nothing for it. */
  | { readonly kind: 'none' }
  | { readonly kind: 'lanes'; readonly lanes: readonly DeclaredLane[] }
  /** The whole declaration is refused; `cause` is one line for the declaration status. */
  | { readonly kind: 'refused'; readonly cause: string };

// A job's `runs-on` is judged by its matrix row alone, so a label that reads `github.*` sees
// these placeholders, not a real event: the declaration is read before any run exists.
const PLACEHOLDER_EVENT: EventContext = {
  event: 'push',
  refName: '',
  refType: 'branch',
  repository: '',
  sha: '',
};
const PLACEHOLDER_PATHS: RunnerPaths = { temp: '', workspace: '' };

/** The most text a declaration may have, measured in bytes and checked before it is parsed. */
export const MAX_DECLARATION_BYTES = 64 * 1024;

/** The longest refusal cause, so a status built from it never carries unbounded repository text. */
export const MAX_CAUSE_LENGTH = 300;

/** The most lanes a declaration may produce in total, across every entry and job. */
export const MAX_DECLARED_LANES = 256;

/**
 * The first line of a failure's message. Parsers append the source excerpt after it. A cause
 * quotes no source excerpt and no filter pattern, but it can carry short repository values such
 * as job ids, unknown keys and matrix values; every cause is one line bounded by
 * `MAX_CAUSE_LENGTH`.
 */
function oneLine(detail: unknown): string {
  return messageOf(detail).split('\n')[0]!.replace(/:$/u, '');
}

/**
 * The cause cut to at most `MAX_CAUSE_LENGTH` UTF-16 units, between characters: names, keys and
 * parser messages from the repository can be any length. Every refusal passes through here on
 * its way out.
 */
function bounded(cause: string): string {
  if (cause.length <= MAX_CAUSE_LENGTH) {
    return cause;
  }
  let kept = '';
  for (const { segment } of new Intl.Segmenter().segment(cause)) {
    if (kept.length + segment.length > MAX_CAUSE_LENGTH - 1) {
      break;
    }
    kept += segment;
  }
  return `${kept}…`;
}

function fault(where: string, detail: unknown): DeclarationRefusalError {
  return new DeclarationRefusalError(`${where}: ${oneLine(detail)}`, { cause: detail });
}

/** The filter's keys all appear in the row with a value that matches as `hugi run --matrix` does. */
function rowMatches(row: Combination, filter: Entry['matrix']): boolean {
  return Object.entries(filter).every(
    ([key, wanted]) => Object.hasOwn(row, key) && matchesValue(row[key]!, wanted),
  );
}

/** The rows the entry's filter selects; one empty row for a job with no matrix. */
function selectedRows(
  rows: readonly Combination[] | undefined,
  filter: Entry['matrix'],
  where: string,
): Combination[] {
  const keys = Object.keys(filter);
  if (rows === undefined) {
    if (keys.length > 0) {
      throw new DeclarationRefusalError(
        `${where}: the job has no matrix, so the entry takes no matrix filter`,
      );
    }
    return [{}];
  }
  for (const key of keys) {
    if (!rows.some((row) => Object.hasOwn(row, key))) {
      throw new DeclarationRefusalError(
        `${where}: matrix key "${key}" is in no row of the job's matrix`,
      );
    }
  }
  const selected = rows.filter((row) => rowMatches(row, filter));
  if (selected.length === 0) {
    throw new DeclarationRefusalError(
      `${where}: the matrix filter ${JSON.stringify(filter)} selects no row of the job's matrix`,
    );
  }
  return selected;
}

function matrixProblemText(problem: MatrixEntryProblem): string {
  if (problem.kind === 'reserved-key') {
    return `matrix key "${problem.key}" is a reserved name`;
  }
  if (problem.kind === 'repeated-key') {
    return `matrix key "${problem.key}" is named twice`;
  }
  return 'a matrix key is empty';
}

/** A row as `hugi run --matrix` takes it: its values written as text, as the lane is selected. */
function writtenAs(row: Combination): Record<string, string> {
  const result = readMatrixEntries(
    Object.entries(row).map(([key, value]) => `${key}=${String(value)}`),
  );
  if ('matrix' in result) {
    return result.matrix;
  }
  throw new Error(matrixProblemText(result.problem));
}

/** The lane's `runs-on`, resolved for its row, must be a macOS label Hugi runs. */
function requireMacRunner(runsOn: unknown, row: Combination) {
  const scope = jobSettingScope(laneValues(PLACEHOLDER_EVENT, PLACEHOLDER_PATHS, row, []));
  runnerLabels(runsOn, scope);
}

/**
 * The most bytes the distinct workflow files a declaration names may total, checked before each
 * file is parsed. Reading a workflow at the matrix caps costs seconds, so the total, not each
 * file, is what bounds the cost of one declaration.
 */
export const MAX_WORKFLOW_BYTES = 1024 * 1024;

/** A job's expanded matrix rows, or why they cannot be expanded. */
type JobRows =
  | { readonly rows: readonly Combination[] | undefined }
  | { readonly failure: unknown };

/**
 * A workflow file's text read once: the validated workflow, with each job's matrix expanded at
 * most once however many entries list it, or why the lane reader rejects it.
 */
type LoadedWorkflow =
  | { readonly workflow: Record<string, unknown>; readonly rows: Map<string, JobRows> }
  | { readonly failure: unknown };

/** Parse and validate a workflow, unless it would take the declared workflows past their total. */
function loadOnce(text: string, totalBefore: number): LoadedWorkflow {
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_WORKFLOW_BYTES) {
    return {
      failure: new Error(
        `the workflow is ${bytes} bytes, more than the ${MAX_WORKFLOW_BYTES} (1 MiB) the declared workflows may total`,
      ),
    };
  }
  if (totalBefore + bytes > MAX_WORKFLOW_BYTES) {
    return {
      failure: new Error(
        `the declared workflows total ${totalBefore + bytes} bytes, more than the ${MAX_WORKFLOW_BYTES} (1 MiB) they may total`,
      ),
    };
  }
  try {
    return { rows: new Map(), workflow: loadWorkflow(text) };
  } catch (failure) {
    return { failure };
  }
}

/** The job's matrix rows from the workflow's cache, expanding the matrix on first use. */
function jobRows(
  cache: Map<string, JobRows>,
  jobId: string,
  job: Record<string, unknown>,
): JobRows {
  let cached = cache.get(jobId);
  if (cached === undefined) {
    try {
      cached = { rows: matrixRows(job.strategy) };
    } catch (failure) {
      cached = { failure };
    }
    cache.set(jobId, cached);
  }
  return cached;
}

/** The lanes of one listed job: one per selected row, each checked as the ADR requires. */
function jobLanes(
  loaded: LoadedWorkflow,
  entry: Entry,
  jobId: string,
  where: string,
  declared: DeclaredLanes,
) {
  let job: Record<string, unknown>;
  try {
    if ('failure' in loaded) {
      throw loaded.failure;
    }
    job = jobOf(loaded.workflow, jobId);
    if (neededJobs(job.needs).length > 0) {
      throw new Error('the job declares needs, which a lane may not');
    }
  } catch (cause) {
    throw fault(where, cause);
  }
  const expanded = jobRows(loaded.rows, jobId, job);
  if ('failure' in expanded) {
    throw fault(
      `${where}, matrix cannot be expanded when the declaration is read`,
      expanded.failure,
    );
  }
  const { rows } = expanded;
  for (const row of selectedRows(rows, entry.matrix, where)) {
    try {
      selectRow(rows, writtenAs(row));
      requireMacRunner(job['runs-on'], row);
    } catch (cause) {
      throw fault(`${where}, row ${JSON.stringify(row)}`, cause);
    }
    declared.add({ job: jobId, matrix: row, tools: entry.tools, workflow: entry.workflow }, where);
  }
}

/** Two rows are one identity when they have the same keys and each value matches as the filter does. */
function sameRow(left: Readonly<Record<string, Scalar>>, right: Readonly<Record<string, Scalar>>) {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        (matchesValue(left[key]!, right[key]!) || matchesValue(right[key]!, left[key]!)),
    )
  );
}

/**
 * Lanes that could share an identity: the same job id and the same row keys. Only these are
 * compared, so the check grows with the lanes of one job, not with every lane declared.
 */
function identityBucket(lane: LaneRef): string {
  return JSON.stringify([lane.job, Object.keys(lane.matrix).toSorted()]);
}

/** A lane as a refusal names it: its job id, its row, and the workflow it is in. */
function described(lane: LaneRef): string {
  return `job "${lane.job}" with row ${JSON.stringify(lane.matrix)} in ${lane.workflow}`;
}

/**
 * The lanes declared so far. A lane is checked as it is added, so a declaration over the cap,
 * with a repeated identity, or with a repeated status name is refused at that lane and the rest is
 * never expanded. A lane's identity is its job id with its complete row; the workflow path is not
 * part of it. Two lanes of different identities can still share a status name when a matrix value
 * holds `, `, and a status with a verdict would then settle both, so names must be unique too,
 * ignoring case as GitHub does.
 */
class DeclaredLanes {
  readonly lanes: DeclaredLane[] = [];
  readonly #buckets = new Map<string, DeclaredLane[]>();
  readonly #statusNames = new Map<string, DeclaredLane>();

  add(lane: DeclaredLane, where: string) {
    if (this.lanes.length >= MAX_DECLARED_LANES) {
      throw new DeclarationRefusalError(
        `${where}: the declaration has more than ${MAX_DECLARED_LANES} lanes, the most it may have`,
      );
    }
    const key = identityBucket(lane);
    const bucket = this.#buckets.get(key) ?? [];
    const first = bucket.find((other) => sameRow(other.matrix, lane.matrix));
    if (first !== undefined) {
      throw new DeclarationRefusalError(
        `two lanes have the identity of job "${lane.job}" with row ${JSON.stringify(lane.matrix)} ` +
          `(in ${first.workflow} and ${lane.workflow})`,
      );
    }
    const statusName = laneStatusName(lane);
    if (hasNonBmp(statusName) || !statusName.isWellFormed()) {
      throw new DeclarationRefusalError(
        `GitHub accepts no 4-byte or unpaired surrogate characters in a status name, and ${described(lane)} has the status name ${JSON.stringify(statusName)}`,
      );
    }
    const named = this.#statusNames.get(statusNameKey(statusName));
    if (named !== undefined) {
      const earlier = laneStatusName(named);
      const names =
        earlier === statusName
          ? `the status name "${statusName}"`
          : `the status names "${earlier}" and "${statusName}", which Hugi compares as one status name`;
      throw new DeclarationRefusalError(
        `two lanes have ${names}: ${described(named)} and ${described(lane)}`,
      );
    }
    this.#statusNames.set(statusNameKey(statusName), lane);
    bucket.push(lane);
    this.#buckets.set(key, bucket);
    this.lanes.push(lane);
  }
}

function entryLanes(
  entry: Entry,
  index: number,
  loaded: LoadedWorkflow | null,
  declared: DeclaredLanes,
) {
  if (loaded === null) {
    throw new DeclarationRefusalError(
      `lanes[${index}]: the workflow file ${entry.workflow} does not exist at the commit`,
    );
  }
  for (const jobId of entry.jobs) {
    jobLanes(loaded, entry, jobId, `lanes[${index}] job "${jobId}" in ${entry.workflow}`, declared);
  }
}

async function declaredLanes(declarationText: string, files: CommitFiles): Promise<DeclaredLane[]> {
  const bytes = Buffer.byteLength(declarationText);
  if (bytes > MAX_DECLARATION_BYTES) {
    throw new DeclarationRefusalError(
      `${DECLARATION_PATH}: the declaration is ${bytes} bytes, more than the ${MAX_DECLARATION_BYTES} (64 KiB) it may have`,
    );
  }
  let entries: Entry[];
  try {
    entries = readEntries(parseStrictYaml(declarationText));
  } catch (cause) {
    throw fault(DECLARATION_PATH, cause);
  }
  // Each distinct workflow is read, parsed and validated once, however many entries and jobs use
  // it. Reads run one at a time in entry order, so the refusal is deterministic, only the parsed
  // workflow is kept, and reading stops at the entry whose workflow passes the byte total.
  const loaded = new Map<string, LoadedWorkflow | null>();
  const declared = new DeclaredLanes();
  let workflowBytes = 0;
  for (const [index, entry] of entries.entries()) {
    if (!loaded.has(entry.workflow)) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, so the budget stops them
      const text = await files(entry.workflow);
      loaded.set(entry.workflow, text === null ? null : loadOnce(text, workflowBytes));
      workflowBytes += text === null ? 0 : Buffer.byteLength(text);
    }
    entryLanes(entry, index, loaded.get(entry.workflow) ?? null, declared);
  }
  return declared.lanes;
}

/**
 * The lanes the commit declares. `files` reads the commit's files; it is called for the
 * declaration and then for each workflow file an entry names. Only a refusal becomes a
 * `refused` result: a `files` that throws, such as a failed git read, propagates as a failure to read.
 */
export async function readDeclaration(files: CommitFiles): Promise<Declaration> {
  const text = await files(DECLARATION_PATH);
  if (text === null) {
    return { kind: 'none' };
  }
  try {
    return { kind: 'lanes', lanes: await declaredLanes(text, files) };
  } catch (cause) {
    if (cause instanceof DeclarationRefusalError) {
      // A name from the declaration can hold an escaped line break; the cause stays one line.
      return {
        cause: bounded(cause.message.replaceAll(/[\r\n\u2028\u2029]+/gu, ' ')),
        kind: 'refused',
      };
    }
    throw cause;
  }
}
