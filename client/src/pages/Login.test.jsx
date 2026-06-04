import { describe, it, expect } from 'vitest';
import { sanitizeNext } from './Login';

// Open-redirect regression: an attacker who can craft a /login URL must not
// be able to bounce the signed-in user off-origin or execute script.
describe('Login sanitizeNext', () => {
  it('accepts a same-origin app path', () => {
    expect(sanitizeNext('/')).toBe('/');
    expect(sanitizeNext('/brain/inbox')).toBe('/brain/inbox');
    expect(sanitizeNext('/settings/security?tab=password')).toBe('/settings/security?tab=password');
  });

  it('rejects absolute URLs', () => {
    expect(sanitizeNext('https://attacker.example')).toBe('/');
    expect(sanitizeNext('http://attacker.example')).toBe('/');
  });

  it('rejects protocol-relative URLs', () => {
    expect(sanitizeNext('//attacker.example')).toBe('/');
    expect(sanitizeNext('//evil.com/path')).toBe('/');
  });

  it('rejects non-http schemes', () => {
    expect(sanitizeNext('javascript:alert(1)')).toBe('/');
    expect(sanitizeNext('data:text/html,<script>...</script>')).toBe('/');
    expect(sanitizeNext('file:///etc/passwd')).toBe('/');
  });

  it('rejects empty / non-string inputs', () => {
    expect(sanitizeNext(null)).toBe('/');
    expect(sanitizeNext(undefined)).toBe('/');
    expect(sanitizeNext('')).toBe('/');
    expect(sanitizeNext(123)).toBe('/');
  });

  it('rejects backslash-prefixed paths some browsers normalize to //', () => {
    expect(sanitizeNext('/\\attacker.example')).toBe('/');
  });
});
