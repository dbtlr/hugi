import { describe, expect, test } from 'bun:test';

import { skipsWorkflows } from './skip';

describe('skipsWorkflows', () => {
  const cases: [string, string, boolean][] = [
    ['[skip ci] in subject', 'fix: thing [skip ci]', true],
    ['[ci skip]', '[ci skip] wip', true],
    ['[no ci] in body', 'fix\n\nbody [no ci] more', true],
    ['[skip actions]', 'x [skip actions]', true],
    ['[actions skip]', 'x [actions skip]', true],
    ['trailer without space', 'fix\n\nbody\n\nskip-checks:true', true],
    ['trailer with space', 'fix\n\nbody\n\nskip-checks: true\n', true],
    ['trailer after other trailers', 'fix\n\nbody\n\nSigned-off-by: a\nskip-checks: true', true],
    ['CRLF trailer', 'fix\r\n\r\nskip-checks: true\r\n', true],
    ['plain message', 'fix: thing', false],
    ['near miss without brackets', 'skip ci', false],
    ['near miss other words', '[skip ci please]', false],
    ['near miss spacing', '[skip  ci]', false],
    ['trailer false', 'fix\n\nskip-checks: false', false],
    ['trailer in subject only', 'skip-checks: true', false],
    ['trailer not in final paragraph', 'fix\n\nskip-checks: true\n\nmore text', false],
    ['trailer value longer', 'fix\n\nskip-checks: trueish', false],
    ['trailer then blank lines', 'x\n\nskip-checks: true\n\n', true],
    ['trailer after two blank lines', 'fix\n\n\nskip-checks: true', true],
    ['whitespace-only line before trailer', 'fix\n  \t\nskip-checks: true', true],
    ['trailing spaces on trailer lines', 'fix\n\nSigned-off-by: a  \nskip-checks: true \t', true],
    ['trailer before another trailer', 'fix\n\nskip-checks: true\nSigned-off-by: a <a@b>', false],
    ['trailer after only blank lines', '\n\nskip-checks: true', false],
    ['trailer indented', 'fix\n\n  skip-checks: true', false],
    ['trailer in subject then blank lines', 'skip-checks: true\n\n', false],
    ['bracket instruction in another case', '[SKIP CI] fix', false],
  ];
  test.each(cases)('%s', (_, message, expected) => {
    expect(skipsWorkflows(message)).toBe(expected);
  });
});
