/** The Loom Application for the `hugi` CLI. */
import { Application } from '@loomcli/core';
import type { View } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';

import { configCommand } from './commands/config';
import type { ConfigCommandOverrides } from './commands/config';
import { runCommand } from './commands/run';
import type { RunCommandOverrides } from './commands/run';
import { VERSION } from './version';

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

export function createApp(run: RunCommandOverrides = {}, config: ConfigCommandOverrides = {}) {
  return new Application('hugi', {
    description: 'Run macOS CI lanes in throwaway VMs and report the verdicts to GitHub.',
    plugins: [format(), help()],
    shutdown: { timeout: SHUTDOWN_BUDGET_MS },
    version: VERSION,
  })
    .option('version', { description: 'Print the version and exit.', type: 'boolean' })
    .result<{ text: string }>({ views: { text: textView } })
    .views({ text: textView }, { default: 'text' })
    .command(runCommand(run))
    .command(configCommand(config))
    .action(async ({ options, out }) => {
      await out.results({ text: options.version ? VERSION : USAGE });
    });
}
