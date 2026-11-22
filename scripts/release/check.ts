/**
 * The release workflow's checks on what it is about to publish (README, "Installing a release").
 * Each check returns a reason instead of throwing, so the command line can name every refusal.
 */

export type Check<T> = ({ ok: true } & T) | { ok: false; reason: string };

const TAG = /^v(?<version>\d+\.\d+\.\d+)$/u;

// From <mach-o/loader.h>.
const MH_MAGIC_64 = 4_277_009_103; // 0xfeedfacf
const CPU_TYPE_ARM64 = 16_777_228; // 0x0100000c
const LC_CODE_SIGNATURE = 29; // 0x1d
const HEADER_64 = 32;

/**
 * Whether a binary is a 64-bit arm64 Mach-O with a code signature load command. The workflow
 * builds on Linux and cannot run the binary, and macOS on Apple silicon kills an unsigned one at
 * exec, so this is the check that a release will start at all.
 */
export function signedArm64MachO(binary: Uint8Array): Check<object> {
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  if (binary.byteLength < HEADER_64 || view.getUint32(0, true) !== MH_MAGIC_64) {
    return { ok: false, reason: 'The binary is not a 64-bit Mach-O.' };
  }
  const cputype = view.getUint32(4, true);
  if (cputype !== CPU_TYPE_ARM64) {
    return {
      ok: false,
      reason: `The binary is a Mach-O for CPU type 0x${cputype.toString(16)}, not arm64.`,
    };
  }
  const ncmds = view.getUint32(16, true);
  const end = HEADER_64 + view.getUint32(20, true);
  if (end > binary.byteLength) {
    return { ok: false, reason: 'The binary is truncated: its load commands run past the file.' };
  }
  let offset = HEADER_64;
  for (let index = 0; index < ncmds; index += 1) {
    if (offset + 8 > end) {
      return {
        ok: false,
        reason: 'The binary is malformed: its load commands run past their stated size.',
      };
    }
    const cmd = view.getUint32(offset, true);
    const cmdsize = view.getUint32(offset + 4, true);
    if (cmdsize < 8) {
      return {
        ok: false,
        reason: 'The binary is malformed: a load command is smaller than its header.',
      };
    }
    if (cmd === LC_CODE_SIGNATURE) {
      return { ok: true };
    }
    offset += cmdsize;
  }
  return {
    ok: false,
    reason: 'The binary has no code signature, so macOS on arm64 will not run it.',
  };
}

/** The one release asset, named as Loom's installer requests it. */
export const ASSET = 'hugi-darwin-arm64';

/**
 * Whether SHA256SUMS is exactly the line Loom's installer reads for the asset: the binary's digest in
 * lowercase hex, two spaces, the bare asset name. The installer matches only that form, so any other
 * line publishes a release nothing can install.
 */
export function checksums(sums: string, binary: Uint8Array): Check<object> {
  const line = `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  ${ASSET}`;
  if (sums !== `${line}\n`) {
    return { ok: false, reason: `SHA256SUMS is not the one line "${line}".` };
  }
  return { ok: true };
}

/** The version a release tag publishes: `v<digits>.<digits>.<digits>`, equal to package.json's. */
export function releaseVersion(tag: string, packageVersion: string): Check<{ version: string }> {
  const version = TAG.exec(tag)?.groups?.version;
  if (version === undefined) {
    return {
      ok: false,
      reason: `The tag ${JSON.stringify(tag)} is not v<digits>.<digits>.<digits>.`,
    };
  }
  if (version !== packageVersion) {
    return {
      ok: false,
      reason: `The tag ${tag} does not match package.json version ${packageVersion}.`,
    };
  }
  return { ok: true, version };
}
