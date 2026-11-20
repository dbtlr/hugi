import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPair } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { stringify } from 'yaml';

import { DEFAULTS } from '../config/schema';
import { GitHubReadError } from '../github/client';
import type { InstallationTokens } from '../github/app-auth';
import type { HugiConfig } from '../config/schema';
import { rejectionOf } from '../runs/testing';
import { acquireServeLock, ServeLockError } from '../service/lock';
import { openHostSource } from '../source/host-source';
import { githubRepositorySpec } from '../source/repository-spec';
import type { RunRequest, RunResult } from '../vm';
import { advanceUntilSettled, FakeClock, FakeSpawn, settle } from '../vm/fake-tart';
import type { FakeCommand } from '../vm/fake-tart';
import type { RunDeps } from '../vm/lifecycle';
import {
  perRepositoryReader,
  serveDeps,
  servePaths,
  serviceRunInVm,
  serviceSourceOptions,
} from './serve';
import type { ServePaths, ServePorts } from './serve';

const makeKeyPair = promisify(generateKeyPair);
const { privateKey } = await makeKeyPair('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' });

let scratch: string;
let bin: string;
let config: HugiConfig;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'hugi-serve-'));
  bin = join(scratch, 'bin');
  await mkdir(bin);
  for (const tool of ['tart', 'git']) {
    // oxlint-disable-next-line no-await-in-loop -- two files
    await writeFile(join(bin, tool), '#!/bin/sh\n', { mode: 0o755 });
  }
  const keyPath = join(scratch, 'app.pem');
  await writeFile(keyPath, PEM, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  config = {
    allowlist: [],
    githubApp: { appId: 1, privateKeyPath: keyPath },
    path: [bin],
    pollIntervalSeconds: DEFAULTS.pollIntervalSeconds,
    repositories: ['dbtlr/hugi'],
    runs: { maxAgeDays: DEFAULTS.maxAgeDays, maxSizeGb: DEFAULTS.maxSizeGb },
    vm: { cpus: 6, memoryGb: 8 },
  };
});
afterEach(async () => {
  await rm(scratch, { force: true, recursive: true });
});

type Script = (command: string, args: readonly string[]) => FakeCommand;

/** Ports on a fake host: programs answer from `script`, and nothing reaches GitHub or a VM. */
function portsOf(script: Script = () => ({}), overrides: Partial<ServePorts> = {}) {
  const clock = new FakeClock();
  const spawned: string[] = [];
  // Each call's argument list as given, so a path with a space stays one argument.
  const argvs: string[][] = [];
  /** Each program started, by the command it was started as, and the PATH it was given. */
  const started: { command: string; path: string | undefined }[] = [];
  let next: { command: string; args: readonly string[] } | undefined;
  const fake = new FakeSpawn(clock, (args) => script(next?.command ?? '', args));
  const ports: ServePorts = {
    acquireServeLock: () => Promise.reject(new Error('no lock in this test')),
    clock,
    fetch: () => Promise.reject(new Error('no GitHub in this test')),
    host: {
      cwd: scratch,
      env: { PATH: '/nowhere' },
      home: join(scratch, 'home'),
      platform: 'linux',
      spawn: (command, args, options) => {
        spawned.push([command, ...args].join(' '));
        argvs.push([...args]);
        started.push({ command, path: options?.env?.PATH });
        next = { args, command };
        return fake.spawn(command, args, options);
      },
      tmpdir: scratch,
      uid: process.getuid?.(),
    },
    log: { error: () => {}, info: () => {}, warn: () => {} },
    newVmId: () => 'id',
    now: () => new Date('2026-11-20T08:00:00.000Z'),
    paths: servePaths(undefined, {}, join(scratch, 'home')),
    pid: process.pid,
    runInVm: () => Promise.reject(new Error('no VM in this test')),
    signal: new AbortController().signal,
    ...overrides,
  };
  return { argvs, clock, ports, spawned, started };
}

const VM_LIST = JSON.stringify([
  { Name: 'hugi-svc-left' },
  { Name: 'hugi-run-mine' },
  { Name: 'golden' },
]);

