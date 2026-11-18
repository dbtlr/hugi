/** The build's version: the package's version, the one source for `--version`. */
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
