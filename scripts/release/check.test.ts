import { expect, test } from 'bun:test';

import { checksums, releaseVersion, signedArm64MachO } from './check';

// The SHA-256 of the three bytes "abc", from FIPS 180-2's worked example.
const ABC = new TextEncoder().encode('abc');
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

test('SHA256SUMS that is the one line the installer reads, for this binary, passes', () => {
  expect(checksums(`${ABC_SHA256}  hugi-darwin-arm64\n`, ABC)).toEqual({ ok: true });
});

test('SHA256SUMS the installer would not find the binary in is refused', () => {
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

test('an arm64 Mach-O with a code signature load command passes', () => {
  const binary = machO(CPU_TYPE_ARM64, [
    { cmd: LC_SEGMENT_64, size: 72 },
    { cmd: LC_CODE_SIGNATURE, size: 16 },
  ]);
  expect(signedArm64MachO(binary)).toEqual({ ok: true });
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
