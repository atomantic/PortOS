import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import useUrlParams from './useUrlParams';

// MemoryRouter so `useSearchParams` resolves; `useLocation` lets the assertions
// read back the resulting URL — the deep-link contract this hook defines —
// and `useNavigate` lets the push-vs-replace test walk the history stack.
const renderWithRouter = (initial = '/x') => {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
  return renderHook(() => ({
    pair: useUrlParams(),
    location: useLocation(),
    navigate: useNavigate(),
  }), { wrapper });
};

const params = (result) => new URLSearchParams(result.current.location.search);

describe('useUrlParams', () => {
  it('exposes the current search params', () => {
    const { result } = renderWithRouter('/x?type=character&q=hi');
    expect(result.current.pair[0].get('type')).toBe('character');
    expect(result.current.pair[0].get('q')).toBe('hi');
  });

  it('writes a patched key into the URL', () => {
    const { result } = renderWithRouter();
    act(() => result.current.pair[1]({ type: 'place' }));
    expect(params(result).get('type')).toBe('place');
  });

  it('merges the patch, preserving unrelated params', () => {
    const { result } = renderWithRouter('/x?universe=u1&view=albums');
    act(() => result.current.pair[1]({ type: 'place' }));
    const p = params(result);
    expect(p.get('universe')).toBe('u1');
    expect(p.get('view')).toBe('albums');
    expect(p.get('type')).toBe('place');
  });

  it("deletes keys patched to '' so a cleared filter leaves the URL clean", () => {
    const { result } = renderWithRouter('/x?type=place&tag=t1');
    act(() => result.current.pair[1]({ type: '' }));
    const p = params(result);
    expect(p.has('type')).toBe(false);
    expect(p.get('tag')).toBe('t1');
  });

  it('deletes keys patched to null or undefined', () => {
    const { result } = renderWithRouter('/x?a=1&b=2&c=3');
    act(() => result.current.pair[1]({ a: null, b: undefined }));
    const p = params(result);
    expect(p.has('a')).toBe(false);
    expect(p.has('b')).toBe(false);
    expect(p.get('c')).toBe('3');
  });

  it('clears every key of a multi-key reset patch at once', () => {
    const { result } = renderWithRouter('/x?type=a&universe=b&series=c&tag=d&q=e&view=albums');
    act(() => result.current.pair[1]({ type: '', universe: '', series: '', tag: '', q: '' }));
    const p = params(result);
    expect([...p.keys()]).toEqual(['view']);
  });

  it('writes falsy-but-meaningful values instead of clearing them', () => {
    // Only null/undefined/'' clear — `false` and `0` are legitimate filter
    // states and must survive into a shared link.
    const { result } = renderWithRouter();
    act(() => result.current.pair[1]({ flag: false, page: 0 }));
    const p = params(result);
    expect(p.get('flag')).toBe('false');
    expect(p.get('page')).toBe('0');
  });

  it('pushes by default so Back returns to the prior filter', () => {
    const { result } = renderWithRouter();
    act(() => result.current.pair[1]({ a: '1' }));
    act(() => result.current.pair[1]({ b: '2' }));
    act(() => result.current.navigate(-1));
    expect(result.current.location.search).toBe('?a=1');
  });

  it('replaces when asked so debounced mirrors do not spam history', () => {
    const { result } = renderWithRouter();
    act(() => result.current.pair[1]({ a: '1' }));
    act(() => result.current.pair[1]({ b: '2' }, { replace: true }));
    expect(params(result).get('b')).toBe('2');
    // The replace landed on top of the push, so one Back step reaches the
    // pristine URL rather than `?a=1&b=2`'s predecessor.
    act(() => result.current.navigate(-1));
    expect(result.current.location.search).toBe('');
  });

  it('composes two patches fired back-to-back in one tick', () => {
    // The router has not re-rendered between the two calls, so the second must
    // not clone a pre-first-patch snapshot and drop the key the first just set.
    const { result } = renderWithRouter('/x?a=1');
    act(() => {
      result.current.pair[1]({ b: '2' });
      result.current.pair[1]({ c: '3' });
    });
    const p = params(result);
    expect(p.get('a')).toBe('1');
    expect(p.get('b')).toBe('2');
    expect(p.get('c')).toBe('3');
  });

  it('keeps updateParams referentially stable across param changes', () => {
    // Effects that list `updateParams` as a dependency (the debounced `?q=`
    // mirrors in Catalog/MediaCollections) must not re-arm every time an
    // unrelated param changes.
    const { result } = renderWithRouter();
    const first = result.current.pair[1];
    act(() => first({ type: 'place' }));
    expect(result.current.pair[1]).toBe(first);
  });

  it('reads the live params, not the render-time snapshot, from a stale callback', () => {
    // react-router's functional `setSearchParams` updater closes over the
    // params of the render that memoized it. A debounced write armed before an
    // unrelated change would drop that change; this hook must not.
    const { result } = renderWithRouter();
    const stale = result.current.pair[1]; // captured before any navigation
    act(() => result.current.pair[1]({ sort: 'newest' }));
    act(() => stale({ q: 'hello' }));
    const p = params(result);
    expect(p.get('sort')).toBe('newest');
    expect(p.get('q')).toBe('hello');
  });
});
