import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useCityViewport, { classifyCityViewport } from './useCityViewport.js';

const setWidth = (w) => { window.innerWidth = w; };

afterEach(() => setWidth(1024));

describe('classifyCityViewport', () => {
  it('classifies phone / compact / desktop at the sm+lg breakpoints', () => {
    expect(classifyCityViewport(390)).toBe('phone');
    expect(classifyCityViewport(639)).toBe('phone');
    expect(classifyCityViewport(640)).toBe('compact');
    expect(classifyCityViewport(1023)).toBe('compact');
    expect(classifyCityViewport(1024)).toBe('desktop');
    expect(classifyCityViewport(1440)).toBe('desktop');
  });
});

describe('useCityViewport', () => {
  it('reports the initial bracket from the current width', () => {
    setWidth(390);
    const { result } = renderHook(() => useCityViewport());
    expect(result.current.mode).toBe('phone');
    expect(result.current.isPhone).toBe(true);
    expect(result.current.isCondensed).toBe(true);
    expect(result.current.isDesktop).toBe(false);
  });

  it('updates on resize across brackets', () => {
    setWidth(1440);
    const { result } = renderHook(() => useCityViewport());
    expect(result.current.isDesktop).toBe(true);

    act(() => { setWidth(800); window.dispatchEvent(new Event('resize')); });
    expect(result.current.isCompact).toBe(true);
    expect(result.current.isCondensed).toBe(true);

    act(() => { setWidth(375); window.dispatchEvent(new Event('resize')); });
    expect(result.current.isPhone).toBe(true);
  });
});
