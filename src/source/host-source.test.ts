import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { processHandle } from '@loomcli/core';

import { messageOf } from '../errors';
import type { PullRequestFacts } from '../github/pull-request';
import {
  AmbiguousRefError,
  NoCurrentMergeError,
  NotAFileError,
  openHostSource,
  openPullRequestSource,
  SourceError,
} from './host-source';
import type { HostSourceOptions } from './host-source';

const handle = processHandle();
const hostOptions = (
  cacheDir: string,
  extra: Partial<HostSourceOptions> = {},
): HostSourceOptions => ({
  cacheDir,
  cwd: handle.cwd(),
  env: handle.env,
  spawn: (command, args, options) =>
    handle.spawn(command, args, { cwd: handle.cwd(), env: handle.env, ...options }),
  tempDir: tmpdir(),
  uid: handle.uid,
  ...extra,
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

let root: string;
let repo: string;
let first: string;
let second: string;

/** Runs a fixture's git in `repo`, unhardened: the tests build hostile repositories with it. */
async function git(...args: string[]): Promise<string> {
  return gitIn(repo, ...args);
}

async function gitIn(directory: string, ...args: string[]): Promise<string> {
  const exit = await handle.spawn('git', ['-C', directory, ...args], {
    cwd: handle.cwd(),
    // An inherited GIT_DIR (a git hook sets one) would point the fixture at another repository.
    env: {
      ...Object.fromEntries(
        Object.entries(handle.env).filter(([name]) => !name.startsWith('GIT_')),
      ),
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
    },
  }).exited;
  if (exit.kind !== 'exited' || exit.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed`);
  }
  return exit.stdout.text.trim();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hugi-source-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git('init', '--quiet', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('config', 'commit.gpgsign', 'false');
  await mkdir(join(repo, '.github', 'workflows'), { recursive: true });
  await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'first\n');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'first');
  first = await git('rev-parse', 'HEAD');
  await git('tag', 'v1');
  await git('branch', 'both');
  await git('tag', 'both');
  await git('config', 'uploadpack.allowFilter', 'true');
  await git('config', 'uploadpack.allowAnySHA1InWant', 'true');
  await writeFile(join(repo, '.github', 'workflows', 'ci.yml'), 'second\n');
  await git('commit', '--quiet', '-am', 'second');
  second = await git('rev-parse', 'HEAD');
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

const open = (commit: string) =>
  openHostSource({ kind: 'local', path: repo }, commit, hostOptions(join(root, 'cache')));

test('a branch resolves to the full sha of its tip', async () => {
  expect((await open('main')).sha).toBe(second);
});

test('a short sha and a tag resolve to the full sha', async () => {
  expect((await open(first.slice(0, 9))).sha).toBe(first);
  expect((await open('v1')).sha).toBe(first);
});

test('files are read at the commit, not the working tree', async () => {
  expect(await (await open(first)).readFile('.github/workflows/ci.yml')).toBe('first\n');
  expect(await (await open('main')).readFile('.github/workflows/ci.yml')).toBe('second\n');
});

test('a file absent at the commit reads as undefined', async () => {
  expect(await (await open('main')).readFile('rust-toolchain.toml')).toBeUndefined();
});

test('refKind says whether the commit argument named a branch, a tag, or neither', async () => {
  expect((await open('main')).refKind).toBe('branch');
  expect((await open('v1')).refKind).toBe('tag');
  expect((await open(first)).refKind).toBeUndefined();
});

test('an unknown commit is a source error', async () => {
  expect(await failureOf(open('nope'))).toBeInstanceOf(SourceError);
});

test('a path that is not a git repository is a source error', async () => {
  const failure = await failureOf(
    openHostSource({ kind: 'local', path: root }, 'main', hostOptions(join(root, 'cache'))),
  );
  expect(failure).toBeInstanceOf(SourceError);
});

test('a GitHub-style repository is read through a bare partial clone in the cache', async () => {
  const spec = { cloneUrl: `file://${repo}`, kind: 'github', name: 'example/project' } as const;
  const options = hostOptions(join(root, 'remote-cache'), { remoteTransport: 'file' });
  const source = await openHostSource(spec, 'main', options);
  expect(source.sha).toBe(second);
  expect(await source.readFile('.github/workflows/ci.yml')).toBe('second\n');
  expect(source.refKind).toBe('branch');
  // A later commit on the branch is seen by the next open of the same cache.
  await writeFile(join(repo, 'later.txt'), 'x');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'third');
  const again = await openHostSource(spec, 'main', options);
  expect(again.sha).toBe(await git('rev-parse', 'HEAD'));
});

test('a path that names a directory is not a file', async () => {
  const failure = await failureOf((await open('main')).readFile('.github/workflows'));
  expect(failure).toBeInstanceOf(NotAFileError);
});

test('a name that is both a branch and a tag is refused, whichever namespace git prefers', async () => {
  expect(await failureOf(open('both'))).toBeInstanceOf(AmbiguousRefError);
});

test('inherited GIT_* variables cannot redirect git to another repository', async () => {
  const other = join(root, 'other');
  await mkdir(other);
  await gitIn(other, 'init', '--quiet', '--initial-branch=main');
  await gitIn(other, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'x');
  const env = {
    ...handle.env,
    GIT_DIR: join(other, '.git'),
    GIT_OBJECT_DIRECTORY: join(other, '.git', 'objects'),
    GIT_WORK_TREE: other,
  };
  const source = await openHostSource(
    { kind: 'local', path: repo },
    'main',
    hostOptions(join(root, 'cache'), { env }),
  );
  expect(source.sha).toBe(await git('rev-parse', 'main'));
  expect(await source.readFile('.github/workflows/ci.yml')).toBe('second\n');
});

test('git runs with no inherited GIT_* variable and with system and global config ignored', async () => {
  const seen: Readonly<Record<string, string | undefined>>[] = [];
  const env = { ...handle.env, GIT_DIR: '/elsewhere', GIT_SSH_COMMAND: 'touch /nowhere' };
  const base = hostOptions(join(root, 'cache'), { env });
  await openHostSource({ kind: 'local', path: repo }, 'main', {
    ...base,
    spawn: (command, args, options) => {
      seen.push(options?.env ?? {});
      return base.spawn(command, args, options);
    },
  });
  expect(seen.length).toBeGreaterThan(0);
  for (const gitEnv of seen) {
    expect(gitEnv.GIT_DIR).toBeUndefined();
    expect(gitEnv.GIT_SSH_COMMAND).toBeUndefined();
    expect(gitEnv).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
  }
});

test("git runs in the C locale, so the messages Hugi reads do not depend on the user's language", async () => {
  const seen: Readonly<Record<string, string | undefined>>[] = [];
  const env = { ...handle.env, LANG: 'de_DE.UTF-8', LANGUAGE: 'de', LC_ALL: 'de_DE.UTF-8' };
  const base = hostOptions(join(root, 'cache'), { env });
  await openHostSource({ kind: 'local', path: repo }, 'main', {
    ...base,
    spawn: (command, args, options) => {
      seen.push(options?.env ?? {});
      return base.spawn(command, args, options);
    },
  });
  expect(seen.length).toBeGreaterThan(0);
  for (const gitEnv of seen) {
    expect(gitEnv).toMatchObject({ LANGUAGE: 'C', LC_ALL: 'C' });
  }
});

test("a local partial clone never runs its promisor remote's upload-pack", async () => {
  const partial = join(root, 'partial');
  const marker = join(root, 'partial-marker');
  await gitIn(
    root,
    'clone',
    '--quiet',
    '--no-checkout',
    '--filter=blob:none',
    `file://${repo}`,
    partial,
  );
  await gitIn(partial, 'config', 'remote.origin.uploadpack', `touch ${marker}; git-upload-pack`);
  const source = await openHostSource(
    { kind: 'local', path: partial },
    second,
    hostOptions(join(root, 'cache')),
  );
  // The blob is missing locally; reading it must fail rather than fetch it.
  const failure = await failureOf(source.readFile('.github/workflows/ci.yml'));
  expect(failure).toBeInstanceOf(SourceError);
  expect(await exists(marker)).toBe(false);
});

/** A bare partial clone planted where the cache keeps `example/planted`. */
async function plantCacheClone(cacheDir: string, marker: string): Promise<string> {
  const gitDir = join(cacheDir, 'repos', 'example__planted.git');
  await mkdir(join(cacheDir, 'repos'), { recursive: true });
  await gitIn(root, 'clone', '--quiet', '--bare', '--filter=blob:none', `file://${repo}`, gitDir);
  await gitIn(gitDir, 'config', 'remote.origin.uploadpack', `touch ${marker}; git-upload-pack`);
  return gitDir;
}

const planted = {
  cloneUrl: `https://github.com/example/planted.git`,
  kind: 'github',
  name: 'example/planted',
} as const;

test("a planted cache clone's alternate-refs command never runs", async () => {
  const cacheDir = join(root, 'alternates-cache');
  const marker = join(root, 'alternates-marker');
  const upstream = join(root, 'alternates-upstream');
  const commit = (message: string) =>
    gitIn(
      upstream,
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      message,
    );
  await mkdir(upstream);
  await gitIn(upstream, 'init', '--quiet', '--initial-branch=main');
  await commit('one');
  const gitDir = join(cacheDir, 'repos', 'example__planted.git');
  await mkdir(join(cacheDir, 'repos'), { recursive: true });
  await gitIn(root, 'clone', '--quiet', '--bare', `file://${upstream}`, gitDir);
  await writeFile(
    join(gitDir, 'objects', 'info', 'alternates'),
    `${join(repo, '.git', 'objects')}\n`,
  );
  await gitIn(gitDir, 'config', 'core.alternateRefsCommand', `touch ${marker}; true`);
  // A new upstream commit makes the refresh negotiate, which is where git runs the command.
  await commit('two');
  const spec = { ...planted, cloneUrl: `file://${upstream}` };
  await failureOf(openHostSource(spec, 'main', hostOptions(cacheDir, { remoteTransport: 'file' })));
  expect(await exists(marker)).toBe(false);
});

test("a planted cache clone's hostile upload-pack never runs", async () => {
  const cacheDir = join(root, 'planted-cache');
  const marker = join(root, 'planted-marker');
  await plantCacheClone(cacheDir, marker);
  // A full sha needs no refresh; the missing blob would be fetched lazily from the planted origin.
  const source = await openHostSource(planted, second, hostOptions(cacheDir));
  expect(await failureOf(source.readFile('.github/workflows/ci.yml'))).toBeInstanceOf(SourceError);
  expect(await exists(marker)).toBe(false);
});

test("a refresh fetches from the repository URL, not the cache clone's configured remote", async () => {
  const cacheDir = join(root, 'redirected-cache');
  const marker = join(root, 'redirected-marker');
  const gitDir = await plantCacheClone(cacheDir, marker);
  const decoy = join(root, 'decoy');
  await mkdir(decoy);
  await gitIn(decoy, 'init', '--quiet', '--initial-branch=main');
  await gitIn(
    decoy,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    'decoy',
  );
  await gitIn(gitDir, 'config', 'remote.origin.url', `file://${decoy}`);
  const spec = { ...planted, cloneUrl: `file://${repo}` };
  const source = await openHostSource(
    spec,
    'main',
    hostOptions(cacheDir, { remoteTransport: 'file' }),
  );
  expect(source.sha).toBe(await git('rev-parse', 'main'));
  expect(await exists(marker)).toBe(false);
});

test('a cache clone that others can write is refused', async () => {
  const cacheDir = join(root, 'shared-cache');
  const gitDir = await plantCacheClone(cacheDir, join(root, 'shared-marker'));
  await chmod(gitDir, 0o775);
  const failure = await failureOf(openHostSource(planted, second, hostOptions(cacheDir)));
  expect(failure).toBeInstanceOf(SourceError);
  expect(failure instanceof Error && failure.message).toContain('writable');
});

test('a new cache directory is private to the user', async () => {
  const cacheDir = join(root, 'fresh-cache');
  const spec = { cloneUrl: `file://${repo}`, kind: 'github', name: 'example/fresh' } as const;
  await openHostSource(spec, 'main', hostOptions(cacheDir, { remoteTransport: 'file' }));
  expect((await stat(cacheDir)).mode & 0o777).toBe(0o700);
  expect((await stat(join(cacheDir, 'repos'))).mode & 0o777).toBe(0o700);
});

test('a global insteadOf rewrite cannot send a GitHub fetch through another transport', async () => {
  const marker = join(root, 'insteadof-marker');
  const globalConfig = join(root, 'global.gitconfig');
  await writeFile(
    globalConfig,
    `[protocol "ext"]\n\tallow = always\n[url "ext::sh -c touch% ${marker}% #"]\n\tinsteadOf = https://hugi.invalid/\n`,
  );
  const spec = {
    cloneUrl: 'https://hugi.invalid/example/project.git',
    kind: 'github',
    name: 'example/rewritten',
  } as const;
  const env = { ...handle.env, GIT_CONFIG_GLOBAL: globalConfig };
  const failure = await failureOf(
    openHostSource(spec, 'main', hostOptions(join(root, 'insteadof-cache'), { env })),
  );
  expect(failure).toBeInstanceOf(SourceError);
  expect(await exists(marker)).toBe(false);
});

/** Every file under `directory`, as paths relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

describe('a local source reaches the guest as a snapshot holding only the commit', () => {
  let project: string;
  let commit: string;

  beforeAll(async () => {
    project = join(root, 'snapshot-project');
    await mkdir(join(project, 'nested'), { recursive: true });
    await gitIn(project, 'init', '--quiet', '--initial-branch=main');
    await writeFile(join(project, 'nested', 'tracked.txt'), 'old\n');
    await gitIn(project, 'add', '-A');
    await gitIn(project, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'old');
    await gitIn(project, 'tag', 'old-tag');
    await writeFile(join(project, 'nested', 'tracked.txt'), 'new\n');
    await gitIn(project, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-am', 'new');
    commit = await gitIn(project, 'rev-parse', 'HEAD');
    await gitIn(project, 'branch', 'other-branch');
    await gitIn(project, 'remote', 'add', 'origin', 'https://token@example.invalid/secret.git');
    await writeFile(join(project, '.env'), 'HUGI_TEST_SECRET=hunter2\n');
    await gitIn(project, 'worktree', 'add', '--quiet', join(root, 'snapshot-worktree'), 'main~1');
  });

  async function snapshotOf(path: string) {
    const source = await openHostSource({ kind: 'local', path }, commit, {
      ...hostOptions(join(root, 'cache')),
      tempDir: root,
    });
    return source.guestSource();
  }

  test.each([
    ['the repository root', () => project],
    ['a linked worktree', () => join(root, 'snapshot-worktree')],
    ['a subdirectory', () => join(project, 'nested')],
  ])('from %s, the snapshot holds the commit at depth 1', async (_name, path) => {
    const guest = await snapshotOf(path());
    try {
      expect(guest.location.kind).toBe('local');
      const snapshot = guest.location.kind === 'local' ? guest.location.path : '';
      expect(snapshot.startsWith(root)).toBe(true);
      expect(await gitIn(snapshot, 'rev-parse', `${commit}^{commit}`)).toBe(commit);
      expect(await gitIn(snapshot, 'cat-file', 'blob', `${commit}:nested/tracked.txt`)).toBe('new');
      expect(await gitIn(snapshot, 'rev-list', '--count', commit)).toBe('1');
    } finally {
      await guest.release();
    }
  });

  test('the snapshot has no untracked file, no remote URL, no other ref, and no host path', async () => {
    const guest = await snapshotOf(project);
    try {
      const snapshot = guest.location.kind === 'local' ? guest.location.path : '';
      expect(await gitIn(snapshot, 'for-each-ref', '--format=%(refname)')).toBe(
        'refs/heads/snapshot',
      );
      const files = await filesUnder(snapshot);
      expect(files.some((file) => file.endsWith('.env'))).toBe(false);
      for (const file of files) {
        // oxlint-disable-next-line no-await-in-loop -- a handful of small files
        const text = await readFile(join(snapshot, file), 'latin1');
        expect(text).not.toContain('example.invalid');
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain(project);
      }
    } finally {
      await guest.release();
    }
  });

  test('release removes the snapshot', async () => {
    const guest = await snapshotOf(project);
    const snapshot = guest.location.kind === 'local' ? guest.location.path : '';
    expect(await exists(snapshot)).toBe(true);
    await guest.release();
    expect(await exists(snapshot)).toBe(false);
  });

  test('a commit the repository cannot hand over leaves no snapshot behind', async () => {
    const scratch = await mkdtemp(join(root, 'failed-snapshot-'));
    const source = await openHostSource({ kind: 'local', path: project }, commit, {
      ...hostOptions(join(root, 'cache')),
      tempDir: scratch,
    });
    await rm(join(project, '.git', 'objects', commit.slice(0, 2), commit.slice(2)), {
      force: true,
    });
    const failure = await failureOf(source.guestSource());
    expect(failure).toBeInstanceOf(SourceError);
    expect(await readdir(scratch)).toEqual([]);
  });
});

test('a GitHub source reaches the guest by its clone URL, with nothing to remove', async () => {
  const spec = { cloneUrl: `file://${repo}`, kind: 'github', name: 'example/project' } as const;
  const options = hostOptions(join(root, 'remote-cache'), { remoteTransport: 'file' });
  const guest = await (await openHostSource(spec, 'main', options)).guestSource();
  expect(guest.location).toEqual({ cloneUrl: `file://${repo}`, kind: 'remote' });
  await guest.release();
});

test('a snapshot directory that cannot be created is a source error', async () => {
  const source = await openHostSource({ kind: 'local', path: repo }, 'main', {
    ...hostOptions(join(root, 'cache')),
    tempDir: join(root, 'no-such-directory'),
  });
  expect(await failureOf(source.guestSource())).toBeInstanceOf(SourceError);
});

/** A fresh repository under the fixture root with one commit of `files`; returns its path and sha. */
async function committedRepo(name: string, files: Record<string, string>) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await gitIn(path, 'init', '--quiet', '--initial-branch=main');
  await Promise.all(
    Object.entries(files).map(async ([file, text]) => {
      await mkdir(join(path, file, '..'), { recursive: true });
      await writeFile(join(path, file), text);
    }),
  );
  await gitIn(path, 'add', '-A');
  await gitIn(path, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', name);
  return { path, sha: await gitIn(path, 'rev-parse', 'HEAD') };
}

test('git never reads the home directory, so a .netrc there cannot authenticate a fetch', async () => {
  const seen: Readonly<Record<string, string | undefined>>[] = [];
  const env = { ...handle.env, HOME: join(root, 'operator-home') };
  const base = hostOptions(join(root, 'cache'), { env });
  await openHostSource({ kind: 'local', path: repo }, 'main', {
    ...base,
    spawn: (command, args, options) => {
      seen.push(options?.env ?? {});
      return base.spawn(command, args, options);
    },
  });
  expect(seen.length).toBeGreaterThan(0);
  for (const gitEnv of seen) {
    expect(gitEnv.HOME).toBe('/dev/null');
  }
});

test('every git call resets http.extraHeader, so no header from a clone config is sent', async () => {
  const calls: (readonly string[])[] = [];
  const base = hostOptions(join(root, 'cache'));
  await openHostSource({ kind: 'local', path: repo }, 'main', {
    ...base,
    spawn: (command, args, options) => {
      calls.push(args);
      return base.spawn(command, args, options);
    },
  });
  expect(calls.length).toBeGreaterThan(0);
  for (const args of calls) {
    expect(args.join(' ')).toContain('-c http.extraHeader=');
  }
});

test('a replacement ref cannot make the host read another commit than the snapshot holds', async () => {
  const replaced = join(root, 'replaced');
  await gitIn(root, 'clone', '--quiet', repo, replaced);
  await gitIn(replaced, 'replace', first, second);
  const source = await openHostSource({ kind: 'local', path: replaced }, first, {
    ...hostOptions(join(root, 'cache')),
  });
  expect(await source.readFile('.github/workflows/ci.yml')).toBe('first\n');
});

test('a file whose path has a space reads by its full path', async () => {
  const spaced = await committedRepo('spaced', { 'build files/tools': 'bun 1.4.4\n' });
  const source = await openHostSource({ kind: 'local', path: spaced.path }, spaced.sha, {
    ...hostOptions(join(root, 'cache')),
  });
  expect(await source.readFile('build files/tools')).toBe('bun 1.4.4\n');
});

test('a cache directory that cannot be created is a source error', async () => {
  const blocker = join(root, 'cache-is-a-file');
  await writeFile(blocker, '');
  const spec = { cloneUrl: `file://${repo}`, kind: 'github', name: 'example/blocked' } as const;
  const failure = await failureOf(
    openHostSource(spec, 'main', hostOptions(blocker, { remoteTransport: 'file' })),
  );
  expect(failure).toBeInstanceOf(SourceError);
  expect(failure instanceof Error && failure.message).toContain(blocker);
});

test('a repository whose path has a percent escape snapshots from that literal path', async () => {
  const escaped = await committedRepo('percent%20dir', { 'a.txt': 'a\n' });
  const source = await openHostSource({ kind: 'local', path: escaped.path }, escaped.sha, {
    ...hostOptions(join(root, 'cache')),
    tempDir: root,
  });
  const guest = await source.guestSource();
  try {
    const snapshot = guest.location.kind === 'local' ? guest.location.path : '';
    expect(await gitIn(snapshot, 'rev-parse', `${escaped.sha}^{commit}`)).toBe(escaped.sha);
  } finally {
    await guest.release();
  }
});

const pullsOptions = () => hostOptions(join(root, 'pulls-cache'), { remoteTransport: 'file' });

describe('a pull request opens at its merge commit only when the merge is current', () => {
  let upstream: string;
  let head: string;
  let merge: string;
  let staleMerge: string;
  let foreignMerge: string;
  let mainTip: string;
  let baseTip: string;
  const spec = () =>
    ({ cloneUrl: `file://${upstream}`, kind: 'github', name: 'example/pulls' }) as const;

  /** A three-parent commit whose second parent is `secondParent`, as no GitHub merge ever is. */
  async function octopusOf(firstParent: string, secondParent: string, thirdParent: string) {
    const merged = await mergeOf(firstParent, secondParent);
    const tree = await gitIn(upstream, 'rev-parse', `${merged}^{tree}`);
    return gitIn(
      upstream,
      'commit-tree',
      tree,
      '-p',
      firstParent,
      '-p',
      secondParent,
      '-p',
      thirdParent,
      '-m',
      'octopus',
    );
  }

  /** A two-parent merge commit of `first` and `second`, with the tree git merges them to. */
  async function mergeOf(firstParent: string, secondParent: string) {
    const tree = (
      await gitIn(upstream, 'merge-tree', '--write-tree', firstParent, secondParent)
    ).split('\n')[0]!;
    return gitIn(
      upstream,
      'commit-tree',
      tree,
      '-p',
      firstParent,
      '-p',
      secondParent,
      '-m',
      `Merge ${secondParent} into ${firstParent}`,
    );
  }

  beforeAll(async () => {
    const created = await committedRepo('pulls', { 'base.txt': 'base\n' });
    upstream = created.path;
    baseTip = created.sha;
    await gitIn(upstream, 'config', 'uploadpack.allowFilter', 'true');
    await gitIn(upstream, 'checkout', '--quiet', '-b', 'feature');
    await writeFile(join(upstream, 'feature.txt'), 'feature\n');
    await gitIn(upstream, 'add', '-A');
    await gitIn(upstream, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'feature');
    head = await gitIn(upstream, 'rev-parse', 'HEAD');
    await gitIn(upstream, 'checkout', '--quiet', 'main');
    await writeFile(join(upstream, 'main.txt'), 'main\n');
    await gitIn(upstream, 'add', '-A');
    await gitIn(upstream, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'main');
    mainTip = await gitIn(upstream, 'rev-parse', 'HEAD');
    merge = await mergeOf(mainTip, head);
    staleMerge = await mergeOf(baseTip, head);
    foreignMerge = await mergeOf(baseTip, mainTip);
    const refs: [string, string][] = [
      ['refs/pull/7/head', head],
      ['refs/pull/7/merge', merge],
      ['refs/pull/8/head', head],
      ['refs/pull/9/merge', merge],
      ['refs/pull/10/head', head],
      ['refs/pull/10/merge', staleMerge],
      ['refs/pull/11/head', head],
      ['refs/pull/11/merge', foreignMerge],
      ['refs/pull/12/head', head],
      ['refs/pull/12/merge', mainTip],
      ['refs/pull/13/head', head],
      ['refs/pull/13/merge', await octopusOf(mainTip, head, baseTip)],
      ['refs/pull/14/head', head],
      ['refs/pull/14/merge', await mergeOf(head, mainTip)],
    ];
    for (const [ref, sha] of refs) {
      // oxlint-disable-next-line no-await-in-loop -- one ref at a time keeps git's ref locks apart
      await gitIn(upstream, 'update-ref', ref, sha);
    }
  });

  /** Pull request `number` as GitHub reports it when its merge is current. */
  const current = (
    number: number,
    overrides: Partial<PullRequestFacts> = {},
  ): PullRequestFacts => ({
    baseRef: 'main',
    headRef: 'feature',
    headSha: head,
    mergeCommitSha: merge,
    mergeable: true,
    number,
    state: 'open',
    ...overrides,
  });

  /** The reason `openPullRequestSource` refuses `facts` for, with its message. */
  async function refusal(facts: PullRequestFacts, extra: Partial<HostSourceOptions> = {}) {
    const failure = await failureOf(
      openPullRequestSource(spec(), facts, { ...pullsOptions(), ...extra }),
    );
    expect(failure).toBeInstanceOf(SourceError);
    if (!(failure instanceof NoCurrentMergeError)) {
      throw new Error(`expected NoCurrentMergeError, got ${String(failure)}`);
    }
    return { message: failure.message, reason: failure.reason };
  }

  test('a current merge pins the source to the merge commit, read with both sides', async () => {
    const source = await openPullRequestSource(spec(), current(7), pullsOptions());
    expect(source.sha).toBe(merge);
    expect(source.refKind).toBeUndefined();
    expect(await source.readFile('feature.txt')).toBe('feature\n');
    expect(await source.readFile('main.txt')).toBe('main\n');
    const guest = await source.guestSource();
    expect(guest.location).toEqual({ cloneUrl: `file://${upstream}`, kind: 'remote' });
  });

  test('a closed pull request is refused before any git runs', async () => {
    let spawned = 0;
    const base = pullsOptions();
    const { message, reason } = await refusal(current(7, { state: 'closed' }), {
      spawn: (command, args, spawnOptions) => {
        spawned += 1;
        return base.spawn(command, args, spawnOptions);
      },
    });
    expect(reason).toBe('closed');
    expect(message).toContain('is closed');
    expect(spawned).toBe(0);
  });

  test('a pull-request ref left in the cache cannot be run by any name, past the merge checks', async () => {
    await openPullRequestSource(spec(), current(7), pullsOptions());
    const names = [
      'pull/7/merge',
      'refs/pull/7/merge',
      'pull/7/head',
      'pull/7/merge~0',
      'pull/7/merge^0',
      'pull/7/merge^{}',
      'refs/pull/7/merge^{commit}',
      'pull/7/head~0',
      'main~0',
    ];
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop -- each name opens the same cache in turn
      const failure = await failureOf(openHostSource(spec(), name, pullsOptions()));
      expect(failure).toBeInstanceOf(SourceError);
      expect(messageOf(failure)).toContain('not a sha, a branch, or a tag');
    }
  });

  test('a pull request with a merge conflict is refused', async () => {
    const { message, reason } = await refusal(
      current(7, { mergeCommitSha: null, mergeable: false }),
    );
    expect(reason).toBe('conflict');
    expect(message).toContain('merge conflict');
  });

  test.each([
    ['mergeable is null', { mergeable: null }],
    ['merge_commit_sha is null', { mergeCommitSha: null }],
  ] as const)('a pull request whose %s has no computed merge', async (_name, overrides) => {
    const { message, reason } = await refusal(current(7, overrides));
    expect(reason).toBe('not-computed');
    expect(message).toContain('has not computed the merge');
  });

  test('a stale merge ref that merges the head but is not merge_commit_sha is refused', async () => {
    const { message, reason } = await refusal(current(10));
    expect(reason).toBe('not-computed');
    expect(message).toContain('has not computed the merge');
    expect(message).toContain(staleMerge);
  });

  test('a conflict is refused even while GitHub still reports an old merge commit', async () => {
    const { reason } = await refusal(current(7, { mergeable: false }));
    expect(reason).toBe('conflict');
  });

  test('a pull request with neither ref is a merge GitHub has not computed', async () => {
    const { reason } = await refusal(current(99));
    expect(reason).toBe('not-computed');
  });

  test.each([
    ['with three parents', 13],
    ['whose head is its first parent', 14],
  ] as const)(
    'a merge %s, though it has the head as a parent, is refused',
    async (_name, number) => {
      const sha = await gitIn(upstream, 'rev-parse', `refs/pull/${number}/merge`);
      const { reason } = await refusal(current(number, { mergeCommitSha: sha }));
      expect(reason).toBe('not-computed');
    },
  );

  test('a missing merge ref is a merge GitHub has not computed', async () => {
    const { reason } = await refusal(current(8));
    expect(reason).toBe('not-computed');
  });

  test('a head ref that is not the head GitHub reported means the pull request moved', async () => {
    const { message, reason } = await refusal(current(7, { headSha: mainTip }));
    expect(reason).toBe('moved');
    expect(message).toContain('moved while Hugi read it');
  });

  test('a missing head ref means the pull request moved', async () => {
    const { reason } = await refusal(current(9));
    expect(reason).toBe('moved');
  });

  test.each([
    ['whose second parent is not the head', 11, () => foreignMerge],
    ['with one parent', 12, () => mainTip],
  ] as const)('a merge ref %s is not a computed merge of the head', async (_name, number, sha) => {
    const { message, reason } = await refusal(current(number, { mergeCommitSha: sha() }));
    expect(reason).toBe('not-computed');
    expect(message).toContain('has not computed the merge');
  });
});
