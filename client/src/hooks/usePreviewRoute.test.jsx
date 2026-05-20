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

  it('setPreview(item) writes the filename to the URL', () => {
    const { result } = renderWithRouter([FOO, BAR]);
    act(() => result.current.pair[1](BAR));
    expect(result.current.location.search).toContain('preview=bar.png');
    expect(result.current.pair[0]).toBe(BAR);
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
    expect(result.current.location.search).toContain('preview=bar.png');
    expect(result.current.pair[0]).toBe(BAR);
  });
});
