/**
 * Reads a repository at a commit as data, on the host. Nothing from the repository runs here:
 * only `git` reads objects, under the hardening in `./git` (ADR-0002). A GitHub repository is read
 * through a bare partial clone in the cache, which only the user may write; a local repository is
 * read in place, with lazy fetching off, and reaches the guest as a snapshot (`./snapshot`).
 */
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Host } from '@loomcli/core';

import { messageOf } from '../errors';
import type { SourceLocation } from '../vm';
import { createGit } from './git';
import type { Git, GitTransport } from './git';
import type { RepositorySpec } from './repository-spec';
import { snapshotCommit } from './snapshot';

/** The repository could not be read: git failed, the commit is unknown, or a fetch failed. */
export class SourceError extends Error {
  override readonly name = 'SourceError';
}

/** A path names a tree, not a file, at the commit. The repository read fine; its content is wrong. */
export class NotAFileError extends Error {
  override readonly name = 'NotAFileError';
}

/** A name is both a branch and a tag, so which one the run stands for is the caller's choice. */
export class AmbiguousRefError extends Error {
  override readonly name = 'AmbiguousRefError';
  readonly refName: string;

  constructor(refName: string) {
    super(`"${refName}" is both a branch and a tag.`);
    this.refName = refName;
  }
}

/** Where the guest fetches the commit from, and how to clean that up once the run ends. */
export type GuestSource = {
  readonly location: SourceLocation;
  /** Remove what the location needed on the host; a no-op for a GitHub source. */
  readonly release: () => Promise<void>;
};

/** A repository at one commit. */
export type HostSource = {
  /** The full sha the commit argument resolved to. */
  readonly sha: string;
  /**
   * The file's text at the commit, or `undefined` when the commit has no such path. A path that
   * names a directory throws `NotAFileError`; a read git cannot complete throws `SourceError`.
   */
  readonly readFile: (path: string) => Promise<string | undefined>;
  /**
   * Whether the commit argument named a branch or a tag; absent for a sha. A name that is both is
   * refused when the source opens, with `AmbiguousRefError`.
   */
  readonly refKind?: 'branch' | 'tag';
  /**
   * Prepare the source for the guest: a GitHub repository's clone URL, or for a local repository
   * a snapshot that holds only the commit. A snapshot that cannot be built throws `SourceError`.
   */
  readonly guestSource: () => Promise<GuestSource>;
};

export type HostSourceOptions = {
  readonly cacheDir: string;
  /** The run's `host.spawn`, the only way this module starts a program. */
  readonly spawn: Host['spawn'];
  /** The run's `host.env`, from which git's environment is built. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** The run's `host.uid`: the only user a cached clone may belong to. */
  readonly uid: number | undefined;
  /** The transport a GitHub source is fetched over; https unless a test serves a fixture. */
  readonly remoteTransport?: GitTransport;
  /** The run's `host.tmpdir`, where a local source's snapshot is built. */
  readonly tempDir: string;
};

async function gitOrThrow(
  git: Git,
  gitDir: string | undefined,
  args: readonly string[],
): Promise<string> {
  const outcome = await git(gitDir, args);
  if (!outcome.ok) {
    throw new SourceError(`git ${args.join(' ')} failed: ${outcome.stderr.trim()}`);
  }
  return outcome.stdout;
}

/** The directory git reads: the local repository's own, or the cached bare clone. */
type Repository = { readonly gitDir: string; readonly refresh: () => Promise<void> };

async function localRepository(git: Git, path: string): Promise<Repository> {
  const gitDir = (
    await gitOrThrow(git, undefined, ['-C', path, 'rev-parse', '--absolute-git-dir'])
  ).trim();
  return { gitDir, refresh: async () => {} };
}

/** Group- or world-writable mode bits. */
const SHARED_WRITE = 0o022;

/**
 * A cache path another user could have written is refused: its config decides where git fetches
 * from. `false` when the path does not exist yet. A runtime with no user ID skips the owner check.
 */
async function checkPrivate(path: string, uid: number | undefined): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return false;
  }
  if (uid !== undefined && info.uid !== uid) {
    throw new SourceError(`The cache path ${path} is not owned by the current user; remove it.`);
  }
  if ((info.mode & SHARED_WRITE) !== 0) {
    throw new SourceError(`The cache path ${path} is writable by other users; remove it.`);
  }
  return true;
}

/** The refs a refresh mirrors from the repository URL. */
const MIRRORED_REFS = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'] as const;

/**
 * Bare, blob-less clone: cheap to fetch, and enough to read the few files Hugi needs. A refresh
 * fetches from the repository's URL, never from a remote name the clone's config defines.
 */
async function cachedClone(
  git: Git,
  spec: Extract<RepositorySpec, { kind: 'github' }>,
  options: HostSourceOptions,
): Promise<Repository> {
  const { cloneUrl, name } = spec;
  const { cacheDir, uid } = options;
  const reposDir = join(cacheDir, 'repos');
  const gitDir = join(reposDir, `${name.replace('/', '__')}.git`);
  const refresh = async () => {
    await gitOrThrow(git, gitDir, [
      'fetch',
      '--quiet',
      '--force',
      '--filter=blob:none',
      cloneUrl,
      ...MIRRORED_REFS,
    ]);
  };
  try {
    await mkdir(reposDir, { mode: 0o700, recursive: true });
  } catch (error) {
    throw new SourceError(`Cannot create the cache at ${reposDir}: ${messageOf(error)}`);
  }
  await checkPrivate(reposDir, uid);
  if (await checkPrivate(gitDir, uid)) {
    await checkPrivate(join(gitDir, 'config'), uid);
    await gitOrThrow(git, gitDir, ['rev-parse', '--git-dir']);
    return { gitDir, refresh };
  }
  await gitOrThrow(git, undefined, [
    'clone',
    '--bare',
    '--quiet',
    '--filter=blob:none',
    cloneUrl,
    gitDir,
  ]);
  return { gitDir, refresh };
}

