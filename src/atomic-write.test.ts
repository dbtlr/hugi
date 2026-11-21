import { expect, test } from 'bun:test';
import { basename, dirname } from 'node:path';

import { temporaryPathFor } from './atomic-write';

test('a temporary name is hidden beside the target, with the pid and 8 random bytes', () => {
  const path = temporaryPathFor('/state/hugi/service.json');
  expect(dirname(path)).toBe('/state/hugi');
  // oxlint-disable-next-line @loomcli/host-bypass -- the name records this process
  const pattern = new RegExp(`^\\.service\\.json\\.${process.pid}\\.[0-9a-f]{16}\\.tmp$`, 'u');
  expect(basename(path)).toMatch(pattern);
  expect(temporaryPathFor('/state/hugi/service.json')).not.toBe(path);
});
