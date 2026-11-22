/**
 * Checks a built release before the workflow uploads it: `bun scripts/release/main.ts <dir> [<tag>]`.
 * `<dir>` holds the asset and SHA256SUMS. With a tag, it also checks the tag against package.json;
 * a pull-request build passes none. Prints each refusal and exits 1 if there is any.
 */
import { join } from 'node:path';

import pkg from '../../package.json' with { type: 'json' };
import { ASSET, checksums, releaseVersion, signedArm64MachO } from './check';
import type { Check } from './check';

const [dir, tag] = process.argv.slice(2);
if (dir === undefined) {
  console.error('Usage: bun scripts/release/main.ts <dir> [<tag>]');
  process.exit(2);
}

const binary = new Uint8Array(await Bun.file(join(dir, ASSET)).arrayBuffer());
const sums = await Bun.file(join(dir, 'SHA256SUMS')).text();
const results: Check<object>[] = [signedArm64MachO(binary), checksums(sums, binary)];
if (tag !== undefined) {
  results.push(releaseVersion(tag, pkg.version));
}

const refusals = results.flatMap((result) => (result.ok ? [] : [result.reason]));
for (const reason of refusals) {
  console.error(`release check: ${reason}`);
}
if (refusals.length > 0) {
  process.exit(1);
}
console.log(
  `release check: ${ASSET} and SHA256SUMS are ready${tag === undefined ? '' : ` for ${tag}`}.`,
);
