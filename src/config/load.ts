/** Find, read, and validate Hugi's configuration file. */
import { readFile } from 'node:fs/promises';

import { messageOf } from '../errors';
import { parseStrictYaml, YamlRefusalError } from '../yaml/strict';
import { ConfigError, validateConfig } from './schema';
import type { HugiConfig } from './schema';

/** Reads a file's text; the seam a test replaces. */
export type ReadText = (path: string) => Promise<string>;

const HOW_TO_POINT =
  'Pass --config <path> or set HUGI_CONFIG to point Hugi at a configuration file.';

/** The file's text, or a `ConfigError` naming the path tried when it cannot be read. */
async function readConfigText(path: string, readText: ReadText): Promise<string> {
  try {
    return await readText(path);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    throw new ConfigError(
      missing
        ? `No configuration file at ${path}. ${HOW_TO_POINT}`
        : `Cannot read the configuration file ${path}: ${messageOf(error)}. ${HOW_TO_POINT}`,
    );
  }
}

/** Load and validate the configuration at `path`; every failure is a `ConfigError`. */
export async function loadConfig(
  path: string,
  readText: ReadText = (file) => readFile(file, 'utf8'),
): Promise<HugiConfig> {
  const text = await readConfigText(path, readText);
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
