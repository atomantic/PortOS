import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  safeReadStorage, safeReadJsonStorage, safeWriteStorage, safeWriteJsonStorage, safeRemoveStorage,
  safeReadJsonSession, safeWriteJsonSession, safeRemoveSession,
} from './safeStorage.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
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

  it('round-trips session JSON without touching localStorage', () => {
    safeWriteJsonSession('draft', { a: 1 });
    expect(safeReadJsonSession('draft')).toEqual({ a: 1 });
    // Session scope is the point: the same key must not have been persisted
    // where it would outlive the tab.
    expect(safeReadStorage('draft')).toBeNull();
    safeRemoveSession('draft');
    expect(safeReadJsonSession('draft', 'fallback')).toBe('fallback');
  });

  it('falls back on corrupt session JSON', () => {
    window.sessionStorage.setItem('corrupt', '{not-json');
    expect(safeReadJsonSession('corrupt', 'fallback')).toBe('fallback');
    expect(safeReadJsonSession('missing', 'fallback')).toBe('fallback');
  });

  it('swallows a session storage that throws on every access', () => {
    // Blocked storage (Safari private mode, a sandboxed iframe) throws from the
    // accessor itself, so the whole call has to be inside the guard.
    const boom = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    vi.stubGlobal('sessionStorage', { getItem: boom, setItem: boom, removeItem: boom });

    expect(() => safeWriteJsonSession('k', { a: 1 })).not.toThrow();
    expect(safeReadJsonSession('k', 'fallback')).toBe('fallback');
    expect(() => safeRemoveSession('k')).not.toThrow();
    vi.unstubAllGlobals();
  });
});