const tartScript: Script = (_command, args) =>
  args[0] === 'list' ? { output: VM_LIST } : { exitCode: 0 };

describe('the setup check', () => {
  test('finds tart and git on `path` once, and the sweep runs that tart', async () => {
    const { ports, spawned } = portsOf(tartScript);
    const deps = serveDeps(ports);
    const setup = await deps.checkSetup(config);
    await deps.sweep(config, setup);
    expect(spawned[0]).toBe(`${join(bin, 'tart')} list --source local --format json`);
  });

  test('refuses a search path without tart or git', async () => {
    const { ports } = portsOf();
    const refusal = await rejectionOf(
      serveDeps(ports).checkSetup({ ...config, path: ['/nowhere'] }),
    );
    expect(refusal.message).toContain('tart, git');
  });
});

test('the sweep deletes only hugi-svc-* VMs', async () => {
  const { ports, spawned } = portsOf(tartScript);
  const deps = serveDeps(ports);
  const result = await deps.sweep(config, await deps.checkSetup(config));
  expect(result).toEqual({ deleted: ['hugi-svc-left'], failed: [] });
  expect(spawned.filter((each) => each.includes(' delete '))).toEqual([
    `${join(bin, 'tart')} delete hugi-svc-left`,
  ]);
});

test("the service's git calls end at the service's git deadline", async () => {
  const { clock, ports, started } = portsOf(() => ({ hangs: true }));
  const setup = await serveDeps(ports).checkSetup(config);
  const options = { ...serviceSourceOptions(ports, setup), cacheDir: join(scratch, 'cache') };
  const progress: { failure?: Error } = {};
  const open = async () => {
    progress.failure = await rejectionOf(
      openHostSource(githubRepositorySpec('dbtlr/hugi'), 'a'.repeat(40), options),
    );
  };
  void open();
  // The deadline starts with the spawn, so move the clock only once git has started.
  await until(() => started.some((each) => each.command.endsWith('git')));
  // Ten minutes and the termination grace, on the fake clock.
  for (let minute = 0; minute < 12 && progress.failure === undefined; minute += 1) {
    clock.advance(60_000);
    // oxlint-disable-next-line no-await-in-loop -- the clock moves one step at a time
    await settle();
  }
  expect(progress.failure?.message).toContain('git timed out after 600 seconds');
});

test("the service's git runs by the path found, with `path` as its PATH", async () => {
  const { ports, started } = portsOf(() => ({ exitCode: 128 }));
  const setup = await serveDeps(ports).checkSetup(config);
  const options = { ...serviceSourceOptions(ports, setup), cacheDir: join(scratch, 'cache') };
  await rejectionOf(openHostSource(githubRepositorySpec('dbtlr/hugi'), 'a'.repeat(40), options));
  expect(started[0]).toEqual({ command: join(bin, 'git'), path: bin });
});

const BRANCH_HEAD = 'a'.repeat(40);

/** GitHub for one enrolled repository with no open pull requests: the App's token and the reads a poll makes. */
const fakeGitHub: ServePorts['fetch'] = async (url) => {
  const path = new URL(url).pathname;
  if (path.endsWith('/installation')) {
    return Response.json({ id: 99 });
  }
  if (path.endsWith('/access_tokens')) {
    const expires = new Date(Date.now() + 3_600_000).toISOString();
    return Response.json({ expires_at: expires, token: 'ghs_test' }, { status: 201 });
  }
  const answers: Record<string, unknown> = {
    '/repos/dbtlr/hugi': { default_branch: 'main' },
    '/repos/dbtlr/hugi/branches/main': { commit: { commit: { message: 'm' }, sha: BRANCH_HEAD } },
    '/repos/dbtlr/hugi/pulls': [],
  };
  return path in answers ? Response.json(answers[path]) : new Response('', { status: 404 });
};

