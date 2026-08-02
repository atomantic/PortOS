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

  it('leaves intra-word underscores alone so real data is not silently rewritten', () => {
    // These bodies are stack traces, user-agent strings and env dumps. Treating
    // an intra-word `_` as emphasis produces a corrupted-but-plausible preview,
    // which is worse than leaving the marker in — the reader can't tell.
    expect(markdownToPlainText('UA: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'))
      .toBe('UA: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(markdownToPlainText('    at __webpack_require__ (/assets/index.js:1:1)'))
      .toBe('at __webpack_require__ (/assets/index.js:1:1)');
    expect(markdownToPlainText('Set NODE_ENV=test and MEMORY_BACKEND=file'))
      .toBe('Set NODE_ENV=test and MEMORY_BACKEND=file');
    expect(markdownToPlainText('https://example.com/a_b_c/d')).toBe('https://example.com/a_b_c/d');
    // The trailing `_` of one identifier must not pair with the leading `_` of
    // the next and merge two unrelated words.
    expect(markdownToPlainText('do_work() then snake_case_name')).toBe('do_work() then snake_case_name');
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

  it('drops the spaced thematic-break forms instead of promoting them to bullets', () => {
    // `- - -` and `* * *` also match the bullet rule; if the bullet rule wins,
    // a divider becomes `• - -` and eats one of only three preview lines.
    expect(markdownToPlainText('before\n- - -\nafter')).toBe('before\nafter');
    expect(markdownToPlainText('before\n* * *\nafter')).toBe('before\nafter');
    expect(markdownToPlainText('before\n___\nafter')).toBe('before\nafter');
    // A real bullet is still a bullet.
    expect(markdownToPlainText('- an item')).toBe('• an item');
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
