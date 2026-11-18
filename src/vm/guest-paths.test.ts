import { expect, test } from 'bun:test';

import {
  GUEST_CONTROL_DIR,
  GUEST_COMMAND_FILES,
  GUEST_RUNNER_PATHS,
  stepFiles,
} from './guest-paths';

const inside = (path: string, directory: string) => path.startsWith(`${directory}/`);

test('the runner keeps its control files outside RUNNER_TEMP and the workspace', () => {
  const { temp, workspace } = GUEST_RUNNER_PATHS;
  for (const directory of [temp, workspace]) {
    expect(inside(GUEST_CONTROL_DIR, directory)).toBe(false);
    expect(inside(directory, GUEST_CONTROL_DIR)).toBe(false);
  }
  const paths = [...Object.values(stepFiles(3)), ...Object.values(GUEST_COMMAND_FILES)];
  for (const path of paths) {
    expect(inside(path, GUEST_CONTROL_DIR)).toBe(true);
    expect(inside(path, temp)).toBe(false);
    expect(inside(path, workspace)).toBe(false);
  }
});

test('each step has a directory of its own', () => {
  expect(stepFiles(1).status).not.toBe(stepFiles(2).status);
  expect(stepFiles(12).status).toBe(`${GUEST_CONTROL_DIR}/step-12/status`);
});
