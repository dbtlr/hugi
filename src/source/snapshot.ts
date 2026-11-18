/**
 * A local repository reaches the guest as a snapshot: a fresh bare repository on the host that
 * holds one commit at depth 1 under one fixed ref, and nothing else. Sharing the working tree
 * instead would hand the lane every untracked file in it, such as a `.env` (ADR-0002), and would
 * break for a linked worktree, whose `.git` file names a host path the guest cannot reach.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Git } from './git';

/** The one ref a snapshot holds; the guest fetches the commit by sha, so the name only keeps it. */
const SNAPSHOT_REF = 'refs/heads/snapshot';

type Snapshot = {
  /** The bare snapshot repository, to share read-only with the guest. */
  readonly path: string;
  /** Delete the snapshot. */
  readonly remove: () => Promise<void>;
};

type SnapshotGit = {
  /** Hardened git for the calls that fetch nothing. */
  readonly git: Git;
  /** Hardened git that may use only the `file` transport: for the one fetch from the repository. */
  readonly fileGit: Git;
};

/** Run git and return its stdout, or throw a `SourceError` with git's stderr. */
type GitOrThrow = (
  git: Git,
  gitDir: string | undefined,
  args: readonly string[],
) => Promise<string>;

/**
 * Build the snapshot of `sha` from the repository at `repositoryPath`, which may be its root, a
 * subdirectory, or a linked worktree: all three share one common git directory. A failure removes
 * whatever was built and rethrows.
 */
export async function snapshotCommit(
  gits: SnapshotGit,
  gitOrThrow: GitOrThrow,
  repositoryPath: string,
  sha: string,
  tempDir: string,
): Promise<Snapshot> {
  const commonDir = (
    await gitOrThrow(gits.git, undefined, [
      '-C',
      repositoryPath,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ])
  ).trim();
  const path = await mkdtemp(join(tempDir, 'hugi-source-'));
  const remove = () => rm(path, { force: true, recursive: true });
  try {
    // No template: no sample hooks or description; the only config is what `init` writes itself.
    await gitOrThrow(gits.git, undefined, [
      'init',
      '--quiet',
      '--bare',
      '--template=',
      `--initial-branch=${SNAPSHOT_REF.slice('refs/heads/'.length)}`,
      path,
    ]);
    // Fetching a URL, not a remote, writes no remote config and no remote-tracking ref.
    await gitOrThrow(gits.fileGit, path, [
      '-c',
      'protocol.version=2',
      'fetch',
      '--quiet',
      '--depth',
      '1',
      '--no-tags',
      '--no-write-fetch-head',
      // A URL, so git decodes it: a `%` in the path must be escaped to survive.
      pathToFileURL(commonDir).href,
      sha,
    ]);
    await gitOrThrow(gits.git, path, ['update-ref', SNAPSHOT_REF, sha]);
  } catch (error) {
    await remove();
    throw error;
  }
  return { path, remove };
}
