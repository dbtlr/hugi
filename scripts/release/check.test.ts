import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { checksums, releaseVersion, signedArm64MachO } from './check';

// The SHA-256 of the three bytes "abc", from FIPS 180-2's worked example.
const ABC = new TextEncoder().encode('abc');
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('SHA256SUMS that is the one release line for this binary passes', () => {
  expect(checksums(`${ABC_SHA256}  hugi-darwin-arm64\n`, ABC)).toEqual({ ok: true });
});

test('SHA256SUMS that is anything other than the one release line is refused', () => {
  for (const sums of [
    `${ABC_SHA256}  dist/hugi-darwin-arm64\n`,
    `${ABC_SHA256} hugi-darwin-arm64\n`,
    `${ABC_SHA256.toUpperCase()}  hugi-darwin-arm64\n`,
    `${ABC_SHA256}  hugi-darwin-arm64\n${ABC_SHA256}  hugi-darwin-x64\n`,
    '',
  ]) {
    expect(checksums(sums, ABC).ok).toBe(false);
  }
});

test('SHA256SUMS whose digest is not the binary is refused', () => {
  expect(checksums(`${'0'.repeat(64)}  hugi-darwin-arm64\n`, ABC)).toEqual({
    ok: false,
    reason: `SHA256SUMS is not the one line "${ABC_SHA256}  hugi-darwin-arm64".`,
  });
});

// Mach-O values from <mach-o/loader.h>: a 64-bit header is magic, cputype, cpusubtype, filetype,
// ncmds, sizeofcmds, flags, reserved (eight 32-bit little-endian words), then the load commands.
const MH_MAGIC_64 = 4_277_009_103; // 0xfeedfacf
const CPU_TYPE_ARM64 = 16_777_228; // 0x0100000c
const CPU_TYPE_X86_64 = 16_777_223; // 0x01000007
const LC_SEGMENT_64 = 25; // 0x19
const LC_CODE_SIGNATURE = 29; // 0x1d

function machO(cputype: number, commands: { cmd: number; size: number }[]): Uint8Array {
  const sizeofcmds = commands.reduce((sum, command) => sum + command.size, 0);
  const bytes = new Uint8Array(32 + sizeofcmds);
  const view = new DataView(bytes.buffer);
  for (const [index, word] of [
    MH_MAGIC_64,
    cputype,
    0,
    2,
    commands.length,
    sizeofcmds,
    0,
    0,
  ].entries()) {
    view.setUint32(index * 4, word, true);
  }
  let offset = 32;
  for (const command of commands) {
    view.setUint32(offset, command.cmd, true);
    view.setUint32(offset + 4, command.size, true);
    offset += command.size;
  }
  return bytes;
}

// Code-signing values from the xnu kernel's cs_blobs.h. The signature at LC_CODE_SIGNATURE's dataoff
// is a big-endian SuperBlob (magic, length, count, then {type, offset} entries) whose slot 0 is a
// CodeDirectory holding one hash per page of the file up to codeLimit.
const CSMAGIC_EMBEDDED_SIGNATURE = 4_208_856_256; // 0xfade0cc0
const CSMAGIC_CODEDIRECTORY = 4_208_856_066; // 0xfade0c02
const CS_HASHTYPE_SHA256 = 2;
const CS_HASHTYPE_SHA1 = 1;
const PAGE_SIZE_LOG2 = 12;
const PAGE = 2 ** PAGE_SIZE_LOG2;
// The CodeDirectory fields this check reads end at byte 44 (pageSize, then a spare word).
const CODE_DIRECTORY_HEADER = 44;

/**
 * An arm64 Mach-O of two full pages and a short third, ad-hoc signed the way the linker does it,
 * with page hashes computed here by node:crypto. Returns where the signature parts sit so a test
 * can damage one.
 */
