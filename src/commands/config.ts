import { Command } from '@loomcli/core';
import type { View } from '@loomcli/core';
import { json } from '@loomcli/plugins/format';

import { loadConfig } from '../config/load';
import type { ReadText } from '../config/load';
import type { HugiConfig } from '../config/schema';
import { resolveConfigPath } from '../source/locations';

/** What `hugi config check` prints: where the configuration came from and what it means. */
export type ConfigReport = { readonly path: string; readonly config: HugiConfig };

function listLines(items: readonly string[]): string {
  return items.length === 0 ? ' (none)' : `\n${items.map((item) => `  - ${item}`).join('\n')}`;
}

/** The effective configuration, defaults applied, one key per line. */
export function renderConfigReport({ config, path }: ConfigReport): string {
  return `${[
    `configuration: ${path} (valid)`,
    `repositories:${listLines(config.repositories)}`,
    `allowlist:${listLines(config.allowlist)}`,
    `poll_interval: ${config.pollIntervalSeconds}`,
    `vm: ${config.vm.cpus} cpus, ${config.vm.memoryGb} GB memory`,
  ].join('\n')}\n`;
}

const textView: View<ConfigReport> = { render: renderConfigReport };

/** Seams a test replaces; production reads the file from disk. */
export type ConfigCommandOverrides = { readonly readText?: ReadText };

function checkCommand(overrides: ConfigCommandOverrides) {
  return new Command('check', {
    description: "Validate Hugi's configuration file and print the effective configuration.",
  })
    .option('config', {
      description:
        'The configuration file; also HUGI_CONFIG, else $XDG_CONFIG_HOME/hugi/config.yaml.',
      type: 'string',
    })
    .result<ConfigReport>({ views: { json: json(), text: textView } })
    .views({ text: textView }, { default: 'text' })
    .action(async ({ host, options, out }) => {
      const path = resolveConfigPath(options.config, host.env, host.home);
      const config = await loadConfig(path, overrides.readText);
      await out.results({ config, path });
    });
}

export function configCommand(overrides: ConfigCommandOverrides = {}) {
  return new Command('config', { description: "Work with Hugi's own configuration." }).command(
    checkCommand(overrides),
  );
}
