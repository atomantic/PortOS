/**
 * Print-PDF page-size catalog (us-letter, a4, tabloid) with an own-property lookup, kept free of pdf-lib so query schemas can import it.
 *
 * `resolvePageSize` exists because `PAGE_SIZES[x]` on a plain object is truthy for
 * `Object.prototype` keys (`constructor`, `__proto__`, `toString`), which would
 * hand pdf-lib a page of undefined width and height.
 */

export const PAGE_SIZES = Object.freeze({
  'us-letter': { width: 612, height: 792 },
  'a4':        { width: 595.28, height: 841.89 },
  'tabloid':   { width: 792, height: 1224 },
});
export const DEFAULT_PAGE_SIZE = 'us-letter';
export const PAGE_SIZE_NAMES = Object.freeze(Object.keys(PAGE_SIZES));

/** @returns {string} `size` when it names a catalog entry, else DEFAULT_PAGE_SIZE. */
export const resolvePageSize = (size) =>
  typeof size === 'string' && Object.hasOwn(PAGE_SIZES, size) ? size : DEFAULT_PAGE_SIZE;
