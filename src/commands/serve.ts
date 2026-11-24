/**
 * `hugi serve`: the coordinator, run in the foreground until it is stopped, and installed as a
 * launchd user agent by `hugi service install` (README, "Running the coordinator"). The start
 * sequence is `startService` and the loop `runCoordinator`; `serveDeps` binds them to the leaf
 * ports (the host's spawn and paths, fetch, the VM runner, the clocks), so a test can replace each.
 */
import { Command } from '@loomcli/core';
import type { Host, Log } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';

import { loadConfig } from '../config/load';
import type { HugiConfig } from '../config/schema';
import { checkAppKey, createInstallationTokens, requireGitHubApp } from '../github/app-auth';
import type { InstallationTokens } from '../github/app-auth';
import { createGitHubReader, GitHubReadError } from '../github/client';
import type { GitHubReader } from '../github/client';
import type { Fetch, PullRequestFacts } from '../github/pull-request';
import { createStatusReporter, withDetailsLinks } from '../github/statuses';
import { pollRepositories } from '../queue/poll';
import { requireHostTools, SERVICE_HOST_TOOLS, spawnWithTools } from '../service/host-tools';
import { acquireServeLock } from '../service/lock';
import { runCoordinator } from '../service/loop';
import type { CoordinatorLog } from '../service/loop';
import { createRunCandidate } from '../service/run-candidate';
import type { RunCandidateDeps } from '../service/run-candidate';
import { startService } from '../service/start';
import type { StartDeps } from '../service/start';
import { writeServiceState } from '../service/state';
import { SERVICE_GIT_DEADLINE_MS } from '../source/git';
import { openHostSource, openPullRequestSource } from '../source/host-source';
import type { HostSourceOptions } from '../source/host-source';
import {
  resolveCacheDir,
  resolveConfigPath,
  resolveRunsDir,
  resolveServeLockPath,
  resolveServiceStateDir,
} from '../source/locations';
import { githubRepositorySpec } from '../source/repository-spec';
import type { GitHubRepositorySpec, RepositorySpec } from '../source/repository-spec';
import { systemClock } from '../vm/clock';
import { runInVm, SERVICE_VM_PREFIX } from '../vm/lifecycle';
import { sweepVms } from '../vm/sweep';
import type { Clock } from '../vm/tart';
import { createTartCli } from '../vm/tart-cli';
import { loadRunPage } from '../web/run-data';
import { openRunPageServer } from '../web/server';

const DESCRIPTION =
  'Run the coordinator: poll GitHub, run each lane that lacks a verdict, and post its status.';

const DETAILS = `hugi serve runs in the foreground until it is stopped; \`hugi service install\` runs it as a launchd user agent. It refuses to start, saying what to fix, when another hugi serve holds the lock, the configuration is refused, github_app or its key is unusable, or tart or git is not on its PATH, which \`hugi service install\` copies from the shell that installs it. It deletes every hugi-svc-* VM when it starts, runs one lane at a time, and writes its state for \`hugi service status\`. With \`web\` in the configuration it also serves a read-only page for each run on 127.0.0.1 at web.port, which each lane status's Details link opens. The README's "Running the coordinator" section has the rules.`;

/** A short random VM id: the `hugi-svc-` prefix plus 8 hex digits names the run's VM. */
const newVmId = () => crypto.randomUUID().slice(0, 8);

/** Where the service reads and writes. */
export type ServePaths = {
  readonly configPath: string;
  /** The service state's directory. */
  readonly stateDir: string;
  /** The single-instance lock. */
  readonly lockPath: string;
  readonly runsDir: string;
  /** The cache of bare clones. */
  readonly cacheDir: string;
};

/** The paths a service started with `--config <flag>` (or none) uses in this environment. */
export function servePaths(
  configFlag: string | undefined,
  env: Host['env'],
  home: string,
): ServePaths {
  return {
    cacheDir: resolveCacheDir(undefined, env, home),
    configPath: resolveConfigPath(configFlag, env, home),
    lockPath: resolveServeLockPath(home),
    runsDir: resolveRunsDir(env, home),
    stateDir: resolveServiceStateDir(env, home),
  };
}

/** The host facts and the one way the service starts a program. */
export type ServeHost = Pick<
  Host,
  'cwd' | 'env' | 'home' | 'platform' | 'spawn' | 'tmpdir' | 'uid'