function signedMachO(): { bytes: Uint8Array; codeDirectory: number; dataoff: number } {
  const header = machO(CPU_TYPE_ARM64, [
    { cmd: LC_SEGMENT_64, size: 72 },
    { cmd: LC_CODE_SIGNATURE, size: 16 },
  ]);
  const dataoff = 2 * PAGE + 300;
  const pages = Math.ceil(dataoff / PAGE);
  // The identifier string follows the header, NUL-terminated, and the page hashes follow it.
  const identifier = new TextEncoder().encode('hugi\0');
  const hashOffset = CODE_DIRECTORY_HEADER + identifier.length;
  const codeDirectoryLength = hashOffset + pages * 32;
  const superBlobLength = 20 + codeDirectoryLength;
  const datasize = Math.ceil(superBlobLength / 16) * 16;
  const bytes = new Uint8Array(dataoff + datasize);
  for (let index = header.length; index < dataoff; index += 1) {
    bytes[index] = (index * 31) % 256;
  }
  bytes.set(header);
  const view = new DataView(bytes.buffer);
  view.setUint32(32 + 72 + 8, dataoff, true);
  view.setUint32(32 + 72 + 12, datasize, true);

  for (const [index, word] of [CSMAGIC_EMBEDDED_SIGNATURE, superBlobLength, 1, 0, 20].entries()) {
    view.setUint32(dataoff + index * 4, word);
  }
  const codeDirectory = dataoff + 20;
  for (const [index, word] of [
    CSMAGIC_CODEDIRECTORY,
    codeDirectoryLength,
    0x2_01_00, // version
    0x2, // flags: adhoc
    hashOffset,
    CODE_DIRECTORY_HEADER, // identOffset
    0, // nSpecialSlots
    pages, // nCodeSlots
    dataoff, // codeLimit
  ].entries()) {
    view.setUint32(codeDirectory + index * 4, word);
  }
  bytes.set([32, CS_HASHTYPE_SHA256, 0, PAGE_SIZE_LOG2], codeDirectory + 36);
  bytes.set(identifier, codeDirectory + CODE_DIRECTORY_HEADER);
  for (let page = 0; page < pages; page += 1) {
    const hash = createHash('sha256')
      .update(bytes.subarray(page * PAGE, Math.min((page + 1) * PAGE, dataoff)))
      .digest();
    bytes.set(hash, codeDirectory + hashOffset + page * 32);
  }
  return { bytes, codeDirectory, dataoff };
}

/** Inverts one byte of a fixture, as a single corrupted byte in a download would. */
function flip(bytes: Uint8Array, index: number): void {
  bytes[index] = (bytes[index] ?? 0) ^ 255;
}

test('an arm64 Mach-O whose code pages match their signed hashes passes', () => {
  expect(signedArm64MachO(signedMachO().bytes)).toEqual({ ok: true });
});

test('a flipped byte in a signed page is refused, naming the page', () => {
  const { bytes } = signedMachO();
  flip(bytes, PAGE + 7);
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason: 'Page 1 (bytes 4096-8191) does not match its signed hash, so macOS will not run it.',
  });
});

test('a flipped byte in the short last page is refused', () => {
  const { bytes, dataoff } = signedMachO();
  flip(bytes, dataoff - 1);
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason: `Page 2 (bytes 8192-${dataoff - 1}) does not match its signed hash, so macOS will not run it.`,
  });
});

test('a binary cut short of its code signature is refused', () => {
  const { bytes, dataoff } = signedMachO();
  const cut = bytes.slice(0, dataoff + 8);
  expect(signedArm64MachO(cut)).toEqual({
    ok: false,
    reason: `The binary is truncated: its code signature runs to byte ${bytes.length}, past the file's ${cut.length} bytes.`,
  });
});

test('a code signature that is not a SuperBlob is refused', () => {
  const { bytes, dataoff } = signedMachO();
  new DataView(bytes.buffer).setUint32(dataoff, CSMAGIC_CODEDIRECTORY);
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason: 'The code signature is malformed: it is not an embedded-signature SuperBlob.',
  });
});

