import { describe, expect, it, vi } from 'vitest';
import { registerTerminalWebLinks } from './terminalWebLinks';

function terminalLine(text, { wrapped = false, wide = [], padding = 0 } = {}) {
  const cells = [];
  for (const chars of text) {
    const width = wide.includes(chars) ? 2 : 1;
    cells.push({ chars, width });
    if (width === 2) cells.push({ chars: '', width: 0 });
  }
  for (let column = 0; column < padding; column++) cells.push({ chars: '', width: 1 });
  return {
    isWrapped: wrapped,
    length: cells.length,
    translateToString: () => text,
    getCell(column, cell) {
      Object.assign(cell, cells[column]);
      return cell;
    },
  };
}

function mountedProvider(lines, openWindow) {
  const terminal = {
    buffer: {
      active: {
        getLine: (index) => lines[index],
        getNullCell: () => ({
          getWidth() { return this.width; },
          getChars() { return this.chars; },
        }),
      },
    },
    registerLinkProvider: vi.fn(),
  };
  registerTerminalWebLinks(terminal, openWindow);
  const [[provider]] = terminal.registerLinkProvider.mock.calls;
  return (row = 1) => {
    const callback = vi.fn();
    provider.provideLinks(row, callback);
    expect(callback).toHaveBeenCalledTimes(1);
    return callback.mock.calls[0][0];
  };
}

describe('terminal web links', () => {
  it('finds HTTPS links, skips words and excludes closing punctuation', () => {
    const text = 'HTTPS://example.com/path';
    const provideLinks = mountedProvider([terminalLine('word (' + text + ').'), terminalLine('plain')]);
    expect(provideLinks()).toMatchObject([{
      text,
      range: { start: { x: 7, y: 1 }, end: { x: 6 + text.length, y: 1 } },
    }]);
    expect(provideLinks(2)).toEqual([]);
  });

  it('reports the same URL and range from both rows of a soft wrap', () => {
    const provideLinks = mountedProvider([
      terminalLine('https://exam'),
      terminalLine('ple.com', { wrapped: true }),
    ]);
    const link = {
      text: 'https://example.com',
      range: { start: { x: 1, y: 1 }, end: { x: 7, y: 2 } },
    };
    expect(provideLinks(1)).toMatchObject([link]);
    expect(provideLinks(2)).toMatchObject([link]);
  });

  it('counts wide cells and ignores the unused column before an early wrap', () => {
    const text = 'https://example.com';
    const provideLinks = mountedProvider([
      terminalLine('info', { padding: 1 }),
      terminalLine('界 ' + text, { wrapped: true, wide: ['界'] }),
    ]);
    expect(provideLinks(2)).toMatchObject([{
      text,
      range: { start: { x: 4, y: 2 }, end: { x: 3 + text.length, y: 2 } },
    }]);
  });

  it('keeps hard breaks and stops collecting wrapped rows at the context limit', () => {
    const provideLinks = mountedProvider([
      terminalLine('https://'),
      terminalLine('example.com'),
      terminalLine('https://example.com/'),
      terminalLine('a'.repeat(2048), { wrapped: true }),
      terminalLine('suffix', { wrapped: true }),
    ]);
    expect(provideLinks(1)).toEqual([]);
    expect(provideLinks(3)).toMatchObject([{
      text: 'https://example.com/' + 'a'.repeat(2048),
      range: { start: { x: 1, y: 3 }, end: { x: 2048, y: 4 } },
    }]);
  });

  it('rejects javascript and malformed HTTP authorities', () => {
    const provideLinks = mountedProvider([terminalLine('javascript:alert(1) https:///example.com https://:')]);
    expect(provideLinks()).toEqual([]);
  });

  it('clears the opener before navigating the window returned by the supplied opener', () => {
    const navigate = vi.fn(() => expect(popup.opener).toBeNull());
    const popup = { opener: {}, location: { set href(url) { navigate(url); } } };
    const openWindow = vi.fn(() => popup);
    const text = 'https://example.com';
    const [link] = mountedProvider([terminalLine(text)], openWindow)();
    link.activate({}, link.text);
    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith(text);
  });

  it('warns when the browser blocks the popup', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const [link] = mountedProvider([terminalLine('https://example.com')], () => null)();
      link.activate({}, link.text);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
