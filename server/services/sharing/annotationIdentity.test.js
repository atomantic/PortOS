/**
 * Tests for server/services/sharing/annotationIdentity.js
 *
 * The module memoizes a display-name read (30s TTL), invalidates on
 * settings:updated events, and falls back to os.userInfo().username.
 * We stub getSettings and os.userInfo to drive the caching paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- mock settings.js before the module is imported -----------------------

const settingsEventEmitter = vi.hoisted(() => {
  // A minimal EventEmitter stub so `settingsEvents.on(...)` can be called.
  const listeners = {};
  return {
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, ...args) { (listeners[event] || []).forEach(fn => fn(...args)); },
    _listeners: listeners,
  };
});

vi.mock('../settings.js', () => ({
  getSettings: vi.fn(),
  settingsEvents: settingsEventEmitter,
}));

// mock os — override userInfo so the fallback is deterministic
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, userInfo: vi.fn(() => ({ username: 'os-user' })) };
});

import { getSettings } from '../settings.js';
import * as osModule from 'os';
import {
  resolveGlobalDisplayName,
  invalidateGlobalDisplayNameCache,
  resolveBucketSourceName,
} from './annotationIdentity.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  // Always reset cache between tests so state doesn't bleed.
  invalidateGlobalDisplayNameCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('annotationIdentity — resolveGlobalDisplayName', () => {
  it('returns sharingDisplayName from settings when set', async () => {
    getSettings.mockResolvedValue({ sharingDisplayName: 'Alice' });

    const name = await resolveGlobalDisplayName();

    expect(name).toBe('Alice');
  });

  it('falls back to os.userInfo().username when sharingDisplayName is absent', async () => {
    getSettings.mockResolvedValue({});
    osModule.userInfo.mockReturnValue({ username: 'bob' });

    const name = await resolveGlobalDisplayName();

    expect(name).toBe('bob');
  });

  it('falls back to os.userInfo().username when sharingDisplayName is whitespace', async () => {
    getSettings.mockResolvedValue({ sharingDisplayName: '   ' });
    osModule.userInfo.mockReturnValue({ username: 'carol' });

    const name = await resolveGlobalDisplayName();

    expect(name).toBe('carol');
  });

  it('falls back to "unknown" when settings and os.userInfo both fail', async () => {
    getSettings.mockResolvedValue({});
    osModule.userInfo.mockReturnValue({ username: '' });

    const name = await resolveGlobalDisplayName();

    expect(name).toBe('unknown');
  });

  it('returns the cached value within the TTL without re-reading settings', async () => {
    vi.useFakeTimers();
    getSettings.mockResolvedValue({ sharingDisplayName: 'Cached' });

    const first = await resolveGlobalDisplayName();
    expect(first).toBe('Cached');
    expect(getSettings).toHaveBeenCalledTimes(1);

    // Advance by less than the 30s TTL
    vi.advanceTimersByTime(15_000);

    // Second call must use the cache
    const second = await resolveGlobalDisplayName();
    expect(second).toBe('Cached');
    expect(getSettings).toHaveBeenCalledTimes(1); // NOT called again
  });

  it('re-reads settings after the TTL expires', async () => {
    vi.useFakeTimers();
    getSettings
      .mockResolvedValueOnce({ sharingDisplayName: 'First' })
      .mockResolvedValueOnce({ sharingDisplayName: 'Second' });

    const first = await resolveGlobalDisplayName();
    expect(first).toBe('First');

    // Advance past the 30s TTL
    vi.setSystemTime(Date.now() + 31_000);

    const second = await resolveGlobalDisplayName();
    expect(second).toBe('Second');
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('invalidateGlobalDisplayNameCache() forces a re-read on next call', async () => {
    getSettings
      .mockResolvedValueOnce({ sharingDisplayName: 'BeforeInvalidate' })
      .mockResolvedValueOnce({ sharingDisplayName: 'AfterInvalidate' });

    const first = await resolveGlobalDisplayName();
    expect(first).toBe('BeforeInvalidate');
    expect(getSettings).toHaveBeenCalledTimes(1);

    invalidateGlobalDisplayNameCache();

    const second = await resolveGlobalDisplayName();
    expect(second).toBe('AfterInvalidate');
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('settings:updated event invalidates the cache', async () => {
    getSettings
      .mockResolvedValueOnce({ sharingDisplayName: 'BeforeEvent' })
      .mockResolvedValueOnce({ sharingDisplayName: 'AfterEvent' });

    // First read populates the cache.
    const first = await resolveGlobalDisplayName();
    expect(first).toBe('BeforeEvent');

    // Simulate a settings save event — should invalidate the cache.
    settingsEventEmitter.emit('settings:updated');

    // Next read must go to settings again.
    const second = await resolveGlobalDisplayName();
    expect(second).toBe('AfterEvent');
    expect(getSettings).toHaveBeenCalledTimes(2);
  });

  it('does not cache when settings read fails (prevents pinning OS fallback)', async () => {
    // First call: settings unreadable → returns OS username, does NOT cache.
    getSettings
      .mockRejectedValueOnce(new Error('disk error'))
      .mockResolvedValueOnce({ sharingDisplayName: 'Recovered' });
    osModule.userInfo.mockReturnValue({ username: 'fallback-user' });

    const first = await resolveGlobalDisplayName();
    expect(first).toBe('fallback-user');

    // Second call: settings now readable → should fetch again (not return cached fallback).
    const second = await resolveGlobalDisplayName();
    expect(second).toBe('Recovered');
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});

describe('annotationIdentity — resolveBucketSourceName', () => {
  it('returns bucket displayNameOverride when set', async () => {
    const name = await resolveBucketSourceName({ displayNameOverride: 'BucketAlias' });
    expect(name).toBe('BucketAlias');
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('falls through to global display name when override is absent', async () => {
    getSettings.mockResolvedValue({ sharingDisplayName: 'Global' });
    const name = await resolveBucketSourceName({});
    expect(name).toBe('Global');
  });

  it('handles a null bucket by falling through to global name', async () => {
    getSettings.mockResolvedValue({ sharingDisplayName: 'Global' });
    const name = await resolveBucketSourceName(null);
    expect(name).toBe('Global');
  });
});