/** Wait, on the real clock and for at most a few seconds, until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 1000 && !condition(); tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls a condition the loop's I/O settles
    await Bun.sleep(2);
  }
}

/** The coordinator as `hugi serve` binds it, started on the fake host; git answers from `git`. */
async function startCoordinator(git: FakeCommand) {
  const stop = new AbortController();
  const warnings: string[] = [];
  const events: unknown[] = [];
  const log = {
    error: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
  };
  const { clock, ports, started } = portsOf((command) => (command.endsWith('git') ? git : {}), {
    fetch: fakeGitHub,
    log,
    signal: stop.signal,
  });
  const deps = serveDeps(ports);
  const setup = await deps.checkSetup(config);
  const progress = { ended: false };
  const coordinate = async () => {
    await deps.coordinate(config, setup, async (event) => {
      events.push(event);
    });
    progress.ended = true;
  };
  const ended = coordinate();
  return { clock, ended, events, progress, started, stop, warnings };
}

describe('the coordinator', () => {
  test("polls with the setup check's git and `path`, each git call within the service's deadline", async () => {
    const run = await startCoordinator({ hangs: true });
    const gitStarted = () => run.started.some((each) => each.command.endsWith('git'));
    await until(gitStarted);
    expect(run.started.find((each) => each.command.endsWith('git'))).toEqual({
      command: join(bin, 'git'),
      path: bin,
    });
    const timedOut = () =>
      run.warnings.some((each) => each.includes('timed out after 600 seconds'));
    // Ten minutes and the termination grace, on the fake clock.
    for (let minute = 0; minute < 12 && !timedOut(); minute += 1) {
      run.clock.advance(60_000);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves one step at a time
      await settle();
    }
    expect(timedOut()).toBe(true);
    run.stop.abort();
    for (let minute = 0; minute < 12 && !run.progress.ended; minute += 1) {
      run.clock.advance(60_000);
      // oxlint-disable-next-line no-await-in-loop -- the clock moves one step at a time
      await settle();
    }
    await run.ended;
  });

  test('ends when the service is asked to stop', async () => {
    const run = await startCoordinator({ exitCode: 128 });
    await until(() => run.events.length > 0);
    expect(run.events).toContainEqual(expect.objectContaining({ kind: 'poll-ended' }));
    run.stop.abort();
    await until(() => run.progress.ended);
    expect(run.progress.ended).toBe(true);
  });
});

const PR_HEAD = 'c'.repeat(40);
const PR_MERGE = 'd'.repeat(40);
const PR_BASE = 'e'.repeat(40);

/** A repository whose one lane, ci.yml's build, runs on a push to main and on a pull request. */
const LANE_FILES: Readonly<Record<string, string>> = {
  '.github/hugi.yaml': stringify({ lanes: [{ jobs: ['build'], workflow: 'ci.yml' }] }),
  '.github/workflows/ci.yml': stringify({
    jobs: { build: { 'runs-on': 'macos-latest', steps: [{ run: 'true' }] } },
    on: { pull_request: null, push: { branches: ['main'] } },
  }),
};

/** git's arguments after the hardening `-c` settings and the `--git-dir` scope. */
function gitCommandOf(args: readonly string[]): readonly string[] {
  const rest = [...args];
  while (rest[0] === '-c' || rest[0] === '--git-dir') {
    rest.splice(0, 2);
  }
  return rest;
}

/**
 * git over a cache that holds every commit: clones and fetches succeed, pull request 7's refs name
 * its head and merge, and the commits in `withLanes` hold `LANE_FILES` while the others hold none.
 */
function fakeGit(withLanes: readonly string[]): (args: readonly string[]) => FakeCommand {
  return (args) => {
    const [command = '', ...rest] = gitCommandOf(args);
    const last = rest.at(-1) ?? '';
    switch (command) {
      case 'rev-parse': {
        const name = last.replace('^{commit}', '');
        const refs: Record<string, string> = {
          'refs/pull/7/head': PR_HEAD,
          'refs/pull/7/merge': PR_MERGE,
        };
        return { output: `${refs[name] ?? name}\n` };
      }
      case 'show-ref': {
        return { exitCode: 1 };
      }
      case 'rev-list': {
        return {
          output: last === PR_MERGE ? `${last} ${PR_BASE} ${PR_HEAD}\n` : `${last} ${PR_BASE}\n`,
        };
      }
      case 'merge-base': {
        return { output: `${PR_BASE}\n` };
      }
      case 'ls-tree': {
        const sha = rest.at(-3) ?? '';
        return withLanes.includes(sha) && last in LANE_FILES ? { output: `blob ${last}\0` } : {};
      }
      case 'cat-file': {
        if (rest[0] === 'commit') {
          return { output: 'tree t\n\nA commit\n' };
        }
        const path = last.slice(last.indexOf(':') + 1);
        return { output: LANE_FILES[path] ?? '' };
      }
      default: {
        return {};
      }
    }
  };
}

