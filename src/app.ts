/** The Loom Application for the `hugi` CLI. */
import { Application } from '@loomcli/core';
import type { Host, View } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';
import { logging } from '@loomcli/plugins/logging';
import { service } from '@loomcli/plugins/service';
import type { ProbeContext, ServiceSettings } from '@loomcli/plugins/service';

import { configCommand } from './commands/config';
import type { ConfigCommandOverrides } from './commands/config';
import { logsCommand } from './commands/logs';
import { runCommand } from './commands/run';
import type { RunCommandOverrides } from './commands/run';
import { serveCommand } from './commands/serve';
import { requireHostTools, serviceEnvironment, spawnWithTools } from './service/host-tools';
import { serveLockHolder } from './service/lock';
import { createProbe } from './service/probe';
import type { ProbeDeps } from './service/probe';
import { readServiceState } from './service/state';
import { resolveServeLockPath, resolveServiceStateDir } from './source/locations';
import { VERSION } from './version';
import { createTartCli } from './vm/tart-cli';

/** What the bare `hugi` prints; `--version` replaces it with the version. */
const USAGE = 'Run "hugi --help" to see the usage.';

const textView: View<{ text: string }> = { render: (data) => `${data.text}\n` };

/**
 * How long a signal lets a run unwind before Loom ends the process (Loom's default is 500 ms).
 * An interrupted `hugi run` first ends the tart call in flight (up to `TART_ESCALATION_MS`,
 * 7 seconds, when it ignores SIGTERM), then kills the running step and copies its log (30 seconds
 * each at most), then tears its VM down within the teardown budget (`TEARDOWN_BUDGET_MS`, 100
 * seconds: stop, wait for the VM process, delete). Once interrupted, the run starts no further
 * guest call beyond those two and skips the step's command files, so that is 167 seconds at worst;
 * 180 leaves a 13 second margin. Cutting it short would leave a VM behind (ADR-0003). A second
 * Ctrl-C still ends the process at once.
 */
export const SHUTDOWN_BUDGET_MS = 180_000;

/** The launchd label of the agent `hugi service install` writes. */
export const SERVICE_LABEL = 'com.dbtlr.hugi';

/** Where launchd sends the agent's stdout and stderr, relative to the home. */
export const SERVICE_OUTPUT = 'Library/Logs/hugi/serve.log';

/**
 * How long launchd waits after SIGTERM before it kills the agent. 60 seconds is the most launchd
 * allows from macOS 26.4, below `SHUTDOWN_BUDGET_MS` on purpose: a run cut short by hand keeps the
 * whole budget, and a VM a kill leaves under launchd is deleted at the next start.
 */
export const SERVICE_STOP_TIMEOUT_MS = 60_000;

/** The host facts `hugi service status` reads its rows with. */
export type StatusHost = Pick<Host, 'env' | 'home' | 'platform' | 'spawn'>;

/**
 * Where the rows `hugi service status` adds come from: the state `hugi serve` writes, the lock,
 * and tart, found on the `PATH` of the shell running `status`.
 */
export function statusProbeDeps(host: StatusHost): ProbeDeps {
  return {
    listVms: async () => {
      const tools = requireHostTools(host.env, ['tart']);
      return createTartCli(spawnWithTools(host.spawn, tools, host.env)).list();
    },
    lockHolder: () => serveLockHolder(resolveServeLockPath(host.home), host.platform),
    now: () => new Date(),
    readState: () => readServiceState(resolveServiceStateDir(host.env, host.home)),
  };
}

const statusRows = (context: ProbeContext) => createProbe(statusProbeDeps(context.host))(context);

/** The launchd agent `hugi service install` writes (README, "Installing the service"). */
const SERVICE_SETTINGS = {
  environment: ({ env }: Pick<Host, 'env'>) => serviceEnvironment(env),
  label: SERVICE_LABEL,
  output: SERVICE_OUTPUT,
  probe: statusRows,
  run: ['serve'],
  stopTimeout: SERVICE_STOP_TIMEOUT_MS,
} satisfies ServiceSettings;

export function createApp(run: RunCommandOverrides = {}, config: ConfigCommandOverrides = {}) {
  return new Application('hugi', {
    description: 'Run macOS CI lanes in throwaway VMs and report the verdicts to GitHub.',
    plugins: [format(), help(), logging({ to: 'file' }), service(SERVICE_SETTINGS)],
    shutdown: { timeout: SHUTDOWN_BUDGET_MS },
    version: VERSION,
  })
    .option('version', { description: 'Print the version and exit.', type: 'boolean' })
    .result<{ text: string }>({ views: { text: textView } })
    .views({ text: textView }, { default: 'text' })
    .command(runCommand(run))
    .command(serveCommand())
    .command(logsCommand())
    .command(configCommand(config))
    .action(async ({ options, out }) => {
      await out.results({ text: options.version ? VERSION : USAGE });
    });
}
