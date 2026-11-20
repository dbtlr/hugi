/** The Loom Application for the `hugi` CLI. */
import { Application } from '@loomcli/core';
import type { View } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';
import { logging } from '@loomcli/plugins/logging';
import { service } from '@loomcli/plugins/service';
import type { ProbeContext } from '@loomcli/plugins/service';

import { configCommand } from './commands/config';
import type { ConfigCommandOverrides } from './commands/config';
import { logsCommand, serviceLogPath } from './commands/logs';
import { runCommand } from './commands/run';
import type { RunCommandOverrides } from './commands/run';
import { serveCommand } from './commands/serve';
import { createProbe } from './service/probe';
import { readServiceState } from './service/state';
import { resolveServiceStateDir } from './source/locations';
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

/** The rows `hugi service status` adds, read from the state `hugi serve` writes and from tart. */
function statusRows(context: ProbeContext) {
  const { host } = context;
  return createProbe({
    listVms: () => createTartCli(host.spawn).list(),
    logPath: serviceLogPath(host.env, host.home, host.platform),
    now: () => new Date(),
    readState: () => readServiceState(resolveServiceStateDir(host.env, host.home)),
  })(context);
}

export function createApp(run: RunCommandOverrides = {}, config: ConfigCommandOverrides = {}) {
  return new Application('hugi', {
    description: 'Run macOS CI lanes in throwaway VMs and report the verdicts to GitHub.',
    plugins: [
      format(),
      help(),
      logging({ to: 'file' }),
      service({ label: SERVICE_LABEL, probe: statusRows, run: ['serve'] }),
    ],
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
