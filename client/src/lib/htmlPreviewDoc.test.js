import { describe, expect, it } from 'vitest';
import { previewDocument } from './htmlPreviewDoc.js';

const policy = (doc) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';

describe('previewDocument', () => {
  it.each([
    '<!doctype html><html lang="en"><head><title>x</title></head><body><p>hi</p></body></html>',
    '<html><body>hi</body></html>',
    '<div>hi</div>',
  ])('puts the policy before the supplied markup in standards mode for %s', (page) => {
    const out = previewDocument(page);
    expect(out.replace(/^<!doctype html><meta http-equiv="Content-Security-Policy"[^>]*>/, '')).toBe(page);
  });

  it('refuses network access while still allowing inline script and style', () => {
    const csp = policy(previewDocument('<html><head></head></html>'));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).not.toMatch(/connect-src|https?:/);
  });
});
