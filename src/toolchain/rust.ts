import { messageOf } from '../errors';
import { ToolchainResolutionError } from './errors';
import type { ReadRepoFile } from './types';
import { pinnedVersion } from './versions';

function rustChannel(source: string, text: string) {
  if (source === 'rust-toolchain' && /^[^\r\n]+(?:\r?\n)?$/u.test(text)) {
    return text.trim();
  }
  const document: unknown = Bun.TOML.parse(text);
  if (typeof document !== 'object' || document === null || !('toolchain' in document)) {
    throw new Error('missing [toolchain] channel');
  }
  const toolchain = document.toolchain;
  if (
    typeof toolchain !== 'object' ||
    toolchain === null ||
    !('channel' in toolchain) ||
    typeof toolchain.channel !== 'string'
  ) {
    throw new Error('missing [toolchain] channel');
  }
  return toolchain.channel;
}

/** Cargo honors root toolchain files even when the workflow has no Rust setup action. */
export async function resolveRust(readRepoFile: ReadRepoFile) {
  let source = 'rust-toolchain';
  try {
    let text = await readRepoFile(source);
    if (text === undefined) {
      source = 'rust-toolchain.toml';
      text = await readRepoFile(source);
    }
    if (text === undefined) {
      return undefined;
    }
    return {
      note: `${source}: rustup in the guest handles components and profile.`,
      source,
      tool: pinnedVersion('rust', rustChannel(source, text)),
    };
  } catch (cause) {
    throw new ToolchainResolutionError(`${source}: ${messageOf(cause)}`, { cause });
  }
}