/** GitHub for one enrolled repository, with pull request 7 open when `pull` is set; statuses post. */
function laneGitHub(pull: boolean): ServePorts['fetch'] {
  const pullRequest = {
    base: { ref: 'main' },
    head: { ref: 'feature', sha: PR_HEAD },
    merge_commit_sha: PR_MERGE,
    mergeable: true,
    number: 7,
    state: 'open',
    user: { login: 'dbtlr' },
  };
  return async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === 'POST' && path.includes('/statuses/')) {
      return Response.json({}, { status: 201 });
    }
    if (path.includes('/commits/') && path.endsWith('/status')) {
      return Response.json({ statuses: [] });
    }
    const answers: Record<string, unknown> = {
      '/repos/dbtlr/hugi/pulls': pull ? [pullRequest] : [],
      '/repos/dbtlr/hugi/pulls/7': pullRequest,
    };
    return path in answers ? Response.json(answers[path]) : fakeGitHub(url, init);
  };
}

/**
 * Run the coordinator as `hugi serve` binds it until its first candidate reaches the VM runner,
 * then stop it. Returns what the candidate's run started after the poll, and the VM runner's deps.
 */
async function runFirstCandidate(
  pull: boolean,
  withLanes: readonly string[],
  github: ServePorts['fetch'] = laneGitHub(pull),
) {
  const stop = new AbortController();
  const seen: { request: RunRequest; deps: RunDeps }[] = [];
  const runInVm = async (request: RunRequest, deps: RunDeps): Promise<RunResult> => {
    seen.push({ deps, request });
    stop.abort();
    return PASSED;
  };
  const git = fakeGit(withLanes);
  const { argvs, clock, ports, started } = portsOf(
    (command, args) => (command.endsWith('git') ? git(args) : { output: '[]' }),
    { fetch: github, runInVm, signal: stop.signal },
  );
  const deps = serveDeps(ports);
  const admitting = { ...config, allowlist: ['dbtlr'] };
  const setup = await deps.checkSetup(admitting);
  let polled = -1;
  const ended = deps.coordinate(admitting, setup, async (event) => {
    if (polled === -1 && (event as { kind: string }).kind === 'poll-ended') {
      polled = started.length;
    }
  });
  await until(() => seen.length > 0);
  const [first] = seen;
  if (first === undefined) {
    // Awaiting the coordinator would hang: stop it and fail now.
    stop.abort();
    throw new Error('no candidate reached the VM runner');
  }
  await advanceUntilSettled(clock, ended);
  return {
    first,
    paths: ports.paths,
    // What the run started, the poll's calls left out: each program, its PATH, and its arguments.
    runArgs: argvs.slice(polled).map((args) => gitCommandOf(args)),
    runStarted: started.slice(polled),
    signal: stop.signal,
    started,
  };
}

describe("a candidate's run, through the coordinator", () => {
  test.each(['push', 'pull_request'] as const)(
    "a %s candidate's git, tart and interrupt are the service's",
    async (kind) => {
      const pull = kind === 'pull_request';
      const run = await runFirstCandidate(pull, pull ? [PR_MERGE] : [BRANCH_HEAD]);
      expect(run.first.request.event.event).toBe(kind);
      // The run opened its own source: a pull request's run fetches its refs, a push's resolves the commit.
      expect(run.runArgs.map((args) => args[0])).toContain(pull ? 'fetch' : 'rev-parse');
      expect(run.runStarted.length).toBeGreaterThan(0);
      for (const each of run.runStarted) {
        expect(each).toEqual({ command: join(bin, 'git'), path: bin });
      }
      expect(run.first.deps.interrupt).toBe(run.signal);
      const before = run.started.length;
      await run.first.deps.tart.list();
      expect(run.started.slice(before)).toEqual([{ command: join(bin, 'tart'), path: bin }]);
    },
  );
});

