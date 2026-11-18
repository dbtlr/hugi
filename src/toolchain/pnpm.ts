import type { ReadRepoFile } from './types';

export async function pnpmVersion(
  inputs: Readonly<Record<string, string>>,
  readRepoFile: ReadRepoFile,
) {
  const text = await readRepoFile('package.json');
  if (text !== undefined) {
    const manifest: unknown = JSON.parse(text);
    const devEngine = inputs.version === undefined ? devEnginesPnpm(manifest) : undefined;
    if (devEngine !== undefined) {
      return devEngine;
    }
    if (typeof manifest === 'object' && manifest !== null && 'packageManager' in manifest) {
      const manager = manifest.packageManager;
      const version =
        typeof manager === 'string'
          ? /^pnpm@([^+]+)(?:\+sha(?:224|256|384|512)\.[a-fA-F0-9]+)?$/u.exec(manager)?.[1]
          : undefined;
      if (version !== undefined) {
        if (inputs.version !== undefined && inputs.version !== version) {
          throw new Error(
            `Multiple versions of pnpm specified: version "${inputs.version}" in the action and packageManager version "${version}" in package.json`,
          );
        }
        return version;
      }
      throw new Error('package.json packageManager must be a pinned pnpm version');
    }
  }
  if (inputs.version !== undefined) {
    return inputs.version;
  }
  throw new Error('pnpm needs version or package.json packageManager');
}

/**
 * The pnpm version in `devEngines.packageManager`, which the action prefers
 * over `packageManager` when it has no `version` input. The caller rejects a
 * range as unpinned.
 */
function devEnginesPnpm(manifest: unknown): string | undefined {
  if (typeof manifest !== 'object' || manifest === null || !('devEngines' in manifest)) {
    return undefined;
  }
  const { devEngines } = manifest;
  if (typeof devEngines !== 'object' || devEngines === null || !('packageManager' in devEngines)) {
    return undefined;
  }
  const managers: unknown[] = [devEngines.packageManager].flat();
  for (const entry of managers) {
    if (typeof entry === 'object' && entry !== null && 'name' in entry && entry.name === 'pnpm') {
      return 'version' in entry && typeof entry.version === 'string' ? entry.version : undefined;
    }
  }
  return undefined;
}
