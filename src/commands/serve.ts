/**
 * `hugi serve`: the coordinator, run in the foreground until it is stopped, and installed as a
 * launchd user agent by `hugi service install` (README, "Running the coordinator"). This file only
 * binds the real collaborators: the start sequence is `startService`, the loop `runCoordinator`.
 */
import { Command } from '@loomcli/core';
import type { Host, Log } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';

import { loadConfig } from '../config/load';
import type { HugiConfig } from '../config/schema';
import { checkAppKey, createInstallationTokens, requireGitHubApp } from '../github/app-auth';
import type { InstallationTokens } from '../github/app-auth';
import { createGitHubReader } from '../github/client';
import type { GitHubReader } from '../github/client';
import { createStatusReporter } from '../github/statuses';
import { pollRepositories } from '../queue/poll';
import { hostEnv, requireHostTools, spawnWithTools } from '../service/host-tools';
import { acquireServeLock, createServeLockDeps } from '../service/lock';
import { runCoordinator } from '../service/loop';
import type { CoordinatorLog } from '../service/loop';
import { createRunCandidate } from '../service/run-candidate';
import { startService } from '../service/start';
import { writeServiceState } from '../service/state';
import { SERVICE_GIT_DEADLINE_MS } from '../source/git';
import { openHostSource, openPullRequestSource } from '../source/host-source';
import type { HostSourceOptions } from '../source/host-source';
import {
  resolveCacheDir,
  resolveConfigPath,
  resolveRunsDir,
  resolveServiceStateDir,
} from '../source/locations';
import { parseRepository } from '../source/repository-spec';
import type { GitHubRepositorySpec } from '../source/repository-spec';
import { systemClock } from '../vm/clock';
import { runInVm, SERVICE_VM_PREFIX } from '../vm/lifecycle';
import { sweepVms } from '../vm/sweep';
import { createTartCli } from '../vm/tart-cli';

const DESCRIPTION =
  'Run the coordinator: poll GitHub, run each lane that lacks a verdict, and post its status.';

const DETAILS = `hugi serve runs in the foreground until it is stopped; \`hugi service install\` runs it as a launchd user agent. It refuses to start, saying what to fix, when another hugi serve holds the lock, the configuration is refused, github_app or its key is unusable, or tart or git is not on the search path (\`path\` in the configuration). It deletes every hugi-svc-* VM when it starts, runs one lane at a time, and writes its state for \`hugi service status\`. The README's "Running the coordinator" section has the rules.`;

/** The tools the service runs on the host, which `path` must reach. */
const HOST_TOOLS = ['tart', 'git'] as const;

/** A short random VM id: the `hugi-svc-` prefix plus 8 hex digits names the run's VM. */
const newVmId = () => crypto.randomUUID().slice(0, 8);

const asCoordinatorLog = (log: Log): CoordinatorLog => ({
  error: (message) => log.error(message),
  info: (message) => log.info(message),
  warn: (message) => log.warn(message),
});

/** A `GitHubReader` that reads each repository with that repository's installation token. */
function perRepositoryReader(tokens: InstallationTokens): GitHubReader {
  const readers = new Map<string, GitHubReader>();
  const readerOf = (repository: string): GitHubReader => {
    let reader = readers.get(repository);
    if (reader === undefined) {
      reader = createGitHubReader({
        fetch: (url, init) => fetch(url, init),
        token: tokens(repository),
      });
      readers.set(repository, reader);
    }
    return reader;
  };
  return {
    commitStatuses: (repository, sha) => readerOf(repository).commitStatuses(repository, sha),
    defaultBranchHead: (repository) => readerOf(repository).defaultBranchHead(repository),
    openPullRequests: (repository) => readerOf(repository).openPullRequests(repository),
    pullRequest: (repository, number) => readerOf(repository).pullRequest(repository, number),
  };
}