test('a SuperBlob whose CodeDirectory slot holds something else is refused', () => {
  const { bytes, codeDirectory } = signedMachO();
  new DataView(bytes.buffer).setUint32(codeDirectory, CSMAGIC_EMBEDDED_SIGNATURE);
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason:
      'The code signature is malformed: its CodeDirectory slot does not hold a CodeDirectory.',
  });
});

test('a SuperBlob with no CodeDirectory slot is refused', () => {
  const { bytes, dataoff } = signedMachO();
  new DataView(bytes.buffer).setUint32(dataoff + 12, 0x1_00_00); // the CMS signature slot
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason: 'The code signature has no CodeDirectory.',
  });
});

test('a code signature that hashes with something other than SHA-256 is refused', () => {
  const { bytes, codeDirectory } = signedMachO();
  bytes[codeDirectory + 37] = CS_HASHTYPE_SHA1;
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason: 'The code signature hashes with type 1, not SHA-256 (2).',
  });
  const short = signedMachO();
  short.bytes[short.codeDirectory + 36] = 20;
  expect(signedArm64MachO(short.bytes)).toEqual({
    ok: false,
    reason: "The code signature's hashes are 20 bytes, not SHA-256's 32.",
  });
});

test('a code signature that does not cover the file up to the signature is refused', () => {
  const { bytes, dataoff, codeDirectory } = signedMachO();
  new DataView(bytes.buffer).setUint32(codeDirectory + 32, dataoff - PAGE);
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason: `The code signature covers ${dataoff - PAGE} bytes, but the signature starts at byte ${dataoff}.`,
  });
});

test('a code signature with fewer page hashes than signed pages is refused', () => {
  const { bytes, codeDirectory } = signedMachO();
  new DataView(bytes.buffer).setUint32(codeDirectory + 28, 1);
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason: 'The code signature has 1 page hashes, but its 8492 signed bytes are 3 pages.',
  });
});

test('a CodeDirectory whose identifier is outside it or unterminated is refused', () => {
  const pastDirectory = signedMachO();
  new DataView(pastDirectory.bytes.buffer).setUint32(pastDirectory.codeDirectory + 20, 65_536);
  expect(signedArm64MachO(pastDirectory.bytes)).toEqual({
    ok: false,
    reason:
      'The code signature is malformed: its identifier is not a string inside its CodeDirectory.',
  });
  const insideHeader = signedMachO();
  new DataView(insideHeader.bytes.buffer).setUint32(insideHeader.codeDirectory + 20, 8);
  expect(signedArm64MachO(insideHeader.bytes).ok).toBe(false);
  const unterminated = signedMachO();
  const view = new DataView(unterminated.bytes.buffer);
  const length = view.getUint32(unterminated.codeDirectory + 4);
  view.setUint32(unterminated.codeDirectory + 20, length - 1);
  unterminated.bytes[unterminated.codeDirectory + length - 1] = 65;
  expect(signedArm64MachO(unterminated.bytes).ok).toBe(false);
});

test('special-slot hashes that would sit inside the CodeDirectory header are refused', () => {
  const { bytes, codeDirectory } = signedMachO();
  new DataView(bytes.buffer).setUint32(codeDirectory + 24, 2);
  expect(signedArm64MachO(bytes)).toEqual({
    ok: false,
    reason:
      'The code signature is malformed: its special-slot hashes overlap its CodeDirectory header.',
  });
});