async function resolveSha(git: Git, repository: Repository, revision: string): Promise<string> {
  const args = ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`];
  let outcome = await git(repository.gitDir, args);
  if (!outcome.ok) {
    await repository.refresh();
    outcome = await git(repository.gitDir, args);
  }
  if (!outcome.ok) {
    throw new SourceError(`The commit "${revision}" does not exist in the repository.`);
  }
  return outcome.stdout.trim();
}

/** A remote branch tip can move, so a name is resolved after a refresh; a sha needs none. */
function looksLikeSha(commit: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(commit);
}

const REF_PREFIXES = { branch: 'refs/heads/', tag: 'refs/tags/' } as const;

/** Whether `name` is a branch or a tag; a name that is both is refused rather than guessed. */
async function refKindOf(git: Git, gitDir: string, name: string) {
  const [branch, tag] = await Promise.all(
    [REF_PREFIXES.branch, REF_PREFIXES.tag].map(
      async (prefix) =>
        (await git(gitDir, ['show-ref', '--verify', '--quiet', `${prefix}${name}`])).ok,
    ),
  );
  if (branch && tag) {
    throw new AmbiguousRefError(name);
  }
  if (branch) {
    return 'branch';
  }
  return tag ? 'tag' : undefined;
}

/**
 * The kind of object at `path`, read from the trees alone so a missing blob is never fetched:
 * `undefined` when the commit has no such path.
 */
async function pathKind(git: Git, gitDir: string, sha: string, path: string) {
  const listing = await gitOrThrow(git, gitDir, [
    'ls-tree',
    '-z',
    '--format=%(objecttype) %(path)',
    sha,
    '--',
    path,
  ]);
  // `<type> <path>`: the type has no space, so the first one ends it and the path keeps the rest.
  const entry = listing
    .split('\0')
    .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)])
    .find(([, listed]) => listed === path);
  return entry?.[0];
}

function fileReader(git: Git, gitDir: string, sha: string) {
  return async (path: string): Promise<string | undefined> => {
    const kind = await pathKind(git, gitDir, sha, path);
    if (kind === undefined) {
      return undefined;
    }
    if (kind !== 'blob') {
      throw new NotAFileError(`${path} is a ${kind}, not a file, at ${sha}.`);
    }
    const outcome = await git(gitDir, ['cat-file', 'blob', `${sha}:${path}`]);
    if (!outcome.ok) {
      throw new SourceError(`Cannot read ${path} at ${sha}: ${outcome.stderr.trim()}`);
    }
    return outcome.stdout;
  };
}

const NOTHING_TO_RELEASE = async (): Promise<void> => {};

/** The guest's source: the clone URL, or a fresh snapshot of `sha` for a local repository. */
function guestSourceOf(spec: RepositorySpec, sha: string, options: HostSourceOptions) {
  const gitFor = (transport: GitTransport) =>
    createGit({
      cwd: options.cwd,
      env: options.env,
      lazyFetch: false,
      spawn: options.spawn,
      transport,
    });
  return async (): Promise<GuestSource> => {
    if (spec.kind === 'github') {
      return { location: { cloneUrl: spec.cloneUrl, kind: 'remote' }, release: NOTHING_TO_RELEASE };
    }
    try {
      const snapshot = await snapshotCommit(
        // The fetch from the repository's own git directory is the one call the file transport is for.
        { fileGit: gitFor('file'), git: gitFor('https') },
        gitOrThrow,
        spec.path,
        sha,
        options.tempDir,
      );
      return { location: { kind: 'local', path: snapshot.path }, release: snapshot.remove };
    } catch (error) {
      throw error instanceof SourceError
        ? error
        : new SourceError(`Cannot build the source snapshot: ${messageOf(error)}`);
    }
  };
}

/** Resolve `commit` in the repository and return a reader pinned to the resulting sha. */
export async function openHostSource(
  spec: RepositorySpec,
  commit: string,
  options: HostSourceOptions,
): Promise<HostSource> {
  const local = spec.kind === 'local';
  const git = createGit({
    cwd: options.cwd,
    env: options.env,
    lazyFetch: !local,
    spawn: options.spawn,
    transport: options.remoteTransport ?? 'https',
  });
  const repository = local
    ? await localRepository(git, spec.path)
    : await cachedClone(git, spec, options);
  if (!local && !looksLikeSha(commit)) {
    await repository.refresh();
  }
  // A branch or tag resolves through its own namespace, so the sha and the ref kind agree.
  const kind = await refKindOf(git, repository.gitDir, commit);
  const sha = await resolveSha(
    git,
    repository,
    kind === undefined ? commit : `${REF_PREFIXES[kind]}${commit}`,
  );
  return {
    guestSource: guestSourceOf(spec, sha, options),
    readFile: fileReader(git, repository.gitDir, sha),
    sha,
    ...(kind === undefined ? {} : { refKind: kind }),
  };
}
