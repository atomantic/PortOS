import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLocalStorageBool, useLocalStoragePersisted } from './useLocalStorageBool.js';

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('useLocalStorageBool', () => {
  it('falls back to the default when the key is missing', () => {
    const { result } = renderHook(() => useLocalStorageBool('missing', true));
    expect(result.current[0]).toBe(true);
  });

  it('accepts both legacy encodings on read', () => {
    window.localStorage.setItem('a', '1');
    window.localStorage.setItem('b', 'true');
    window.localStorage.setItem('c', '0');
    expect(renderHook(() => useLocalStorageBool('a')).result.current[0]).toBe(true);
    expect(renderHook(() => useLocalStorageBool('b')).result.current[0]).toBe(true);
    expect(renderHook(() => useLocalStorageBool('c', true)).result.current[0]).toBe(false);
  });

  it('writes in the configured format and supports updater functions', () => {
    const { result } = renderHook(() => useLocalStorageBool('flag', false, { format: 'true' }));
    act(() => result.current[1]((prev) => !prev));
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem('flag')).toBe('true');

    const numeric = renderHook(() => useLocalStorageBool('n', false));
    act(() => numeric.result.current[1](true));
    expect(window.localStorage.getItem('n')).toBe('1');
  });

  it('keeps the default when storage reads throw', () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    const { result } = renderHook(() => useLocalStorageBool('flag', true));
    expect(result.current[0]).toBe(true);
  });

  it('does not throw when storage writes throw', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useLocalStorageBool('flag', false));
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

describe('useLocalStoragePersisted', () => {
  it('hydrates stored JSON and persists updates', () => {
    window.localStorage.setItem('cfg', JSON.stringify({ a: 1 }));
    const { result } = renderHook(() => useLocalStoragePersisted('cfg', { a: 0 }));
    expect(result.current[0]).toEqual({ a: 1 });

    act(() => result.current[1]({ a: 2 }));
    expect(JSON.parse(window.localStorage.getItem('cfg'))).toEqual({ a: 2 });
  });

  it('applies the default for missing and corrupt entries without running parse', () => {
    window.localStorage.setItem('corrupt', '{not-json');
    const parse = vi.fn();
    expect(renderHook(() => useLocalStoragePersisted('missing', 'd', { parse })).result.current[0]).toBe('d');
    expect(renderHook(() => useLocalStoragePersisted('corrupt', 'd', { parse })).result.current[0]).toBe('d');
    expect(parse).not.toHaveBeenCalled();
  });

  it('runs parse on a stored null rather than treating it as missing', () => {
    window.localStorage.setItem('nullish', 'null');
    const parse = vi.fn(() => 'migrated');
    const { result } = renderHook(() => useLocalStoragePersisted('nullish', 'default', { parse }));
    expect(parse).toHaveBeenCalledWith(null);
    expect(result.current[0]).toBe('migrated');
  });
});
