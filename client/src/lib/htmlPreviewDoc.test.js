import { describe, expect, it } from 'vitest';
import { previewDocument } from './htmlPreviewDoc.js';

const policy = (doc) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';

describe('previewDocument', () => {
  it('puts the policy first inside <head> and keeps the doctype and the page untouched', () => {
    const page = '<!doctype html><html lang="en"><head><title>x</title></head><body><script>run()</script></body></html>';
    const out = previewDocument(page);
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'));
    expect(out.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')).toBe(page);
  });

  it('adds a head when the page has none, and wraps a bare fragment', () => {
    expect(previewDocument('<html><body>hi</body></html>')).toMatch(/<html><head><meta [^>]*><\/head><body>hi<\/body><\/html>/);
    expect(previewDocument('<div>hi</div>')).toMatch(/^<!doctype html><html><head><meta [^>]*><\/head><body><div>hi<\/div><\/body><\/html>$/);
  });

  it('refuses network access while still allowing inline script and style', () => {
    const csp = policy(previewDocument('<html><head></head></html>'));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toMatch(/connect-src|https?:/);
  });
});
