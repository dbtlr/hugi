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
// A linkedit_data_command: cmd, cmdsize, dataoff, datasize.
const LINKEDIT_DATA_COMMAND = 16;

// From the xnu kernel's cs_blobs.h. Signature blobs are big-endian.
const CSMAGIC_EMBEDDED_SIGNATURE = 4_208_856_256; // 0xfade0cc0
const CSMAGIC_CODEDIRECTORY = 4_208_856_066; // 0xfade0c02
const CSSLOT_CODEDIRECTORY = 0;
const CS_HASHTYPE_SHA256 = 2;
const SHA256_BYTES = 32;
// A SuperBlob is magic, length, count, then count {type, offset} entries.
const SUPER_BLOB_HEADER = 12;
const BLOB_INDEX = 8;
// The earliest CodeDirectory's fixed fields end with pageSize and a spare word at byte 44.
const CODE_DIRECTORY_HEADER = 44;
// Each later version appends fixed fields (xnu's cs_blobs.h, CS_CodeDirectory). Bun writes 0x20400.
const CODE_DIRECTORY_HEADERS: [version: number, end: number][] = [
  [132_608, 108], // 0x20600: linkage fields
  [132_352, 96], // 0x20500: runtime, preEncryptOffset
  [132_096, 88], // 0x20400: execSegBase, execSegLimit, execSegFlags
  [131_840, 64], // 0x20300: spare3, codeLimit64
  [131_584, 52], // 0x20200: teamOffset
  [131_328, 48], // 0x20100: scatterOffset
];
const CODE_DIRECTORY_NEWEST = 132_863; // 0x206ff

/** Where a CodeDirectory's fixed fields end for its version, or undefined for a newer version. */
function codeDirectoryHeader(version: number): number | undefined {
  if (version > CODE_DIRECTORY_NEWEST) {
    return undefined;
  }
  return CODE_DIRECTORY_HEADERS.find(([since]) => version >= since)?.[1] ?? CODE_DIRECTORY_HEADER;
}

type Refusal = { ok: false; reason: string };

function malformed(what: string): Refusal {
  return { ok: false, reason: `The code signature is malformed: ${what}.` };
}

/**
 * Whether a binary is a 64-bit arm64 Mach-O whose embedded code signature is present and whose
 * code pages match the SHA-256 hashes in it. The workflow builds on Linux and cannot run the
 * binary, so this catches a missing, damaged or truncated signature before publishing. Whether
 * macOS accepts the signature and runs the binary is first seen on the Mac.
 */
export function signedArm64MachO(binary: Uint8Array): Check<object> {
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const signature = codeSignatureCommand(view);
  if (!signature.ok) {
    return signature;
  }
  const { dataoff, datasize } = signature;
  if (dataoff + datasize > binary.byteLength) {
    return {
      ok: false,
      reason: `The binary is truncated: its code signature runs to byte ${dataoff + datasize}, past the file's ${binary.byteLength} bytes.`,
    };
  }
  const directory = codeDirectory(view, dataoff, datasize);
  if (!directory.ok) {
    return directory;
  }
  return pagesMatch(binary, view, directory.offset, directory.length, dataoff);
}

/** Finds LC_CODE_SIGNATURE in an arm64 Mach-O's load commands and reads where the signature sits. */
function codeSignatureCommand(view: DataView): Check<{ dataoff: number; datasize: number }> {
  if (view.byteLength < HEADER_64 || view.getUint32(0, true) !== MH_MAGIC_64) {
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
  if (end > view.byteLength) {
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
      if (cmdsize < LINKEDIT_DATA_COMMAND || offset + LINKEDIT_DATA_COMMAND > end) {
        return {
          ok: false,
          reason:
            'The binary is malformed: its code signature load command is too small to locate it.',
        };
      }
      return {
        dataoff: view.getUint32(offset + 8, true),
        datasize: view.getUint32(offset + 12, true),
        ok: true,
      };
    }
    offset += cmdsize;
  }
  return {
    ok: false,
    reason: 'The binary has no code signature, so macOS on arm64 will not run it.',
  };
}

/**
 * Finds the CodeDirectory in the SuperBlob at `dataoff`, which the caller has bounded to the file.
 * Every offset it follows is checked against the blob that holds it.
 */
