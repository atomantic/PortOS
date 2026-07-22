import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeReadStorage, safeReadJsonStorage, safeWriteStorage, safeWriteJsonStorage, safeRemoveStorage } from './safeStorage.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('safeStorage', () => {
  it('round-trips through a healthy localStorage', () => {
    expect(safeWriteStorage('k', 'v')).toBeUndefined();
    expect(safeReadStorage('k')).toBe('v');
    safeRemoveStorage('k');
    expect(safeReadStorage('k')).toBeNull();
  });

  it('returns null for a missing key (distinguishes absent from empty)', () => {
    expect(safeReadStorage('missing')).toBeNull();
    window.localStorage.setItem('empty', '');
    expect(safeReadStorage('empty')).toBe('');
  });

  it('returns null instead of throwing when getItem throws', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(safeReadStorage('k')).toBeNull();
  });

  it('reads JSON and returns the supplied fallback for missing or corrupt values', () => {
    window.localStorage.setItem('valid', JSON.stringify(['/brain/inbox']));
    window.localStorage.setItem('corrupt', '{not-json');

    expect(safeReadJsonStorage('valid', [])).toEqual(['/brain/inbox']);
    expect(safeReadJsonStorage('missing', [])).toEqual([]);
    expect(safeReadJsonStorage('corrupt', [])).toEqual([]);
  });

  it('writes JSON and swallows a circular-value serialization throw', () => {
    safeWriteJsonStorage('obj', { a: 1 });
    expect(safeReadJsonStorage('obj', null)).toEqual({ a: 1 });

    const circular = {};
    circular.self = circular;
    expect(() => safeWriteJsonStorage('circular', circular)).not.toThrow();
    expect(safeReadStorage('circular')).toBeNull();
  });

  it('swallows setItem / removeItem throws', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    expect(() => safeWriteStorage('k', 'v')).not.toThrow();
    expect(() => safeRemoveStorage('k')).not.toThrow();
  });
});
