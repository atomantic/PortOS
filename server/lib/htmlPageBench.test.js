import { describe, expect, it } from 'vitest';
import {
  HTML_PAGE_DEFAULT_BRIEF, HTML_PAGE_DEFAULT_BRIEFS, HTML_PAGES_MAX, extractHtmlDocument, htmlPagePrompt, htmlPagePromptParts, scoreHtmlPage, scoreHtmlPages,
} from './htmlPageBench.js';

const good = `<!doctype html><html><head><style>body{margin:0}</style></head><body><canvas></canvas><script>${'let a=1;'.repeat(200)}</script></body></html>`;

describe('brief', () => {
  it('starts every page slot on the generic guidelines, which leave the subject to the model', () => {
    expect(HTML_PAGE_DEFAULT_BRIEFS).toHaveLength(HTML_PAGES_MAX);
    expect(new Set(HTML_PAGE_DEFAULT_BRIEFS)).toEqual(new Set([HTML_PAGE_DEFAULT_BRIEF]));
    expect(HTML_PAGE_DEFAULT_BRIEF).toBe('- look stunning\n- original\n- go full creative mode');
  });

  it('puts the brief into the prompt exactly as written, between the fixed parts the form shows', () => {
    const brief = '  Make a lighthouse.\n\nWith "quotes", {braces} and $1 in it.  ';
    const { before, after } = htmlPagePromptParts();
    expect(htmlPagePrompt(brief)).toBe(before + brief + after);
    expect(after).toContain('<!doctype html>');
  });
});

describe('extractHtmlDocument', () => {
  it('cuts the document out of a fence and preamble, unchanged', () => {
    expect(extractHtmlDocument(`Sure!\n\`\`\`html\n${good}\n\`\`\`\nEnjoy`)).toBe(good);
    expect(extractHtmlDocument(`Here it is: ${good}`)).toBe(good);
  });
  it('takes the last document start, so a plan that mentions the doctype is skipped', () => {
    expect(extractHtmlDocument(`I will start with <!doctype html> and then add <html lang="en"> tags.\n\n${good}`)).toBe(good);
  });
  it('does not treat reasoning prose that mentions tags as a page', () => {
    expect(extractHtmlDocument('Let me think. I will use an <svg> for the orbits and a <div> for the controls, then write the code.')).toBe('');
    expect(extractHtmlDocument('<header>bare fragment</header><main></main>')).toBe('<header>bare fragment</header><main></main>');
  });
  it('keeps a truncated document as truncated and returns nothing for a reply without HTML', () => {
    const cut = good.replace('</html>', '');
    expect(extractHtmlDocument(cut)).toBe(cut);
    expect(extractHtmlDocument('I cannot do that.')).toBe('');
    expect(extractHtmlDocument('')).toBe('');
  });
});

describe('scoreHtmlPage', () => {
  it('passes a complete self-contained document', () => {
    const { checks, passed, total } = scoreHtmlPage(good);
    expect(passed).toBe(total);
    expect(checks.every((c) => c.ok)).toBe(true);
  });
  it.each([
    ['an external script', good.replace('<script>', '<script src="https://cdn.example.com/a.js">'), 'self-contained'],
    ['a stylesheet import', good.replace('body{margin:0}', '@import url("https://fonts.example.com/f.css");'), 'self-contained'],
    ['a network request', good.replace('let a=1;', 'fetch("/api");'), 'self-contained'],
    ['a missing closing tag', good.replace('</html>', ''), 'document'],
    ['a stub', '<!doctype html><html><body>hi</body></html>', 'size'],
    ['placeholder style and script', good.replace(/<style>[\s\S]*?<\/style>/, '<style>...</style>').replace(/<script>[\s\S]*?<\/script>/, '<script>…</script>'), 'real-code'],
  ])('flags %s', (_label, html, id) => {
    expect(scoreHtmlPage(html).checks.find((c) => c.id === id).ok).toBe(false);
  });
  it('does not count a commented-out network call against the page', () => {
    expect(scoreHtmlPage(good.replace('let a=1;', '// fetch("x")\nlet a=1;')).checks.find((c) => c.id === 'self-contained').ok).toBe(true);
  });
});

describe('scoreHtmlPages', () => {
  it('is passed, partial or failed by how many pages are complete', () => {
    expect(scoreHtmlPages([{ html: good }, { html: good }]).verdict).toBe('passed');
    expect(scoreHtmlPages([{ html: good }, { html: '' }])).toMatchObject({ verdict: 'partial', complete: 1, pageCount: 2 });
    expect(scoreHtmlPages([{ html: '' }, { html: 'x' }]).verdict).toBe('failed');
    expect(scoreHtmlPages([]).verdict).toBe('failed');
  });
});
