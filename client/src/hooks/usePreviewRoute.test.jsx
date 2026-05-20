import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import usePreviewRoute from './usePreviewRoute';

// Wraps the hook with a MemoryRouter so `useSearchParams` resolves. The
// second hook (`useLocation`) gives the assertions a peek at the resulting
// URL — that's the contract this hook is defining (deep-link friendliness),
// so it's what the tests assert on.
const renderWithRouter = (items, initial = '/x') => {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
  return renderHook(() => ({
    pair: usePreviewRoute(items),
    location: useLocation(),
  }), { wrapper });
};

const FOO = { key: 'image:foo.png', filename: 'foo.png', prompt: 'foo' };
const BAR = { key: 'image:bar.png', filename: 'bar.png', prompt: 'bar' };
const SHEET = { key: 'canon-sheet:foo.png', filename: 'foo.png', prompt: 'sheet' };

describe('usePreviewRoute', () => {
  it('returns null when no `preview` query param is present', () => {
    const { result } = renderWithRouter([FOO, BAR]);
    expect(result.current.pair[0]).toBeNull();
  });

  it('resolves the param to the matching item by filename', () => {
    const { result } = renderWithRouter([FOO, BAR], '/x?preview=bar.png');
    expect(result.current.pair[0]).toBe(BAR);
  });

  it('falls back to exact key match when filenames collide', () => {
    // SHEET listed first so a filename-only resolver would return it; the
    // key path is what lets a caller deep-link the gallery copy by key.
    const { result } = renderWithRouter([SHEET, FOO], '/x?preview=image:foo.png');
    expect(result.current.pair[0]).toBe(FOO);
  });

  it('returns null for a stale param that has no matching item', () => {
    const { result } = renderWithRouter([FOO], '/x?preview=does-not-exist.png');
    expect(result.current.pair[0]).toBeNull();
  });

  it('setPreview(item) writes the key (URL-encoded) when present', () => {
    // The URL contract is "write key, fall back to filename" — without the key
    // in the URL a basename-collision case (canon-sheet:foo.png vs
    // image:foo.png on the same items list) would open the wrong asset on
    // reload / share. URL search params encode `:` as `%3A`.
    const { result } = renderWithRouter([FOO, BAR]);
    act(() => result.current.pair[1](BAR));
    expect(result.current.location.search).toContain('preview=image%3Abar.png');
    expect(result.current.pair[0]).toBe(BAR);
  });

  it('setPreview(item) falls back to filename when key is absent', () => {
    const BAR_NO_KEY = { filename: 'bar.png', prompt: 'bar' };
    const { result } = renderWithRouter([{ filename: 'foo.png' }, BAR_NO_KEY]);
    act(() => result.current.pair[1](BAR_NO_KEY));
    expect(result.current.location.search).toContain('preview=bar.png');
    expect(result.current.pair[0]).toBe(BAR_NO_KEY);
  });

  it('keyed setPreview survives a basename collision on reload', () => {
    // SHEET and FOO share filename 'foo.png'. Writing the bare filename to the
    // URL would resolve back to whichever item is first in the list (FOO), so
    // setPreview(SHEET) followed by a reload would open the wrong asset. Writing
    // the key preserves identity.
    const { result } = renderWithRouter([FOO, SHEET]);
    act(() => result.current.pair[1](SHEET));
    expect(result.current.location.search).toContain('preview=canon-sheet%3Afoo.png');
    expect(result.current.pair[0]).toBe(SHEET);
  });

  it('setPreview(null) drops the preview param but preserves siblings', () => {
    const { result } = renderWithRouter([FOO, BAR], '/x?preview=foo.png&tab=cast');
    act(() => result.current.pair[1](null));
    expect(result.current.location.search).not.toContain('preview=');
    expect(result.current.location.search).toContain('tab=cast');
    expect(result.current.pair[0]).toBeNull();
  });

  it('prev/next round-trip swaps the param on the URL', () => {
    const { result } = renderWithRouter([FOO, BAR], '/x?preview=foo.png');
    expect(result.current.pair[0]).toBe(FOO);
    act(() => result.current.pair[1](BAR));
    expect(result.current.location.search).toContain('preview=image%3Abar.png');
    expect(result.current.pair[0]).toBe(BAR);
  });
});
