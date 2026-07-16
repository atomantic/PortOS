import { describe, it, expect } from 'vitest';
import { htmlToText } from './htmlToText.js';

describe('htmlToText', () => {
  it('drops script/style/head/noscript blocks and strips tags', () => {
    const html = '<html><head><title>x</title><style>.a{}</style></head><body>' +
      '<script>var a = 1;</script><noscript>enable js</noscript><p>Hello</p></body></html>';
    const text = htmlToText(html);
    expect(text).toBe('Hello');
    expect(text).not.toContain('var a');
    expect(text).not.toContain('enable js');
  });

  it('converts <br> and block closes to newlines', () => {
    expect(htmlToText('a<br>b</div>c</li>d</tr>e</h2>f')).toBe('a\nb\nc\nd\ne\nf');
  });

  it('uses a single newline for </p> by default', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('honors paragraphBreak for </p> (Gmail keeps blank lines)', () => {
    expect(htmlToText('<p>one</p><p>two</p>', { paragraphBreak: '\n\n' })).toBe('one\n\ntwo');
  });

  it('decodes entities including nbsp and caller extras', () => {
    expect(htmlToText('C&nbsp;&nbsp;G &amp; &#65;&#x42;')).toBe('C  G & AB');
    expect(htmlToText('a&zwnj;b', { extraEntities: { zwnj: '' } })).toBe('ab');
  });

  it('leaves out-of-range numeric entities untouched (never throws)', () => {
    expect(htmlToText('&#x110000; ok')).toBe('&#x110000; ok');
  });

  it('preserves inner space runs by default (tab-sheet alignment)', () => {
    expect(htmlToText('<pre>C      G</pre>')).toBe('C      G');
  });

  it('collapses space/tab runs when collapseSpaces is set', () => {
    expect(htmlToText('a \t  b', { collapseSpaces: true })).toBe('a b');
  });

  it('normalizes CRLF and collapses 3+ newlines, then trims', () => {
    expect(htmlToText('\n\na\r\n\r\n\r\nb\n\n')).toBe('a\n\nb');
  });

  it('returns "" for non-strings', () => {
    expect(htmlToText(null)).toBe('');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText(42)).toBe('');
  });
});
