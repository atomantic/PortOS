import { describe, it, expect, beforeEach } from 'vitest';
import { isInTimeWindow, isValidTimeString, MORNING_DEFAULT_WINDOW, pickActiveLayoutId, recordManualLayoutPick, TIME_STRING_RE } from './timeWindow.js';

describe('TIME_STRING_RE parity', () => {
  // Must stay byte-for-byte equal to HHMM_STRICT_RE in server/lib/timezone.js
  // (and the dashboard route mock). If this fails, sync all three.
  it('mirrors the server HHMM_STRICT_RE source', () => {
    expect(TIME_STRING_RE.source).toBe('^([01]\\d|2[0-3]):[0-5]\\d$');
  });
});

describe('isValidTimeString', () => {
  it('accepts HH:MM in 24h format', () => {
    expect(isValidTimeString('00:00')).toBe(true);
    expect(isValidTimeString('06:30')).toBe(true);
    expect(isValidTimeString('23:59')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isValidTimeString('24:00')).toBe(false);
    expect(isValidTimeString('6:30')).toBe(false);
    expect(isValidTimeString('06:60')).toBe(false);
    expect(isValidTimeString('foo')).toBe(false);
    expect(isValidTimeString('')).toBe(false);
    expect(isValidTimeString(null)).toBe(false);
  });
});

describe('isInTimeWindow', () => {
  it('returns true inside a non-wrap window', () => {
    const now = new Date('2026-05-20T07:30:00');
    expect(isInTimeWindow({ start: '06:00', end: '11:00' }, now)).toBe(true);
  });

  it('returns true at exact start, false at exact end (half-open)', () => {
    expect(isInTimeWindow({ start: '06:00', end: '11:00' }, new Date('2026-05-20T06:00:00'))).toBe(true);
    expect(isInTimeWindow({ start: '06:00', end: '11:00' }, new Date('2026-05-20T11:00:00'))).toBe(false);
  });

  it('handles overnight wrap correctly', () => {
    const win = { start: '22:00', end: '02:00' };
    expect(isInTimeWindow(win, new Date('2026-05-20T23:30:00'))).toBe(true);
    expect(isInTimeWindow(win, new Date('2026-05-20T01:00:00'))).toBe(true);
    expect(isInTimeWindow(win, new Date('2026-05-20T10:00:00'))).toBe(false);
  });

  it('returns false for malformed input', () => {
    const now = new Date('2026-05-20T07:30:00');
    expect(isInTimeWindow(null, now)).toBe(false);
    expect(isInTimeWindow({ start: 'nope', end: '11:00' }, now)).toBe(false);
    expect(isInTimeWindow({ start: '06:00', end: '06:00' }, now)).toBe(false);
  });
});

describe('MORNING_DEFAULT_WINDOW', () => {
  it('is the canonical 06:00–11:00 window', () => {
    expect(MORNING_DEFAULT_WINDOW).toEqual({ start: '06:00', end: '11:00' });
  });
});

// These describes need window.localStorage. The client's jsdom vitest runs
// them in full (verified 13/13 tests pass under jsdom). The server's node-
// env vitest also picks up `client/src/**/*.test.js` (see server/vitest.config.js
// include list) and would crash here without the skip.
const hasLocalStorage = typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

describe.skipIf(!hasLocalStorage)('pickActiveLayoutId', () => {
  beforeEach(() => { window.localStorage.clear(); });

  const layouts = [
    { id: 'morning', activateWindow: { start: '06:00', end: '11:00' } },
    { id: 'focus', activateWindow: null },
    { id: 'default', activateWindow: null },
  ];

  it('returns server active when already auto-switched (one-shot guard)', () => {
    const now = new Date('2026-05-20T07:30:00');
    expect(pickActiveLayoutId('focus', layouts, true, now)).toBe('focus');
  });

  it('honors today\'s manual pick when set', () => {
    const now = new Date('2026-05-20T07:30:00');
    recordManualLayoutPick('default', now);
    expect(pickActiveLayoutId('focus', layouts, false, now)).toBe('default');
  });

  it('auto-picks a window-matching layout when no manual pick', () => {
    const now = new Date('2026-05-20T07:30:00');
    expect(pickActiveLayoutId('focus', layouts, false, now)).toBe('morning');
  });

  it('falls through to server active when no window matches and no manual pick', () => {
    const now = new Date('2026-05-20T15:00:00');
    expect(pickActiveLayoutId('focus', layouts, false, now)).toBe('focus');
  });

  it('ignores a manual pick whose layout no longer exists', () => {
    const now = new Date('2026-05-20T07:30:00');
    recordManualLayoutPick('deleted-layout', now);
    // Falls through to window auto-pick.
    expect(pickActiveLayoutId('focus', layouts, false, now)).toBe('morning');
  });
});

describe.skipIf(!hasLocalStorage)('recordManualLayoutPick — stale key pruning', () => {
  beforeEach(() => { window.localStorage.clear(); });

  it('removes prior-day userPick keys when recording today', () => {
    window.localStorage.setItem('dashboard:userPick:2025-01-01', 'old');
    window.localStorage.setItem('dashboard:userPick:2025-06-15', 'older');
    window.localStorage.setItem('unrelated-key', 'keep');
    const now = new Date('2026-05-20T10:00:00');
    recordManualLayoutPick('today-pick', now);
    expect(window.localStorage.getItem('dashboard:userPick:2026-05-20')).toBe('today-pick');
    expect(window.localStorage.getItem('dashboard:userPick:2025-01-01')).toBe(null);
    expect(window.localStorage.getItem('dashboard:userPick:2025-06-15')).toBe(null);
    expect(window.localStorage.getItem('unrelated-key')).toBe('keep');
  });
});
