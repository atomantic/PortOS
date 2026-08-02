import { describe, it, expect } from 'vitest';
import { markdownToPlainText } from './markdownText';

describe('markdownToPlainText', () => {
  it('returns an empty string for non-string / empty input', () => {
    expect(markdownToPlainText(undefined)).toBe('');
    expect(markdownToPlainText(null)).toBe('');
    expect(markdownToPlainText('')).toBe('');
    expect(markdownToPlainText(42)).toBe('');
    expect(markdownToPlainText({ text: 'hi' })).toBe('');
  });

  it('strips heading markers so a foreign body cannot hijack the page outline', () => {
    expect(markdownToPlainText('## Summary\nBackup failed'))
      .toBe('Summary\nBackup failed');
    expect(markdownToPlainText('###### Deep')).toBe('Deep');
    // Not a heading — no space after the hashes.
    expect(markdownToPlainText('#hashtag')).toBe('#hashtag');
  });

  it('unwraps emphasis, inline code, and links to their text', () => {
    expect(markdownToPlainText('**bold** and *italic* and `code`'))
      .toBe('bold and italic and code');
    expect(markdownToPlainText('__bold__ and _italic_ and ~~gone~~'))
      .toBe('bold and italic and gone');
    expect(markdownToPlainText('see [the report](/data/reports/x.html)'))
      .toBe('see the report');
  });

  it('scopes emphasis to a single line so a stray marker cannot swallow the body', () => {
    // An unclosed `**` in an agent-authored body must leave the rest of the
    // document intact (and must not backtrack across it): the marker on the
    // first line stays, and a genuine pair on a later line still unwraps.
    expect(markdownToPlainText('open **here\nplain line\n**closed** later'))
      .toBe('open **here\nplain line\nclosed later');
  });

  it('renders images as a bracketed alt placeholder rather than a URL', () => {
    expect(markdownToPlainText('![a diagram](/img/x.png)')).toBe('[a diagram]');
    expect(markdownToPlainText('![](/img/x.png)')).toBe('[image]');
  });

  it('normalizes list and blockquote markers', () => {
    expect(markdownToPlainText('- one\n* two\n+ three')).toBe('• one\n• two\n• three');
    expect(markdownToPlainText('1. first\n2) second')).toBe('1. first\n2. second');
    expect(markdownToPlainText('> quoted line')).toBe('quoted line');
  });

  it('drops code fences but keeps the code inside', () => {
    expect(markdownToPlainText('```js\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(markdownToPlainText('~~~\nraw\n~~~')).toBe('raw');
  });

  it('drops thematic breaks and HTML comments', () => {
    expect(markdownToPlainText('before\n\n---\n\nafter')).toBe('before\nafter');
    expect(markdownToPlainText('kept <!-- hidden --> text')).toBe('kept text');
  });

  it('collapses blank-line runs and trailing whitespace so the clamp shows real words', () => {
    expect(markdownToPlainText('one\n\n\n\ntwo   \n\n  three')).toBe('one\ntwo\nthree');
    expect(markdownToPlainText('   spaced    out   ')).toBe('spaced out');
  });

  it('leaves a plain stack trace readable', () => {
    const trace = 'TypeError: x is not a function\n    at foo (/app/a.js:1:2)\n    at bar (/app/b.js:3:4)';
    expect(markdownToPlainText(trace))
      .toBe('TypeError: x is not a function\nat foo (/app/a.js:1:2)\nat bar (/app/b.js:3:4)');
  });
});