>;

/** The leaf ports `serveDeps` binds the service to. */
export type ServePorts = {
  readonly host: ServeHost;
  readonly fetch: Fetch;
  /** The VM runner (`runInVm`). */
  readonly runInVm: typeof runInVm;
  /** The single-instance lock (`acquireServeLock`), which only darwin has. */
  readonly acquireServeLock: typeof acquireServeLock;
  /** The clock the loop, the VM runner and git's deadlines measure time on. */
  readonly clock: Clock;
  /** The wall clock, for the times written to the state and the run records. */
  readonly now: () => Date;
  readonly paths: ServePaths;
  /** This process's pid, which the lock and the state record. */
  readonly pid: number;
  /** Aborts when the service is asked to stop. */
  readonly signal: AbortSignal;
  readonly log: CoordinatorLog;
  readonly newVmId: () => string;
};

/** What the setup check found: the service's environment, and a spawn that runs tart and git by the paths found. */
export type ServeSetup = {
  readonly env: Record<string, string | undefined>;
  readonly spawn: Host['spawn'];
};

/** Check the App key, and find tart and git once on PATH, for the rest of the run. */
async function checkSetup(ports: ServePorts, config: HugiConfig): Promise<ServeSetup> {
  const { host } = ports;
  await checkAppKey(config, host);
  const env = { ...host.env };
  return {
    env,
    spawn: spawnWithTools(
      host.spawn,
      requireHostTools(
        env,
        SERVICE_HOST_TOOLS,
        undefined,
        'For the service, run hugi service install again from a shell whose PATH finds them.',
      ),
      env,
    ),
  };
}

/** How the service's git reads the cache and the network: each call bounded by its deadline. */
export function serviceSourceOptions(ports: ServePorts, setup: ServeSetup): HostSourceOptions {
  const { host } = ports;
  return {
    cacheDir: ports.paths.cacheDir,
    clock: ports.clock,
    cwd: host.cwd,
    deadlineMs: SERVICE_GIT_DEADLINE_MS,
    env: setup.env,
    platform: host.platform,
    spawn: setup.spawn,
    tempDir: host.tmpdir,
    uid: host.uid,
  };
}

/** The VM runner a candidate's run uses: VMs named `hugi-svc-<vmId>`, interrupted when the service stops. */
export function serviceRunInVm(
  ports: ServePorts,
  config: HugiConfig,
  setup: ServeSetup,
): RunCandidateDeps['runInVm'] {
  const tart = createTartCli(setup.spawn, ports.clock);
  const resources = { cpus: config.vm.cpus, memoryMb: config.vm.memoryGb * 1024 };
  return (request, vmId) =>
    ports.runInVm(request, {
      clock: ports.clock,
      interrupt: ports.signal,
      newId: () => vmId,
      resources,
      tart,
      vmPrefix: SERVICE_VM_PREFIX,
      warn: (message) => ports.log.warn(message),
    });
}

/**
 * A `GitHubReader` that reads each repository with that repository's installation token. A read
 * GitHub answers 401 drops that repository's cached token, so the next read mints a fresh one
 * instead of failing until the cached token's refresh time (after an App reinstall, up to an hour).
 */
export function perRepositoryReader(fetch: Fetch, tokens: InstallationTokens): GitHubReader {
  const readers = new Map<string, GitHubReader>();
  const readerOf = (repository: string): GitHubReader => {
    let reader = readers.get(repository);
    if (reader === undefined) {
      reader = createGitHubReader({ fetch, token: tokens(repository) });
      readers.set(repository, reader);
    }
    return reader;
  };
  const read = async <Result>(
    repository: string,
    from: (reader: GitHubReader) => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await from(readerOf(repository));
    } catch (error) {
      if (error instanceof GitHubReadError && error.status === 401) {
        tokens.invalidate(repository);
      }
      throw error;
    }
  };
  return {
    commitStatuses: (repository, sha) => read(repository, (r) => r.commitStatuses(repository, sha)),
    defaultBranchHead: (repository) => read(repository, (r) => r.defaultBranchHead(repository)),
    openPullRequests: (repository) => read(repository, (r) => r.openPullRequests(repository)),
    pullRequest: (repository, number) => read(repository, (r) => r.pullRequest(repository, number)),
  };
}