test('signature offsets that point outside their blobs are refused rather than read', () => {
  const pastSuperBlob = signedMachO();
  new DataView(pastSuperBlob.bytes.buffer).setUint32(pastSuperBlob.dataoff + 16, 4096);
  expect(signedArm64MachO(pastSuperBlob.bytes)).toEqual({
    ok: false,
    reason: 'The code signature is malformed: its CodeDirectory runs past the SuperBlob.',
  });
  const superBlobPastSignature = signedMachO();
  new DataView(superBlobPastSignature.bytes.buffer).setUint32(
    superBlobPastSignature.dataoff + 4,
    4_294_967_295, // 0xffffffff
  );
  expect(signedArm64MachO(superBlobPastSignature.bytes)).toEqual({
    ok: false,
    reason: 'The code signature is malformed: its SuperBlob runs past the signature.',
  });
  const hashesPastCodeDirectory = signedMachO();
  new DataView(hashesPastCodeDirectory.bytes.buffer).setUint32(
    hashesPastCodeDirectory.codeDirectory + 16,
    4_294_967_040, // 0xffffff00
  );
  expect(signedArm64MachO(hashesPastCodeDirectory.bytes)).toEqual({
    ok: false,
    reason: 'The code signature is malformed: its page hashes run past its CodeDirectory.',
  });
  const shortLoadCommand = machO(CPU_TYPE_ARM64, [{ cmd: LC_CODE_SIGNATURE, size: 8 }]);
  expect(signedArm64MachO(shortLoadCommand)).toEqual({
    ok: false,
    reason: 'The binary is malformed: its code signature load command is too small to locate it.',
  });
});

test('an arm64 Mach-O without a code signature is refused, since macOS will not run it', () => {
  const result = signedArm64MachO(machO(CPU_TYPE_ARM64, [{ cmd: LC_SEGMENT_64, size: 72 }]));
  expect(result).toEqual({
    ok: false,
    reason: 'The binary has no code signature, so macOS on arm64 will not run it.',
  });
});

test('a Mach-O for another architecture is refused', () => {
  const result = signedArm64MachO(machO(CPU_TYPE_X86_64, [{ cmd: LC_CODE_SIGNATURE, size: 16 }]));
  expect(result).toEqual({
    ok: false,
    reason: 'The binary is a Mach-O for CPU type 0x1000007, not arm64.',
  });
});

test('a file that is not a 64-bit Mach-O is refused', () => {
  expect(signedArm64MachO(new TextEncoder().encode('#!/bin/sh\necho hugi\n'))).toEqual({
    ok: false,
    reason: 'The binary is not a 64-bit Mach-O.',
  });
});

test('load commands that run past the header are refused rather than read', () => {
  const moreCommandsThanBytes = machO(CPU_TYPE_ARM64, [{ cmd: LC_SEGMENT_64, size: 72 }]);
  new DataView(moreCommandsThanBytes.buffer).setUint32(16, 3, true);
  expect(signedArm64MachO(moreCommandsThanBytes)).toEqual({
    ok: false,
    reason: 'The binary is malformed: its load commands run past their stated size.',
  });
  const sizeofcmdsPastTheFile = machO(CPU_TYPE_ARM64, [{ cmd: LC_CODE_SIGNATURE, size: 16 }]);
  new DataView(sizeofcmdsPastTheFile.buffer).setUint32(20, 4096, true);
  expect(signedArm64MachO(sizeofcmdsPastTheFile).ok).toBe(false);
  const zeroSized = machO(CPU_TYPE_ARM64, [{ cmd: LC_SEGMENT_64, size: 8 }]);
  new DataView(zeroSized.buffer).setUint32(36, 0, true);
  expect(signedArm64MachO(zeroSized)).toEqual({
    ok: false,
    reason: 'The binary is malformed: a load command is smaller than its header.',
  });
});

test('a tag of decimal numbers that names the package version is that version', () => {
  expect(releaseVersion('v0.1.0', '0.1.0')).toEqual({ ok: true, version: '0.1.0' });
  expect(releaseVersion('v10.20.30', '10.20.30')).toEqual({ ok: true, version: '10.20.30' });
});

test('a tag outside v<digits>.<digits>.<digits> is refused', () => {
  for (const tag of [
    '0.1.0',
    'v0.1',
    'v0.1.0-rc.1',
    'v0.1.0+build',
    'v0.1.x',
    'release-0.1.0',
    'v0.1.0\n',
  ]) {
    const result = releaseVersion(tag, '0.1.0');
    expect(result.ok).toBe(false);
  }
});

test('a tag that differs from the package version is refused, naming both', () => {
  expect(releaseVersion('v0.2.0', '0.1.0')).toEqual({
    ok: false,
    reason: 'The tag v0.2.0 does not match package.json version 0.1.0.',
  });
});
