import { describe, it, expect, afterEach, vi } from 'vitest';
import { safeReadStorage, safeWriteStorage, safeRemoveStorage } from './safeStorage.js';

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
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(safeReadStorage('k')).toBeNull();
  });

  it('swallows setItem / removeItem throws', () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    vi.spyOn(window.localStorage.__proto__, 'removeItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    expect(() => safeWriteStorage('k', 'v')).not.toThrow();
    expect(() => safeRemoveStorage('k')).not.toThrow();
  });
});
