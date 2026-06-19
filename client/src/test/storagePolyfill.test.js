import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMemoryStorage, storageWorks, ensureStorage, installTestStorage } from './storagePolyfill.js';

describe('storagePolyfill', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createMemoryStorage', () => {
    it('implements the Storage contract (set/get/remove/clear/length/key)', () => {
      const s = createMemoryStorage();
      expect(s.length).toBe(0);
      expect(s.getItem('missing')).toBe(null);

      s.setItem('a', '1');
      s.setItem('b', '2');
      expect(s.getItem('a')).toBe('1');
      expect(s.length).toBe(2);
      expect([s.key(0), s.key(1)]).toEqual(['a', 'b']);
      expect(s.key(99)).toBe(null);

      s.removeItem('a');
      expect(s.getItem('a')).toBe(null);
      expect(s.length).toBe(1);

      s.clear();
      expect(s.length).toBe(0);
    });

    it('coerces keys and values to strings, matching the DOM Storage spec', () => {
      const s = createMemoryStorage();
      s.setItem(1, 2);
      expect(s.getItem('1')).toBe('2');
      expect(s.getItem(1)).toBe('2');
    });
  });

  describe('storageWorks', () => {
    it('returns false for null/undefined', () => {
      expect(storageWorks(null)).toBe(false);
      expect(storageWorks(undefined)).toBe(false);
    });

    it('returns true for a functioning Storage', () => {
      expect(storageWorks(createMemoryStorage())).toBe(true);
    });

    it('returns false for a Storage whose setItem throws (quota/private mode)', () => {
      const broken = { setItem() { throw new Error('QuotaExceededError'); }, getItem() {}, removeItem() {} };
      expect(storageWorks(broken)).toBe(false);
    });

    it('returns false for a Storage that drops what it stores', () => {
      const lossy = { setItem() {}, getItem() { return null; }, removeItem() {} };
      expect(storageWorks(lossy)).toBe(false);
    });
  });

  describe('ensureStorage', () => {
    it('installs a working Storage when the environment lacks one (the #1438 failure mode)', () => {
      const root = {};
      // Reproduces "Cannot read properties of undefined (reading clear)": no Storage present.
      expect(root.localStorage).toBeUndefined();
      const installed = ensureStorage('localStorage', root);
      expect(installed).toBe(true);
      expect(storageWorks(root.localStorage)).toBe(true);
      root.localStorage.setItem('k', 'v');
      expect(root.localStorage.getItem('k')).toBe('v');
    });

    it('is name-agnostic — installs sessionStorage too', () => {
      const root = {};
      const installed = ensureStorage('sessionStorage', root);
      expect(installed).toBe(true);
      expect(storageWorks(root.sessionStorage)).toBe(true);
      // Only the requested name is touched.
      expect(root.localStorage).toBeUndefined();
    });

    it('does NOT mutate the global window when a caller passes an explicit root', () => {
      // The window-aliasing branch is gated on `root === globalThis` precisely so a
      // test passing its own root can't clobber the suite-wide window.localStorage.
      const before = window.localStorage;
      const root = {};
      ensureStorage('localStorage', root);
      expect(window.localStorage).toBe(before);
      expect(root.localStorage).not.toBe(before);
    });

    it('leaves a working Storage untouched (idempotent, no clobber)', () => {
      const existing = createMemoryStorage();
      existing.setItem('keep', 'me');
      const root = { localStorage: existing };
      const installed = ensureStorage('localStorage', root);
      expect(installed).toBe(false);
      expect(root.localStorage).toBe(existing);
      expect(root.localStorage.getItem('keep')).toBe('me');
    });

    it('replaces a broken Storage with a working shim', () => {
      const root = { localStorage: { setItem() { throw new Error('boom'); }, getItem() {}, removeItem() {} } };
      const installed = ensureStorage('localStorage', root);
      expect(installed).toBe(true);
      expect(storageWorks(root.localStorage)).toBe(true);
    });
  });

  describe('installTestStorage (the setup.js entry point)', () => {
    it('guarantees both local AND session storage are working (idempotent)', () => {
      // The actual entry point setup.js calls. Asserting it directly catches a
      // refactor that dropped the sessionStorage line — the ensureStorage cases above
      // would still pass. It targets the live globals (already installed by setup.js),
      // so this re-invocation must be a no-op that leaves both keys working.
      expect(() => installTestStorage()).not.toThrow();
      expect(storageWorks(globalThis.localStorage)).toBe(true);
      expect(storageWorks(globalThis.sessionStorage)).toBe(true);
    });
  });

  it('the active test environment has a working localStorage (setup.js installed it)', () => {
    expect(storageWorks(globalThis.localStorage)).toBe(true);
    expect(storageWorks(globalThis.sessionStorage)).toBe(true);
    // And the bare global resolves to the same instance window exposes.
    expect(localStorage).toBe(window.localStorage);
  });
});
