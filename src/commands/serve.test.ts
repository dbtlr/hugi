import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPair } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULTS } from '../config/schema';
import type { HugiConfig } from '../config/schema';
import { rejectionOf } from '../runs/testing';
import { acquireServeLock, ServeLockError } from '../service/lock';
import { openHostSource } from '../source/host-source';
import { githubRepositorySpec } from '../source/repository-spec';
import type { RunRequest, RunResult } from '../vm';
import { FakeClock, FakeSpawn, settle } from '../vm/fake-tart';
import type { FakeCommand } from '../vm/fake-tart';
import type { RunDeps } from '../vm/lifecycle';
import { serveDeps, servePaths, serviceRunInVm, serviceSourceOptions } from './serve';
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
  return { clock, ports, spawned };
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
  const { clock, ports } = portsOf(() => ({ hangs: true }));
  const setup = await serveDeps(ports).checkSetup(config);
  const options = { ...serviceSourceOptions(ports, setup), cacheDir: join(scratch, 'cache') };
  const progress: { failure?: Error } = {};
  const open = async () => {
    progress.failure = await rejectionOf(
      openHostSource(githubRepositorySpec('dbtlr/hugi'), 'a'.repeat(40), options),
    );
  };
  void open();
  // Ten minutes and the termination grace, on the fake clock.
  for (let minute = 0; minute < 12 && progress.failure === undefined; minute += 1) {
    clock.advance(60_000);
    // oxlint-disable-next-line no-await-in-loop -- the clock moves one step at a time
    await settle();
  }
  expect(progress.failure?.message).toContain('git timed out after 600 seconds');
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
