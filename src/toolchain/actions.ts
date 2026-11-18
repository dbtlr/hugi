import { messageOf } from '../errors';
import type { ActionStep } from '../lane/step-plan';
import { bunVersion } from './bun';
import { UnsupportedActionError } from './errors';
import { pnpmVersion } from './pnpm';
import type { ActionResolution, ReadRepoFile } from './types';
import { pinnedVersion } from './versions';

function validateInputs(step: ActionStep, allowed: readonly string[]) {
  for (const input of Object.keys(step.with)) {
    if (!allowed.includes(input)) {
      throw new UnsupportedActionError(step, `unsupported input "${input}"`);
    }
  }
}

async function mapAction(step: ActionStep, readRepoFile: ReadRepoFile): Promise<ActionResolution> {
  const source = { index: step.index, name: step.name, uses: step.uses };
  const identity = /^([^/@\s]+\/[^/@\s]+)@[^@\s]+$/u.exec(step.uses)?.[1];
  switch (identity?.toLowerCase()) {
    case 'actions/checkout': {
      validateInputs(step, ['persist-credentials']);
      return {
        ...source,
        kind: 'noop',
        reason: 'The runner checks out the commit without credentials.',
      };
    }
    case 'swatinem/rust-cache': {
      validateInputs(step, []);
      return { ...source, kind: 'noop', reason: 'The golden image holds warm Rust caches.' };
    }
    case 'actions/upload-artifact': {
      validateInputs(step, ['name', 'path', 'if-no-files-found']);
      if (!step.with.path?.trim()) {
        throw new Error('upload-artifact needs a path');
      }
      const ifNoFiles = step.with['if-no-files-found'];
      if (ifNoFiles !== undefined && !['error', 'ignore', 'warn'].includes(ifNoFiles)) {
        throw new Error(`unsupported if-no-files-found "${ifNoFiles}"`);
      }
      const existenceNote =
        ifNoFiles === 'error' ? ' Artifact path existence check is skipped.' : '';
      return {
        ...source,
        kind: 'noop',
        reason: `Verification only: Hugi publishes no artifacts (ADR-0002).${existenceNote}`,
      };
    }
    case 'actions/setup-node': {
      validateInputs(step, ['node-version', 'cache']);
      const cache = step.with.cache;
      if (cache !== undefined && !['pnpm', 'npm', 'yarn'].includes(cache)) {
        throw new Error(`unsupported cache ${JSON.stringify(cache)}`);
      }
      const tool = pinnedVersion('node', step.with['node-version'] ?? 'latest');
      const notes =
        cache === undefined ? [] : [`${cache} cache: the golden image holds warm package caches.`];
      return { ...source, kind: 'tools', notes, tools: [tool] };
    }
    case 'pnpm/action-setup': {
      validateInputs(step, ['version']);
      const tool = pinnedVersion('pnpm', await pnpmVersion(step.with, readRepoFile));
      return { ...source, kind: 'tools', notes: [], tools: [tool] };
    }
    case 'oven-sh/setup-bun': {
      validateInputs(step, ['bun-version', 'bun-version-file']);
      const tool = pinnedVersion('bun', await bunVersion(step.with, readRepoFile));
      return { ...source, kind: 'tools', notes: [], tools: [tool] };
    }
    default: {
      throw new UnsupportedActionError(step, 'unsupported action');
    }
  }
}

export async function resolveAction(step: ActionStep, readRepoFile: ReadRepoFile) {
  try {
    return await mapAction(step, readRepoFile);
  } catch (cause) {
    if (cause instanceof UnsupportedActionError) {
      throw cause;
    }
    throw new UnsupportedActionError(step, messageOf(cause));
  }
}
