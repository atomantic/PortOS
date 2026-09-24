import { describe, expect, it } from 'vitest';
import { itermStyleToSgr, renderItermFrame, renderItermSnapshot } from './itermScreenRender.js';

const E = '\x1b[';

describe('itermStyleToSgr', () => {
  it('maps truecolor, palette, default colors and attributes', () => {
    expect(itermStyleToSgr(undefined)).toBe('0');
    expect(itermStyleToSgr({ fgAlternate: 0, bgAlternate: 0 })).toBe('0');
    expect(itermStyleToSgr({ fgRgb: { red: 255, green: 16, blue: 0 } })).toBe('0;38;2;255;16;0');
    // Palette index 0 (black) is a real color, not "unset".
    expect(itermStyleToSgr({ fgStandard: 0, bgStandard: 200 })).toBe('0;38;5;0;48;5;200');
    expect(itermStyleToSgr({ bold: true, faint: true, italic: true, underline: true, inverse: true, strikethrough: true }))
      .toBe('0;1;2;3;4;7;9');
  });
});

describe('renderItermFrame', () => {
  it('positions every row, emits SGR only on style changes, and clears stale rows', () => {
    const red = { fgStandard: 1, repeats: 2 };
    const plain = { repeats: 3 };
    const frame = renderItermFrame({
      lines: [{ text: 'hello', style: [red, plain] }],
      cursor: { x: 5, y: 0 },
      firstVisibleLine: 0,
      cols: 10,
      rows: 2,
    });
    expect(frame.startsWith(`${E}?25l${E}H`)).toBe(true);
    expect(frame).toContain(`${E}1;1H${E}0;38;5;1mhe${E}0mllo${E}0m${E}K`);
    expect(frame).toContain(`${E}2;1H${E}0m${E}K`);
    expect(frame.endsWith(`${E}1;6H${E}?25h`)).toBe(true);
  });

  it('keeps wide and combined characters column-aligned via code-point runs', () => {
    // Cells: 'a', '界' (wide), its right half (0 code points), 'e'+U+0301 (2 code points), 'z'.
    const frame = renderItermFrame({
      lines: [{
        text: 'a界éz',
        codePointsPerCell: [
          { numCodePoints: 1, repeats: 2 },
          { numCodePoints: 0 },
          { numCodePoints: 2 },
          { numCodePoints: 1 },
        ],
      }],
      cols: 5,
      rows: 1,
    });
    expect(frame).toContain(`${E}1;1H${E}0ma界éz${E}0m${E}K`);
  });

  it('offsets the scrollback-absolute cursor by the first visible line', () => {
    const frame = renderItermFrame({ lines: [], cursor: { x: 2, y: 1041 }, firstVisibleLine: 1000, cols: 80, rows: 50 });
    expect(frame.endsWith(`${E}42;3H${E}?25h`)).toBe(true);
  });

  it('neutralizes control characters so screen text cannot inject escapes', () => {
    const frame = renderItermFrame({ lines: [{ text: 'a\x1b[2Jb' }], cols: 10, rows: 1 });
    expect(frame).toContain('a [2Jb');
    expect(frame).not.toContain('\x1b[2J');
  });
});

describe('renderItermSnapshot', () => {
  it('seeds prior rows into scrollback before painting the current screen', () => {
    const snapshot = renderItermSnapshot({
      lines: [{ text: 'prior output' }, { text: 'current prompt' }, { text: '$ ' }],
      firstVisibleLine: 501,
      rangeStartLine: 500,
      cursor: { x: 2, y: 502 },
      cols: 20,
      rows: 2,
    });

    expect(snapshot.indexOf('prior output')).toBeLessThan(snapshot.indexOf('current prompt'));
    expect(snapshot).toContain('\r\n\r\n');
    expect(snapshot.endsWith(`${E}2;3H${E}?25h`)).toBe(true);
  });

  it('does not invent scrollback when the returned range starts at the live screen', () => {
    const snapshot = renderItermSnapshot({
      lines: [{ text: '$ ' }],
      firstVisibleLine: 501,
      rangeStartLine: 501,
      cols: 20,
      rows: 2,
    });

    expect(snapshot.startsWith(`${E}?25l${E}H`)).toBe(true);
    expect(snapshot).not.toContain('\r\n');
  });
});
