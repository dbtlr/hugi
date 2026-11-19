/**
 * Reads a repository at a commit as data, on the host. Nothing from the repository runs here:
 * only `git` reads objects, under the hardening in `./git` (ADR-0002). A GitHub repository is read
 * through a bare partial clone in the cache, which only the user may write; a local repository is
 * read in place, with lazy fetching off, and reaches the guest as a snapshot (`./snapshot`). A pull
 * request is read at GitHub's merge commit, only after checking the merge is current (ADR-0005).
 */
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Host } from '@loomcli/core';

import { messageOf } from '../errors';
import type { PullRequestFacts } from '../github/pull-request';
import type { SourceLocation } from '../vm';
import { createGit } from './git';
import type { Git, GitTransport } from './git';
import type { GitHubRepositorySpec, RepositorySpec } from './repository-spec';
import { snapshotCommit } from './snapshot';

/** The repository could not be read: git failed, the commit is unknown, or a fetch failed. */
export class SourceError extends Error {
  override readonly name: string = 'SourceError';
}

/** Why a pull request has no current merge to run, in the order ADR-0005 checks its conditions. */
export type NoCurrentMergeReason = 'closed' | 'conflict' | 'not-computed' | 'moved';

/**
 * A pull request has no current merge, so it does not run: the run has no verdict, as for a commit
 * the source cannot fetch. The message names the first ADR-0005 condition that failed.
 */
export class NoCurrentMergeError extends SourceError {
  override readonly name = 'NoCurrentMergeError';
  readonly reason: NoCurrentMergeReason;