describe('the coordinator after a run', () => {
  test("a service run's record lands in the runs directory", async () => {
    const run = await runFirstCandidate(false, [BRANCH_HEAD]);
    const runs = await readdir(run.paths.runsDir);
    expect(runs).toHaveLength(1);
    expect(await readdir(join(run.paths.runsDir, runs[0]!))).toContain('run.json');
  });

  test('a 401 on a status post drops that repository\'s token, so the next post mints another', async () => {
    let mints = 0;
    const rejecting: ServePorts['fetch'] = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/access_tokens')) {
        mints += 1;
      }
      return init?.method === 'POST' && path.includes('/statuses/')
        ? new Response('', { status: 401 })
        : laneGitHub(false)(url, init);
    };
    await runFirstCandidate(false, [BRANCH_HEAD], rejecting);
    // One token for the poll and the pending post, and a fresh one for the final post after its 401.
    expect(mints).toBe(2);
  });
});

describe('the reader of each repository', () => {
  /** Tokens named for their repository, and the repositories whose token was dropped. */
  function tokensOf() {
    const dropped: string[] = [];
    const tokens: InstallationTokens = Object.assign(
      (repository: string) => async () => `token-for-${repository}`,
      { invalidate: (repository: string) => void dropped.push(repository) },
    );
    return { dropped, tokens };
  }

  /** A fetch answering every read with `status` (an empty pull request list when 200), recording each bearer by path. */
  function answering(status: number) {
    const bearers: Record<string, string | null> = {};
    const fetch: ServePorts['fetch'] = async (url, init) => {
      bearers[new URL(url).pathname] = new Headers(init?.headers).get('authorization');
      return status === 200 ? Response.json([]) : new Response('{}', { status });
    };
    return { bearers, fetch };
  }

  test('reads each repository with its own repository’s token', async () => {
    const { bearers, fetch } = answering(200);
    const reader = perRepositoryReader(fetch, tokensOf().tokens);
    await reader.openPullRequests('dbtlr/first');
    await reader.openPullRequests('dbtlr/second');
    expect(bearers).toEqual({
      '/repos/dbtlr/first/pulls': 'Bearer token-for-dbtlr/first',
      '/repos/dbtlr/second/pulls': 'Bearer token-for-dbtlr/second',
    });
  });

  test('drops the repository’s token when GitHub answers a read 401', async () => {
    const { dropped, tokens } = tokensOf();
    const reader = perRepositoryReader(answering(401).fetch, tokens);
    expect(await rejectionOf(reader.openPullRequests('dbtlr/first'))).toBeInstanceOf(
      GitHubReadError,
    );
    expect(dropped).toEqual(['dbtlr/first']);
  });

  test('keeps the token when a read fails for another reason', async () => {
    const { dropped, tokens } = tokensOf();
    const reader = perRepositoryReader(answering(500).fetch, tokens);
    await rejectionOf(reader.openPullRequests('dbtlr/first'));
    expect(dropped).toEqual([]);
  });
});

const REQUEST: RunRequest = {
  event: { event: 'push', refName: 'main', refType: 'branch', repository: 'dbtlr/hugi', sha: 'a' },
  image: 'hugi-golden',
  logDir: '/runs/r1',
  plan: {
    env: {},
    lane: { job: 'test', matrix: {}, workflow: 'ci.yml' },
    name: 'test',
    steps: [],
    timeoutMinutes: 10,
  },
  source: { cloneUrl: 'https://github.com/dbtlr/hugi.git', kind: 'remote' },
  toolSource: 'workflow',
  tools: [],
};

const PASSED: RunResult = {
  reason: 'passed',
  steps: [],
  timings: { bootSeconds: 1, cloneSeconds: 1, totalSeconds: 3 },
  verdict: 'pass',
};

