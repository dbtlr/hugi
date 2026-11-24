import { describe, expect, test } from 'bun:test';

import { cleanLogText, LOG_LIMIT_BYTES, logTextOf } from './log-text';

const ESC = '\u001B';

describe('cleaning a log for the page', () => {
  test.each([
    ['colour codes', `${ESC}[1;31merror${ESC}[0m: boom`, 'error: boom'],
    ['a cursor move with private parameters', `a${ESC}[?25lb${ESC}[2K`, 'ab'],
    ['an OSC title ended by BEL', `${ESC}]0;my title\u0007done`, 'done'],
    ['an OSC hyperlink ended by ST', `${ESC}]8;;https://x${ESC}\\link${ESC}]8;;${ESC}\\`, 'link'],
    ['a DCS string', `a${ESC}P1$r0m${ESC}\\b`, 'ab'],
    ['a two-byte escape', `a${ESC}=b${ESC}(Bc`, 'abc'],
    ['an 8-bit CSI', 'a\u009B31mb', 'ab'],
    ['a lone ESC at the end', `done${ESC}`, 'done'],
  ])('removes %s', (_name, input, output) => {
    expect(cleanLogText(input)).toBe(output);
  });

  test('removes control characters but newline and tab', () => {
    expect(cleanLogText('a\u0000b\u0007c\td\u007Fe\u0085f\ng\u0008')).toBe('abc\tdef\ng');
  });

  test('a carriage return before a line break is dropped', () => {
    expect(cleanLogText('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });

  test('a carriage return elsewhere keeps only the text after it, as a terminal shows it', () => {
    expect(cleanLogText('10%\r50%\r100% done\nnext')).toBe('100% done\nnext');
  });

  test('a carriage return ending the log ends its last line', () => {
    expect(cleanLogText('working\r')).toBe('working');
  });

  test('an escape sequence does not hide a carriage return', () => {
    expect(cleanLogText(`old${ESC}[K\rnew`)).toBe('new');
  });

  test.each([
    ['a long run of carriage returns before a last character', `${'\r'.repeat(1024 * 1024)}x`, 'x'],
    ['the same run ending in a line break', `${'\r'.repeat(1024 * 1024)}x\n`, 'x\n'],
  ])('cleans %s in linear time', (_name, input, output) => {
    const started = performance.now();
    expect(cleanLogText(input)).toBe(output);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('ordinary text, markup characters included, is left as it is', () => {
    expect(cleanLogText('<b>&amp; "quoted"</b> ünïcödé ✓')).toBe('<b>&amp; "quoted"</b> ünïcödé ✓');
  });
});

describe('the text the page shows of a log', () => {
  test('a whole log is decoded and cleaned', () => {
    expect(logTextOf(Buffer.from(`${ESC}[32mok${ESC}[0m\r\n`), 0)).toEqual({
      cut: false,
      text: 'ok\n',
    });
  });

  test('bytes that are not UTF-8 show as replacement characters', () => {
    const bytes = Buffer.from([97, 255, 98, 195, 40, 10]);
    expect(logTextOf(bytes, 0).text).toBe('a�b�(\n');
  });

  test('a tail starts at the first whole line in it', () => {
    // The reader hands over one byte more than the limit, so it can tell a whole first line.
    const tail = Buffer.from(`${'x'.repeat(LOG_LIMIT_BYTES - 6)}\nlast\n`);
    expect(tail.length).toBe(LOG_LIMIT_BYTES);
    const read = Buffer.concat([Buffer.from('y'), tail]);
    expect(logTextOf(read, 10)).toEqual({ cut: true, text: 'last\n' });
  });

  test('a log read whole that is one byte over the limit is still cut', () => {
    // A file of exactly LOG_READ_BYTES is read from byte 0, look-behind byte included.
    const read = Buffer.from(`y${'x'.repeat(LOG_LIMIT_BYTES - 6)}\nlast\n`);
    expect(read.length).toBe(LOG_LIMIT_BYTES + 1);
    expect(logTextOf(read, 0)).toEqual({ cut: true, text: 'last\n' });
  });

  test('a tail whose first byte begins a line keeps that line', () => {
    const tail = `first\n${'x'.repeat(LOG_LIMIT_BYTES - 6)}`;
    const read = Buffer.concat([Buffer.from('\n'), Buffer.from(tail)]);
    expect(logTextOf(read, 10)).toEqual({ cut: true, text: tail });
  });

  test('a tail whose only line break is its last byte starts where the last 1 MiB starts', () => {
    const read = Buffer.from(`y${'x'.repeat(LOG_LIMIT_BYTES - 1)}\n`);
    expect(logTextOf(read, 10)).toEqual({
      cut: true,
      text: `${'x'.repeat(LOG_LIMIT_BYTES - 1)}\n`,
    });
  });

  test('a tail with no line break starts where the last 1 MiB starts', () => {
    const read = Buffer.from(`y${'x'.repeat(LOG_LIMIT_BYTES)}`);
    const shown = logTextOf(read, 10);
    expect(shown.cut).toBe(true);
    expect(shown.text).toBe('x'.repeat(LOG_LIMIT_BYTES));
  });
});