  constructor(reason: NoCurrentMergeReason, message: string) {
    super(message);
    this.reason = reason;
  }
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
  /** The full sha the commit argument resolved to; for a pull request, its merge commit. */
  readonly sha: string;
  /**
   * The file's text at the commit, or `undefined` when the commit has no such path. A path that
   * names a directory throws `NotAFileError`; a read git cannot complete throws `SourceError`.
   */
  readonly readFile: (path: string) => Promise<string | undefined>;
  /**
   * The files the push or pull request changed, for a workflow's path filters (ADR-0004): a
   * commit's files against its first parent, every file of a root commit, and for a pull request
   * its head against the merge base of the head and the base tip. A failed read throws `SourceError`.
   */
  readonly changedFiles: () => Promise<readonly string[]>;
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

/** Reads a commit's message from the source's git, for GitHub's skip instructions (ADR-0004). */
export type CommitMessageReader = {
  /**
   * The full message of commit `sha` as git stores it, every byte after the header kept. `sha`
   * must be a full sha the source holds, such as a pull request's checked head; otherwise it
   * throws `SourceError`.
   */
  readonly commitMessage: (sha: string) => Promise<string>;
};

/** A source as an opener returns it: the commit's files, and the messages of commits it holds. */
export type OpenedSource = HostSource & CommitMessageReader;

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

/** The refs a refresh mirrors from the repository URL; a pull request's refs are fetched on their own. */
const MIRRORED_REFS = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'] as const;

/**
 * Bare, blob-less clone: cheap to fetch, and enough to read the few files Hugi needs. A refresh
 * fetches from the repository's URL, never from a remote name the clone's config defines.
 */
async function cachedClone(
  git: Git,
  spec: GitHubRepositorySpec,
  options: HostSourceOptions,
): Promise<Repository> {
  const { cloneUrl, name } = spec;
  const { cacheDir, uid } = options;
  const reposDir = join(cacheDir, 'repos');
  const gitDir = join(reposDir, `${name.replace('/', '__')}.git`);
  const refresh = async () => {
    await gitOrThrow(git, gitDir, fetchArgs(cloneUrl, MIRRORED_REFS));
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

/** A fetch of `refspecs` from the repository's URL into the cached clone, keeping it blob-less. */
function fetchArgs(cloneUrl: string, refspecs: readonly string[]): string[] {
  return ['fetch', '--quiet', '--force', '--filter=blob:none', cloneUrl, ...refspecs];
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

/** A full sha, SHA-1 or SHA-256, so the argument git gets can never read as an option. */
const FULL_OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * Reads a commit's raw object: the header ends at the first empty line, and the message is
 * everything after it, byte for byte, so no format placeholder or separator can cut it short.
 */
function messageReader(git: Git, gitDir: string): CommitMessageReader['commitMessage'] {
  return async (sha) => {
    if (!FULL_OBJECT_NAME.test(sha)) {
      throw new SourceError(`"${sha}" is not a full commit sha, so its message is not read.`);
    }
    const object = await gitOrThrow(git, gitDir, ['cat-file', 'commit', sha]);
    const end = object.indexOf('\n\n');
    return end === -1 ? '' : object.slice(end + 2);
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

/** The hardened git for `spec`: lazy fetching only for a GitHub source, over its transport. */
function sourceGit(spec: RepositorySpec, options: HostSourceOptions): Git {
  return createGit({
    cwd: options.cwd,
    env: options.env,
    lazyFetch: spec.kind === 'github',
    spawn: options.spawn,
    transport: options.remoteTransport ?? 'https',
  });
}

/**
 * The paths that differ between two trees, read from the trees alone: no rename detection, so no
 * blob is fetched, and a renamed file lists both its old and new path. `from` undefined compares
 * a root commit with the empty tree.
 */
async function treeDiff(
  git: Git,
  repository: Repository,
  from: string | undefined,
  to: string,
): Promise<string[]> {
  const commits = from === undefined ? ['--root', to] : [from, to];
  const listing = await gitOrThrow(git, repository.gitDir, [
    'diff-tree',
    '-r',
    '-z',
    '--no-renames',
    '--no-commit-id',
    '--name-only',
    ...commits,
  ]);
  return listing.split('\0').filter((path) => path !== '');
}

/** A commit's changed files: against its first parent, or every file when it has none. */
function firstParentChanges(git: Git, repository: Repository, sha: string) {
  return async () => treeDiff(git, repository, (await parentsOf(git, repository, sha))[0], sha);
}

/** A pull request's changed files: the head against its merge base with the base tip. */
function threeDotChanges(git: Git, repository: Repository, baseTip: string, head: string) {
  return async () => {
    const base = (await gitOrThrow(git, repository.gitDir, ['merge-base', baseTip, head])).trim();
    return treeDiff(git, repository, base, head);
  };
}

/** The source pinned to `sha`: files read there, and the guest fetches that commit. */
function pinnedSource(
  spec: RepositorySpec,
  git: Git,
  repository: Repository,
  sha: string,
  options: HostSourceOptions,
  changedFiles: HostSource['changedFiles'],
): OpenedSource {
  return {
    changedFiles,
    commitMessage: messageReader(git, repository.gitDir),
    guestSource: guestSourceOf(spec, sha, options),
    readFile: fileReader(git, repository.gitDir, sha),
    sha,
  };
}

/** Resolve `commit` in the repository and return a reader pinned to the resulting sha. */
export async function openHostSource(
  spec: RepositorySpec,
  commit: string,
  options: HostSourceOptions,
): Promise<OpenedSource> {
  const git = sourceGit(spec, options);
  const repository =
    spec.kind === 'local'
      ? await localRepository(git, spec.path)
      : await cachedClone(git, spec, options);
  if (spec.kind === 'github' && !looksLikeSha(commit)) {
    await repository.refresh();
  }
  // A branch or tag resolves through its own namespace, so the sha and the ref kind agree.
  const kind = await refKindOf(git, repository.gitDir, commit);
  // The cache also holds pull requests' refs, which only `openPullRequestSource` may use: any other
  // name git could resolve, such as `pull/7/merge~0`, would run one past the merge checks (ADR-0005).
  if (spec.kind === 'github' && kind === undefined && !looksLikeSha(commit)) {
    throw new SourceError(
      `"${commit}" is not a sha, a branch, or a tag of ${spec.name}; run a pull request as pull/<n>.`,
    );
  }
  const sha = await resolveSha(
    git,
    repository,
    kind === undefined ? commit : `${REF_PREFIXES[kind]}${commit}`,
  );
  return {
    ...pinnedSource(spec, git, repository, sha, options, firstParentChanges(git, repository, sha)),
    ...(kind === undefined ? {} : { refKind: kind }),
  };
}

/** Conditions 1 and 2 of ADR-0005, from GitHub's facts alone: the merge commit GitHub reports. */
function reportedMerge(facts: PullRequestFacts): string {
  const pull = `Pull request ${facts.number}`;
  if (facts.state !== 'open') {
    throw new NoCurrentMergeError('closed', `${pull} is closed, so it does not run.`);
  }
  if (facts.mergeable === false) {
    throw new NoCurrentMergeError(
      'conflict',
      `${pull} has a merge conflict, so it does not run until the conflict is resolved.`,
    );
  }
  if (facts.mergeable === null || facts.mergeCommitSha === null) {
    throw notComputed(facts, 'GitHub reports no merge commit yet');
  }
  return facts.mergeCommitSha;
}

function notComputed(facts: PullRequestFacts, detail: string): NoCurrentMergeError {
  return new NoCurrentMergeError(
    'not-computed',
    `GitHub has not computed the merge for pull request ${facts.number}'s head ${facts.headSha} yet (${detail}); try again shortly.`,
  );
}

function moved(facts: PullRequestFacts, detail: string): NoCurrentMergeError {
  return new NoCurrentMergeError(
    'moved',
    `Pull request ${facts.number} moved while Hugi read it (${detail}); try again.`,
  );
}

/**
 * Fetch the pull request's merge and head refs into the cached clone. The merge ref comes first, as
 * condition 3 does, because git names the first refspec the remote lacks: a missing ref is the
 * matching condition failing, and any other failure is a plain `SourceError`.
 */
async function fetchPullRefs(
  git: Git,
  repository: Repository,
  spec: GitHubRepositorySpec,
  facts: PullRequestFacts,
) {
  const refs = { head: `refs/pull/${facts.number}/head`, merge: `refs/pull/${facts.number}/merge` };
  const outcome = await git(
    repository.gitDir,
    fetchArgs(spec.cloneUrl, [`+${refs.merge}:${refs.merge}`, `+${refs.head}:${refs.head}`]),
  );
  if (!outcome.ok) {
    const missing = /couldn't find remote ref (\S+)/u.exec(outcome.stderr)?.[1];
    if (missing === refs.merge) {
      throw notComputed(facts, `${spec.name} has no ${refs.merge}`);
    }
    if (missing === refs.head) {
      throw moved(facts, `${spec.name} has no ${refs.head}`);
    }
    throw new SourceError(
      `Cannot fetch pull request ${facts.number}'s refs: ${outcome.stderr.trim()}`,
    );
  }
  return refs;
}

/** The commit `ref` names in the cached clone. */
async function commitAt(git: Git, repository: Repository, ref: string): Promise<string> {
  return (
    await gitOrThrow(git, repository.gitDir, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ])
  ).trim();
}

/** The parents of `sha`, in order. */
async function parentsOf(git: Git, repository: Repository, sha: string): Promise<string[]> {
  const line = await gitOrThrow(git, repository.gitDir, ['rev-list', '--parents', '-n', '1', sha]);
  return line.trim().split(' ').slice(1);
}

/**
 * Open a pull request at GitHub's merge commit, given the facts GitHub's API reported for it. The
 * merge is used only when ADR-0005's five conditions hold: the pull request is open, GitHub reports
 * it mergeable with a merge commit, `refs/pull/<n>/merge` is that commit, `refs/pull/<n>/head` is
 * the reported head, and the merge commit has two parents, the second the head. Otherwise it throws
 * `NoCurrentMergeError` naming the first condition that failed.
 */
export async function openPullRequestSource(
  spec: GitHubRepositorySpec,
  facts: PullRequestFacts,
  options: HostSourceOptions,
): Promise<OpenedSource> {
  const reported = reportedMerge(facts);
  const git = sourceGit(spec, options);
  const repository = await cachedClone(git, spec, options);
  const refs = await fetchPullRefs(git, repository, spec, facts);
  const merge = await commitAt(git, repository, refs.merge);
  if (merge !== reported) {
    throw notComputed(facts, `${refs.merge} is ${merge}, not GitHub's merge commit ${reported}`);
  }
  const head = await commitAt(git, repository, refs.head);
  if (head !== facts.headSha) {
    throw moved(facts, `${refs.head} is ${head}, not the head GitHub reported`);
  }
  const parents = await parentsOf(git, repository, merge);
  if (parents.length !== 2 || parents[1] !== facts.headSha) {
    throw notComputed(facts, `${merge} is not a merge of the head into the base`);
  }
  // GitHub's merge commit has the base tip as its first parent and the head as its second.
  const changes = threeDotChanges(git, repository, parents[0]!, facts.headSha);
  return pinnedSource(spec, git, repository, merge, options, changes);
}