/** The deps a candidate's run hands the VM runner, through the service's binding. */
async function vmDepsOf(ports: ServePorts, withConfig: HugiConfig): Promise<RunDeps> {
  const seen: RunDeps[] = [];
  const runInVm = async (_request: RunRequest, deps: RunDeps): Promise<RunResult> => {
    seen.push(deps);
    return PASSED;
  };
  const withRunner = { ...ports, runInVm };
  const setup = await serveDeps(withRunner).checkSetup(withConfig);
  await serviceRunInVm(withRunner, withConfig, setup)(REQUEST, 'c0ffee12');
  const [deps] = seen;
  if (deps === undefined) {
    throw new Error('runInVm was not called');
  }
  return deps;
}

describe("a candidate's VM", () => {
  test('is named hugi-svc-<the candidate’s VM id> and sized by the configuration', async () => {
    const deps = await vmDepsOf(portsOf().ports, config);
    expect(`${deps.vmPrefix}${deps.newId()}`).toBe('hugi-svc-c0ffee12');
    expect(deps.resources).toEqual({ cpus: 6, memoryMb: 8192 });
  });

  test('is driven by the tart the setup check found, with `path` as its PATH', async () => {
    const { ports, started } = portsOf(tartScript);
    const deps = await vmDepsOf(ports, config);
    await deps.tart.list();
    expect(started).toEqual([{ command: join(bin, 'tart'), path: bin }]);
  });

  test('is interrupted when the service is asked to stop', async () => {
    const stop = new AbortController();
    const deps = await vmDepsOf(portsOf(undefined, { signal: stop.signal }).ports, config);
    expect(deps.interrupt.aborted).toBe(false);
    stop.abort();
    expect(deps.interrupt.aborted).toBe(true);
  });
});

/** The lock is darwin's `O_EXLOCK`, so a test of the real lock runs only there. */
const onDarwin = test.skipIf(process.platform !== 'darwin');

/** Ports on a darwin host that take the real lock, as `pid`, with these paths. */
function realLockPorts(pid: number, paths?: ServePaths): ServePorts {
  const { ports } = portsOf(undefined, { acquireServeLock, pid, ...(paths ? { paths } : {}) });
  return { ...ports, host: { ...ports.host, platform: 'darwin' } };
}

describe('the lock', () => {
  test('is taken at the lock path, as this pid, on this platform, and released', async () => {
    const taken: unknown[] = [];
    let released = 0;
    const acquire: ServePorts['acquireServeLock'] = async (path, holder) => {
      taken.push({ path, ...holder });
      return async () => {
        released += 1;
      };
    };
    const { ports } = portsOf(undefined, { acquireServeLock: acquire, pid: 4242 });
    const release = await serveDeps(ports).acquireLock();
    expect(taken).toEqual([
      {
        path: join(scratch, 'home', '.local', 'state', 'hugi', 'serve.lock'),
        pid: 4242,
        platform: 'linux',
      },
    ]);
    await release();
    expect(released).toBe(1);
  });

  onDarwin('a second service on the same host is refused the lock', async () => {
    const release = await serveDeps(realLockPorts(process.pid)).acquireLock();
    const second = serveDeps(realLockPorts(process.pid + 1));
    expect(await rejectionOf(second.acquireLock())).toBeInstanceOf(ServeLockError);
    await release();
  });

  onDarwin('a service started with another XDG_STATE_HOME contends for the same lock', async () => {
    const home = join(scratch, 'home');
    const elsewhere = servePaths(undefined, { XDG_STATE_HOME: join(scratch, 'elsewhere') }, home);
    expect(elsewhere.lockPath).toBe(join(home, '.local', 'state', 'hugi', 'serve.lock'));
    const release = await serveDeps(realLockPorts(process.pid)).acquireLock();
    const second = serveDeps(realLockPorts(process.pid + 1, elsewhere));
    expect(await rejectionOf(second.acquireLock())).toBeInstanceOf(ServeLockError);
    await release();
  });
});
