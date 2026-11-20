/** Find, read, and validate Hugi's configuration file. */
import { readFile } from 'node:fs/promises';

import { messageOf } from '../errors';
import { parseStrictYaml, YamlRefusalError } from '../yaml/strict';
import { ConfigError, validateConfig } from './schema';
import type { HugiConfig } from './schema';

/** Reads a file's text; the seam a test replaces. */
export type ReadText = (path: string) => Promise<string>;

/** The default hint for a command that takes `--config`; a caller with no such option passes its own. */
export const HOW_TO_POINT =
  'Pass --config <path> or set HUGI_CONFIG to point Hugi at a configuration file.';

/** `message` followed by the caller's hint, when it has one. */
function withHint(message: string, hint: string): string {
  return hint === '' ? `${message}.` : `${message}. ${hint}`;
}

/** The file's text, or a `ConfigError` naming the path tried when it cannot be read. */
async function readConfigText(path: string, readText: ReadText, hint: string): Promise<string> {
  try {
    return await readText(path);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    throw new ConfigError(
      withHint(
        missing
          ? `No configuration file at ${path}`
          : `Cannot read the configuration file ${path}: ${messageOf(error)}`,
        hint,
      ),
    );
  }
}

/**
 * Load and validate the configuration at `path`; every failure is a `ConfigError`. `hint` is the
 * sentence that tells the user how to point Hugi at another file, which depends on the command.
 */
export async function loadConfig(
  path: string,
  readText: ReadText = (file) => readFile(file, 'utf8'),
  hint: string = HOW_TO_POINT,
): Promise<HugiConfig> {
  const text = await readConfigText(path, readText, hint);
  try {
    return validateConfig(parseStrictYaml(text));
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`${path}: ${error.message}`);
    }
    if (error instanceof YamlRefusalError) {
      throw new ConfigError(`${path}: ${error.message}.`);
    }
    throw error;
  }
}
