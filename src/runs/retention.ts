/**
 * Retention for the runs directory: runs older than a maximum age go, and once the store passes a
 * maximum size the oldest go until it fits. `hugi run` and the later service both call
 * `applyRetention` after they write a run's record.
 *
 * Only a run directory is ever deleted: a real directory (never a symlink) directly inside the
 * runs directory and named like a run. Anything else is left alone and does not count toward the
 * size. A run's age is when it ended; a running run's age is when it started, so a running run is
 * deleted only when it is stale, past the age limit, and never to make room. A directory with no
 * usable record is an orphan, left by a run that did not finish; its age is its directory's
 * modification time. Runs named in `keep` are never deleted.
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { messageOf } from '../errors';
import { inspectRunDirectory, runDirectoryNames } from './store';

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;

export type RetentionLimits = {
  readonly maxAgeDays: number;
  readonly maxSizeGb: number;
};

export type RetentionOptions = {
  readonly now: Date;
  /** The ids of runs retention never deletes, such as the run just written. */
  readonly keep?: ReadonlySet<string>;
  /** Where a run that could not be deleted is reported; retention carries on. */
  readonly warn?: (message: string) => void;
};

export type RetentionResult = {
  /** The ids of the runs deleted, oldest first. */
  readonly deleted: readonly string[];
};

type Candidate = {
  readonly id: string;
  readonly dir: string;
  /** Epoch milliseconds the run's age counts from: its end, its start while running, or an orphan's mtime. */
  readonly since: number;
  /** A run in flight is not deleted to make room. */
  readonly running: boolean;
  /** A run-named directory with no usable record. */
  readonly orphan: boolean;
  readonly size: number;
};

/** Bytes under `dir`, counting each entry's own size and never following a symlink. */
async function sizeOf(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? sizeOf(path) : (await lstat(path)).size;
    }),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}

/** A run directory as a candidate, or undefined when it cannot be measured (it may have just gone). */
async function candidateOf(runsDir: string, id: string): Promise<Candidate | undefined> {
  const dir = join(runsDir, id);
  try {
    const contents = await inspectRunDirectory(dir, id);
    const size = await sizeOf(dir);
    if (contents.kind !== 'record') {
      return {
        dir,
        id,
        orphan: true,
        running: false,
        since: (await lstat(dir)).mtimeMs,
        size,
      };
    }
    const { record } = contents;
    return record.state === 'running'
      ? { dir, id, orphan: false, running: true, since: Date.parse(record.startedAt), size }
      : { dir, id, orphan: false, running: false, since: Date.parse(record.endedAt), size };
  } catch {
    return undefined;
  }
}

async function candidates(runsDir: string): Promise<Candidate[]> {
  const found = await Promise.all(
    (await runDirectoryNames(runsDir)).map((id) => candidateOf(runsDir, id)),
  );
  return found
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .toSorted((a, b) => a.since - b.since || a.id.localeCompare(b.id));
}

/**
 * How long an orphan is spared from the size rule. A run's directory exists a moment before its
 * `running` record does, so a young orphan may be a run that is starting; only the age rule, or
 * this much quiet, lets it go.
 */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** The runs to delete, oldest first: those past the age limit, then the oldest until the rest fit. */
function chooseDeletions(
  runs: readonly Candidate[],
  limits: RetentionLimits,
  options: RetentionOptions,
): Candidate[] {
  const keep = options.keep ?? new Set<string>();
  const oldest = options.now.getTime() - limits.maxAgeDays * DAY_MS;
  const settled = (run: Candidate) =>
    !run.running && !(run.orphan && run.since > options.now.getTime() - ORPHAN_GRACE_MS);
  const doomed = new Set(runs.filter((run) => !keep.has(run.id) && run.since < oldest));
  let total = runs.filter((run) => !doomed.has(run)).reduce((sum, run) => sum + run.size, 0);
  for (const run of runs) {
    if (total <= limits.maxSizeGb * GB) {
      break;
    }
    if (!doomed.has(run) && settled(run) && !keep.has(run.id)) {
      doomed.add(run);
      total -= run.size;
    }
  }
  return runs.filter((run) => doomed.has(run));
}

/** Apply both retention rules to `runsDir`; a run that cannot be deleted is warned about, not fatal. */
export async function applyRetention(
  runsDir: string,
  limits: RetentionLimits,
  options: RetentionOptions,
): Promise<RetentionResult> {
  const doomed = chooseDeletions(await candidates(runsDir), limits, options);
  const outcomes = await Promise.all(
    doomed.map(async (run) => {
      try {
        await rm(run.dir, { force: true, recursive: true });
        return run.id;
      } catch (error) {
        options.warn?.(`could not delete the old run ${run.dir}: ${messageOf(error)}`);
        return undefined;
      }
    }),
  );
  return { deleted: outcomes.filter((id): id is string => id !== undefined) };
}
