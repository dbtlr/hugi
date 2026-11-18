/** The Loom Application for the `hugi` CLI. */
import { Application } from '@loomcli/core';
import type { View } from '@loomcli/core';
import { help } from '@loomcli/plugins/help';

import { runCommand } from './commands/run';
import { VERSION } from './version';

/** What the bare `hugi` prints; `--version` replaces it with the version. */
const USAGE = 'Run "hugi --help" to see the usage.';

const textView: View<{ text: string }> = { render: (data) => `${data.text}\n` };

export function createApp() {
  return new Application('hugi', {
    description: 'Run macOS CI lanes in throwaway VMs and report the verdicts to GitHub.',
    plugins: [help()],
    version: VERSION,
  })
    .option('version', { description: 'Print the version and exit.', type: 'boolean' })
    .result<{ text: string }>({ views: { text: textView } })
    .views({ text: textView }, { default: 'text' })
    .command(runCommand())
    .action(async ({ options, out }) => {
      await out.results({ text: options.version ? VERSION : USAGE });
    });
}
