import { describe, it, expect } from 'vitest';
import { decodeXmlEntities } from './xmlEntities.js';

describe('decodeXmlEntities', () => {
  it('returns the input unchanged when there are no entities', () => {
    expect(decodeXmlEntities('plain text')).toBe('plain text');
    expect(decodeXmlEntities('')).toBe('');
  });

  it('returns non-strings unchanged', () => {
    expect(decodeXmlEntities(undefined)).toBe(undefined);
    expect(decodeXmlEntities(null)).toBe(null);
    expect(decodeXmlEntities(42)).toBe(42);
  });

  it('decodes the five predefined named entities', () => {
    expect(decodeXmlEntities('A &amp; B')).toBe('A & B');
    expect(decodeXmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeXmlEntities('say &quot;hi&quot;')).toBe('say "hi"');
    expect(decodeXmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes decimal numeric references', () => {
    expect(decodeXmlEntities('&#39;')).toBe("'");
    expect(decodeXmlEntities('&#039;')).toBe("'"); // leading-zero form
    expect(decodeXmlEntities('caf&#233;')).toBe('café');
  });

  it('decodes hex numeric references (XML-conformant lowercase x)', () => {
    expect(decodeXmlEntities('caf&#xe9;')).toBe('café');
    expect(decodeXmlEntities('&#x1F600;')).toBe(String.fromCodePoint(0x1f600)); // emoji, multi-byte
  });

  it('leaves unknown named entities untouched', () => {
    expect(decodeXmlEntities('&bogus;')).toBe('&bogus;');
    expect(decodeXmlEntities('&nbsp;')).toBe('&nbsp;'); // not predefined without extras
  });

  it('does not throw and leaves out-of-range numeric references untouched', () => {
    expect(() => decodeXmlEntities('&#999999999999;')).not.toThrow();
    expect(decodeXmlEntities('&#999999999999;')).toBe('&#999999999999;');
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;'); // just past U+10FFFF
    expect(decodeXmlEntities('&#x10FFFF;')).toBe(String.fromCodePoint(0x10ffff)); // max valid
  });

  it('is double-decode safe in a single pass (&amp;lt; → &lt;, not <)', () => {
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeXmlEntities('a &amp;amp; b')).toBe('a &amp; b');
  });

  it('applies caller-supplied extra named entities, including empty-string targets', () => {
    expect(decodeXmlEntities('one&nbsp;two', { nbsp: ' ' })).toBe('one two');
    expect(decodeXmlEntities('zero&zwnj;width', { zwnj: '' })).toBe('zerowidth');
    // extras compose with the predefined set in one pass
    expect(decodeXmlEntities('a&nbsp;&amp;&nbsp;b', { nbsp: ' ' })).toBe('a & b');
  });
});
