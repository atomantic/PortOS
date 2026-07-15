import { describe, it, expect } from 'vitest';
import { resolveCityFocus } from './cityFocusState';

const apps = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
];

describe('resolveCityFocus', () => {
  it('reports no focus when there is no appId (overview)', () => {
    expect(resolveCityFocus(null, apps)).toEqual({ hasFocus: false, focusedApp: null, notFound: false });
    expect(resolveCityFocus('', apps)).toEqual({ hasFocus: false, focusedApp: null, notFound: false });
    expect(resolveCityFocus(undefined, apps)).toEqual({ hasFocus: false, focusedApp: null, notFound: false });
  });

  it('resolves a valid id to its app', () => {
    const res = resolveCityFocus('beta', apps);
    expect(res.hasFocus).toBe(true);
    expect(res.focusedApp).toBe(apps[1]);
    expect(res.notFound).toBe(false);
  });

  it('does NOT flag not-found while the app list is still loading (deep link + reload)', () => {
    const res = resolveCityFocus('beta', [], { loading: true });
    expect(res.hasFocus).toBe(true);
    expect(res.focusedApp).toBeNull();
    expect(res.notFound).toBe(false);
  });

  it('flags not-found for a stale/deleted id once loading has finished', () => {
    const res = resolveCityFocus('ghost', apps, { loading: false });
    expect(res.hasFocus).toBe(true);
    expect(res.focusedApp).toBeNull();
    expect(res.notFound).toBe(true);
  });

  it('tolerates a non-array app list', () => {
    expect(resolveCityFocus('alpha', null, { loading: false })).toEqual({
      hasFocus: true,
      focusedApp: null,
      notFound: true,
    });
  });
});
