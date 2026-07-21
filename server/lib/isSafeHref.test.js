import { describe, it, expect } from 'vitest';
import { isSafeHref } from './isSafeHref.js';

describe('isSafeHref', () => {
  it('allows http:// URLs', () => {
    expect(isSafeHref('http://x.com')).toBe(true);
  });

  it('allows https:// URLs', () => {
    expect(isSafeHref('https://x.com')).toBe(true);
  });

  it('rejects javascript: URLs', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isSafeHref('data:text/html,x')).toBe(false);
  });

  it('rejects vbscript: URLs', () => {
    expect(isSafeHref('vbscript:x')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSafeHref('')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isSafeHref(undefined)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeHref(42)).toBe(false);
    expect(isSafeHref(null)).toBe(false);
    expect(isSafeHref({})).toBe(false);
  });

  it('rejects a garbage non-URL string', () => {
    expect(isSafeHref('not a url at all')).toBe(false);
  });
});