/**
 * Run the coordinator: GitHub as the App, git and tart as the setup check found them. With a run
 * page (`detailsOrigin`), each lane status that carries a run id links to the run's page.
 */
async function coordinate(
  ports: ServePorts,
  config: HugiConfig,
  setup: ServeSetup,
  report: Parameters<typeof runCoordinator>[1]['report'],
  detailsOrigin: string | undefined,
): Promise<void> {
  const { fetch, host, log } = ports;
  const tokens = createInstallationTokens({
    app: requireGitHubApp(config),
    fetch,
    home: host.home,
    platform: host.platform,
    spawn: setup.spawn,
    uid: host.uid,
  });
  const github = perRepositoryReader(fetch, tokens);
  const reporterFor = (origin: string | undefined) => {
    const reporter = createStatusReporter({
      fetch,
      invalidate: (repository) => tokens.invalidate(repository),
      token: tokens,
    });
    return origin === undefined ? reporter : withDetailsLinks(reporter, origin);
  };
  const sourceOptions = serviceSourceOptions(ports, setup);
  // The poll and the run open sources the same way, so one binding serves both.
  const openSource = (spec: RepositorySpec, commit: string) =>
    openHostSource(spec, commit, sourceOptions);
  const openPullRequest = (spec: GitHubRepositorySpec, facts: PullRequestFacts) =>
    openPullRequestSource(spec, facts, sourceOptions);
  await runCoordinator(config, {
    clock: ports.clock,
    log,
    now: ports.now,
    poll: () =>
      pollRepositories(config, {
        github,
        openPullRequest: (repository, facts) =>
          openPullRequest(githubRepositorySpec(repository), facts),
        openPush: (repository, sha) => openSource(githubRepositorySpec(repository), sha),
      }),
    report,
    reporter: reporterFor(detailsOrigin),
    runCandidate: createRunCandidate({
      configPath: ports.paths.configPath,
      newVmId: ports.newVmId,
      now: ports.now,
      openPullRequestSource: openPullRequest,
      openSource,
      readPullRequest: (repository, number) => github.pullRequest(repository, number),
      runInVm: serviceRunInVm(ports, config, setup),
      runsDir: ports.paths.runsDir,
      warn: (message) => log.warn(message),
    }),
    signal: ports.signal,
  });
}

/** `startService`'s collaborators, bound to the ports. */
export function serveDeps(ports: ServePorts): StartDeps<ServeSetup> {
  const { host, log, paths, pid } = ports;
  return {
    acquireLock: () => ports.acquireServeLock(paths.lockPath, { pid, platform: host.platform }),
    checkSetup: (config) => checkSetup(ports, config),
    coordinate: (config, setup, report, detailsOrigin) =>
      coordinate(ports, config, setup, report, detailsOrigin),
    loadConfig: () => loadConfig(paths.configPath),
    log,
    now: ports.now,
    openRunPage: (web) =>
      openRunPageServer({
        loadRun: (runId) => loadRunPage(paths.runsDir, runId),
        log,
        now: ports.now,
        origin: web.url,
        port: web.port,
      }),
    pid,
    signal: ports.signal,
    sweep: (setup) => sweepVms(createTartCli(setup.spawn, ports.clock), SERVICE_VM_PREFIX),
    writeState: (state) => writeServiceState(paths.stateDir, state),
  };
}

const asCoordinatorLog = (log: Log): CoordinatorLog => ({
  error: (message) => log.error(message),
  info: (message) => log.info(message),
  warn: (message) => log.warn(message),
});

export function serveCommand() {
  return new Command('serve', { description: DESCRIPTION })
    .extend(helpCommand({ details: DETAILS }))
    .option('config', {
      description: 'The configuration file; default HUGI_CONFIG, else the XDG config directory.',
      type: 'string',
    })
    .action(async ({ host, log, options, signal }) => {
      // oxlint-disable-next-line @loomcli/host-bypass -- the lock records this process; Host has no pid
      const { pid } = process;
      await startService(
        serveDeps({
          acquireServeLock,
          clock: systemClock,
          fetch: (url, init) => fetch(url, init),
          host,
          log: asCoordinatorLog(log),
          newVmId,
          now: () => new Date(),
          paths: servePaths(options.config, host.env, host.home),
          pid,
          runInVm,
          signal,
        }),
      );
    });
}
