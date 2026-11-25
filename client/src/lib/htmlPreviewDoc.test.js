// @vitest-environment node
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

  it('adds a standards-mode head and preserves the page or fragment', () => {
    expect(previewDocument('<html><body>hi</body></html>')).toMatch(/^<!doctype html><head><meta [^>]*><\/head><html><body>hi<\/body><\/html>$/);
    expect(previewDocument('<div>hi</div>')).toMatch(/^<!doctype html><head><meta [^>]*><\/head><div>hi<\/div>$/);
  });

  it.each([
    '<!-- <head> --><p>Preview</p>',
    '<html data-example="<head>"><body>Preview</body></html>',
    `<script>const label = '<head>';</script><p>Preview</p>`,
    '<img src="preview.png"><head></head><p>Preview</p>',
  ])('places the policy in a complete head before %s', (page) => {
    const output = previewDocument(`<!DOCTYPE html>${page}`);
    expect(output).toMatch(/^<!DOCTYPE html><head><meta http-equiv="Content-Security-Policy" content="[^"]+"><\/head>/);
    expect(output.slice(output.indexOf('</head>') + '</head>'.length)).toBe(page);
  });

  it('refuses network access while still allowing inline script and style', () => {
    const csp = policy(previewDocument('<html><head></head></html>'));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    for (const directive of ['base-uri', 'object-src', 'frame-src', 'worker-src', 'form-action']) {
      expect(csp.split('; ')).toContain(`${directive} 'none'`);
    }
    expect(csp).not.toMatch(/connect-src|https?:/);
  });
});