function codeDirectory(
  view: DataView,
  dataoff: number,
  datasize: number,
): Check<{ offset: number; length: number }> {
  if (datasize < SUPER_BLOB_HEADER || view.getUint32(dataoff) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    return malformed('it is not an embedded-signature SuperBlob');
  }
  const length = view.getUint32(dataoff + 4);
  const count = view.getUint32(dataoff + 8);
  if (length > datasize || SUPER_BLOB_HEADER + count * BLOB_INDEX > length) {
    return malformed('its SuperBlob runs past the signature');
  }
  for (let index = 0; index < count; index += 1) {
    const entry = dataoff + SUPER_BLOB_HEADER + index * BLOB_INDEX;
    if (view.getUint32(entry) !== CSSLOT_CODEDIRECTORY) {
      continue;
    }
    const blob = view.getUint32(entry + 4);
    if (blob + 8 > length) {
      return malformed('its CodeDirectory runs past the SuperBlob');
    }
    if (view.getUint32(dataoff + blob) !== CSMAGIC_CODEDIRECTORY) {
      return malformed('its CodeDirectory slot does not hold a CodeDirectory');
    }
    const blobLength = view.getUint32(dataoff + blob + 4);
    if (blobLength < CODE_DIRECTORY_HEADER || blob + blobLength > length) {
      return malformed('its CodeDirectory runs past the SuperBlob');
    }
    return { length: blobLength, offset: dataoff + blob, ok: true };
  }
  return { ok: false, reason: 'The code signature has no CodeDirectory.' };
}

/**
 * Whether the CodeDirectory signs the file up to the signature with SHA-256, one hash per page
 * (the last page may be short), and every page hashes to its stored value.
 */
function pagesMatch(
  binary: Uint8Array,
  view: DataView,
  directory: number,
  directoryLength: number,
  dataoff: number,
): Check<object> {
  const version = view.getUint32(directory + 8);
  const hashOffset = view.getUint32(directory + 16);
  const identOffset = view.getUint32(directory + 20);
  const nSpecialSlots = view.getUint32(directory + 24);
  const nCodeSlots = view.getUint32(directory + 28);
  const codeLimit = view.getUint32(directory + 32);
  const hashSize = view.getUint8(directory + 36);
  const hashType = view.getUint8(directory + 37);
  const pageSizeLog2 = view.getUint8(directory + 39);
  const header = codeDirectoryHeader(version);
  if (header === undefined) {
    return {
      ok: false,
      reason: `The code signature has CodeDirectory version 0x${version.toString(16)}, which this check does not know.`,
    };
  }
  if (directoryLength < header) {
    return malformed("its CodeDirectory is shorter than its version's fixed fields");
  }
  if (hashType !== CS_HASHTYPE_SHA256) {
    return {
      ok: false,
      reason: `The code signature hashes with type ${hashType}, not SHA-256 (${CS_HASHTYPE_SHA256}).`,
    };
  }
  if (hashSize !== SHA256_BYTES) {
    return {
      ok: false,
      reason: `The code signature's hashes are ${hashSize} bytes, not SHA-256's ${SHA256_BYTES}.`,
    };
  }
  if (codeLimit !== dataoff) {
    return {
      ok: false,
      reason: `The code signature covers ${codeLimit} bytes, but the signature starts at byte ${dataoff}.`,
    };
  }
  // A page size of 0 means the whole signed range is one page.
  const page = pageSizeLog2 === 0 ? codeLimit : 2 ** pageSizeLog2;
  const pages = codeLimit === 0 ? 0 : Math.ceil(codeLimit / page);
  if (nCodeSlots !== pages) {
    return {
      ok: false,
      reason: `The code signature has ${nCodeSlots} page hashes, but its ${codeLimit} signed bytes are ${pages} pages.`,
    };
  }
  if (hashOffset + nCodeSlots * hashSize > directoryLength) {
    return malformed('its page hashes run past its CodeDirectory');
  }
  // macOS reads the identifier and the special-slot hashes (stored just before hashOffset) too.
  const identifierEnd =
    identOffset < header
      ? -1
      : binary.subarray(directory + identOffset, directory + directoryLength).indexOf(0);
  if (identOffset >= directoryLength || identifierEnd < 0) {
    return malformed('its identifier is not a string inside its CodeDirectory');
  }
  if (hashOffset < header + nSpecialSlots * hashSize) {
    return malformed('its special-slot hashes overlap its CodeDirectory header');
  }
  for (let index = 0; index < pages; index += 1) {
    const start = index * page;
    const end = Math.min(start + page, codeLimit);
    const actual = new Bun.CryptoHasher('sha256').update(binary.subarray(start, end)).digest();
    const stored = binary.subarray(
      directory + hashOffset + index * hashSize,
      directory + hashOffset + (index + 1) * hashSize,
    );
    if (!actual.equals(stored)) {
      return {
        ok: false,
        reason: `Page ${index} (bytes ${start}-${end - 1}) does not match its signed hash, so macOS will not run it.`,
      };
    }
  }
  return { ok: true };
}

/** The one release asset, named as Loom's installer requests it. */
export const ASSET = 'hugi-darwin-arm64';

/**
 * Whether SHA256SUMS is exactly the one line the README defines for a release: the binary's digest
 * in lowercase hex, two spaces, the bare asset name. That is stricter than Loom's installer, which
 * also accepts `hex *name` and skips lines for other assets; the release publishes only this shape.
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
