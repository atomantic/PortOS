import { describe, expect, it } from 'vitest';
import { PAGE_SIZES, PAGE_SIZE_NAMES, DEFAULT_PAGE_SIZE, resolvePageSize } from './pdfPageSizes.js';

describe('resolvePageSize', () => {
  it.each(PAGE_SIZE_NAMES)('keeps the catalog size %s', (size) => {
    expect(resolvePageSize(size)).toBe(size);
  });

  it.each([undefined, null, '', 'letter', 42, {}])('falls back to the default for %j', (size) => {
    expect(resolvePageSize(size)).toBe(DEFAULT_PAGE_SIZE);
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'never resolves the Object.prototype key %s', (size) => {
      const resolved = resolvePageSize(size);
      expect(resolved).toBe(DEFAULT_PAGE_SIZE);
      expect(PAGE_SIZES[resolved].width).toBeGreaterThan(0);
    });
});