/** Bind the coordinator to the host: GitHub as the App, git and tart through `path`, VMs as hugi-svc-*. */
async function coordinate(
  host: Host,
  config: HugiConfig,
  configPath: string,
  signal: AbortSignal,
  log: CoordinatorLog,
  report: Parameters<typeof runCoordinator>[1]['report'],
): Promise<void> {
  const env = hostEnv(config, host.env);
  const spawn = spawnWithTools(host.spawn, await requireHostTools(env, HOST_TOOLS), env);
  const tart = createTartCli(spawn);
  const tokens = createInstallationTokens({
    app: requireGitHubApp(config),
    fetch: (url, init) => fetch(url, init),
    home: host.home,
    platform: host.platform,
    spawn,
    uid: host.uid,
  });
  const github = perRepositoryReader(tokens);
  const sourceOptions: HostSourceOptions = {
    cacheDir: resolveCacheDir(undefined, host.env, host.home),
    cwd: host.cwd,
    deadlineMs: SERVICE_GIT_DEADLINE_MS,
    env,
    spawn,
    tempDir: host.tmpdir,
    uid: host.uid,
  };
  const specOf = (repository: string): GitHubRepositorySpec => {
    const spec = parseRepository(repository, host.cwd, host.home);
    if (spec.kind !== 'github') {
      throw new Error(`${repository} is not an owner/name GitHub repository.`);
    }
    return spec;
  };
  const resources = { cpus: config.vm.cpus, memoryMb: config.vm.memoryGb * 1024 };
  await runCoordinator(config, {
    clock: systemClock,
    log,
    poll: () =>
      pollRepositories(config, {
        github,
        openPullRequest: (repository, facts) =>
          openPullRequestSource(specOf(repository), facts, sourceOptions),
        openPush: (repository, sha) => openHostSource(specOf(repository), sha, sourceOptions),
      }),
    report,
    reporter: createStatusReporter({
      fetch: (url, init) => fetch(url, init),
      invalidate: (repository) => tokens.invalidate(repository),
      token: tokens,
    }),
    runCandidate: createRunCandidate({
      configPath,
      newVmId,
      now: () => new Date(),
      openPullRequestSource: (spec, facts) => openPullRequestSource(spec, facts, sourceOptions),
      openSource: (spec, commit) => openHostSource(spec, commit, sourceOptions),
      readPullRequest: (repository, number) => github.pullRequest(repository, number),
      runInVm: (request, vmId) =>
        runInVm(request, {
          clock: systemClock,
          interrupt: signal,
          newId: () => vmId,
          resources,
          tart,
          vmPrefix: SERVICE_VM_PREFIX,
          warn: (message) => log.warn(message),
        }),
      runsDir: resolveRunsDir(host.env, host.home),
      warn: (message) => log.warn(message),
    }),
    signal,
  });
}

export function serveCommand() {
  return new Command('serve', { description: DESCRIPTION })
    .extend(helpCommand({ details: DETAILS }))
    .option('config', {
      description: 'The configuration file; default HUGI_CONFIG, else the XDG config directory.',
      type: 'string',
    })
    .action(async ({ host, log, options, signal }) => {
      const configPath = resolveConfigPath(options.config, host.env, host.home);
      const stateDir = resolveServiceStateDir(host.env, host.home);
      const coordinatorLog = asCoordinatorLog(log);
      // oxlint-disable-next-line @loomcli/host-bypass -- the lock records this process; Host has no pid
      const { pid } = process;
      await startService({
        acquireLock: () =>
          acquireServeLock(
            stateDir,
            createServeLockDeps(host.spawn, { pid, platform: host.platform }),
          ),
        checkSetup: async (config) => {
          await checkAppKey(config, host);
          await requireHostTools(hostEnv(config, host.env), HOST_TOOLS);
        },
        coordinate: (config, report) =>
          coordinate(host, config, configPath, signal, coordinatorLog, report),
        loadConfig: () => loadConfig(configPath),
        log: coordinatorLog,
        now: () => new Date(),
        pid,
        sweep: async (config) => {
          const env = hostEnv(config, host.env);
          const spawn = spawnWithTools(host.spawn, await requireHostTools(env, HOST_TOOLS), env);
          return sweepVms(createTartCli(spawn), SERVICE_VM_PREFIX);
        },
        writeState: (state) => writeServiceState(stateDir, state),
      });
    });
}
