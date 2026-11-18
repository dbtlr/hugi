import { Command, FatalError } from '@loomcli/core';

/** Placeholder: Loom requires one command. It will run one CI lane in a VM. */
export function runCommand() {
  return new Command('run', {
    description: 'Run one CI lane in a throwaway VM (not implemented yet).',
  }).action(() => {
    throw new FatalError('hugi run is not implemented yet.');
  });
}
