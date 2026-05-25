import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The wiring test exercises the REAL event emitters (they're module
// singletons) but injects a fake `speak`, so no config/tts/timezone mocking is
// needed — the delivery primitive never runs.
import { errorEvents } from '../../lib/errorHandler.js';
import { cosEvents } from '../cosEvents.js';
import { notificationEvents } from '../notifications.js';
import {
  allowBySource,
  isHighPriorityNotification,
  formatErrorLine,
  formatTaskLine,
  formatNotificationLine,
  wireProactiveTriggers,
  RATE_LIMIT_MS,
} from './proactiveTriggers.js';

// Let the fire-and-forget dispatch promise chain settle after a synchronous
// emit before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('allowBySource', () => {
  it('allows the first line for a known source (no prior timestamp)', () => {
    expect(allowBySource('error', null, 1000)).toBe(true);
    expect(allowBySource('error', undefined, 1000)).toBe(true);
  });

  it('throttles within the per-source window and allows past it', () => {
    const limits = { error: 1000 };
    expect(allowBySource('error', 5000, 5500, limits)).toBe(false);
    expect(allowBySource('error', 5000, 6000, limits)).toBe(true);
    expect(allowBySource('error', 5000, 6500, limits)).toBe(true);
  });

  it('never throttles an unknown source', () => {
    expect(allowBySource('mystery', 5000, 5001)).toBe(true);
  });
});

describe('isHighPriorityNotification', () => {
  it('passes high and critical only', () => {
    expect(isHighPriorityNotification('high')).toBe(true);
    expect(isHighPriorityNotification('critical')).toBe(true);
    expect(isHighPriorityNotification('medium')).toBe(false);
    expect(isHighPriorityNotification('low')).toBe(false);
    expect(isHighPriorityNotification(undefined)).toBe(false);
  });
});

describe('formatErrorLine', () => {
  it('speaks only critical errors', () => {
    expect(formatErrorLine({ severity: 'critical', message: 'DB down' })).toMatch(/critical error.*DB down/i);
    expect(formatErrorLine({ severity: 'error', message: 'minor' })).toBe('');
    expect(formatErrorLine({ severity: 'warning', message: 'meh' })).toBe('');
  });

  it('returns empty when a critical error has no message', () => {
    expect(formatErrorLine({ severity: 'critical', message: '' })).toBe('');
  });

  it('clips very long messages', () => {
    const long = 'x'.repeat(500);
    const line = formatErrorLine({ severity: 'critical', message: long });
    expect(line.length).toBeLessThan(300);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('formatTaskLine', () => {
  it('prefers title, falls back to description', () => {
    expect(formatTaskLine({ title: 'Ship it' })).toBe('A new task is ready: Ship it.');
    expect(formatTaskLine({ description: 'Fix the bug' })).toBe('A new task is ready: Fix the bug.');
  });

  it('returns empty when neither title nor description present', () => {
    expect(formatTaskLine({})).toBe('');
    expect(formatTaskLine(null)).toBe('');
  });
});

describe('formatNotificationLine', () => {
  it('speaks high-priority notifications, appending description when present', () => {
    expect(formatNotificationLine({ priority: 'high', title: 'Backup failed' })).toBe('Backup failed');
    expect(formatNotificationLine({ priority: 'critical', title: 'Disk full', description: 'Act now' }))
      .toBe('Disk full. Act now');
  });

  it('skips low/medium priority and title-less notifications', () => {
    expect(formatNotificationLine({ priority: 'medium', title: 'meh' })).toBe('');
    expect(formatNotificationLine({ priority: 'high', title: '' })).toBe('');
  });
});

describe('wireProactiveTriggers', () => {
  let unwire;
  let speak;

  beforeEach(() => {
    speak = vi.fn(async () => ({ ok: true }));
  });

  afterEach(() => {
    if (unwire) unwire();
    unwire = null;
    vi.restoreAllMocks();
  });

  it('returns a no-op and warns when io is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const off = wireProactiveTriggers({ io: null, speak });
    off(); // must not throw
    expect(warn).toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it('speaks on a critical error but not a routine one', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });

    errorEvents.emit('error', { severity: 'error', message: 'routine 500' });
    await flush();
    expect(speak).not.toHaveBeenCalled();

    errorEvents.emit('error', { severity: 'critical', message: 'meltdown' });
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toMatchObject({ source: 'error', priority: 'high' });
    expect(speak.mock.calls[0][0].text).toMatch(/meltdown/);
  });

  it('speaks on task:ready and high-priority notifications', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak });

    cosEvents.emit('task:ready', { title: 'Render scene 3' });
    notificationEvents.emit('added', { priority: 'high', title: 'Sync complete' });
    notificationEvents.emit('added', { priority: 'low', title: 'ignored' });
    await flush();

    const sources = speak.mock.calls.map((c) => c[0].source).sort();
    expect(sources).toEqual(['notification', 'task:ready']);
  });

  it('rate-limits a burst from one source to a single line', async () => {
    unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });

    errorEvents.emit('error', { severity: 'critical', message: 'first' });
    await flush();
    errorEvents.emit('error', { severity: 'critical', message: 'second' });
    await flush();

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toMatch(/first/);
  });

  it('rate-limits a same-tick concurrent burst (slot reserved before await)', async () => {
    // Synthesis is async; emit two same-source events on the SAME tick (no
    // flush between) so the second fires while the first speak() is still
    // pending. The pre-await reservation must block the second — otherwise
    // both start concurrent syntheses and talk over each other.
    let resolveSpeak;
    speak = vi.fn(() => new Promise((r) => { resolveSpeak = () => r({ ok: true }); }));
    unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });

    errorEvents.emit('error', { severity: 'critical', message: 'first' });
    errorEvents.emit('error', { severity: 'critical', message: 'second' });
    resolveSpeak();
    await flush();

    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toMatch(/first/);
  });

  it('does not advance the bucket when a line was suppressed (ok:false)', async () => {
    speak = vi.fn(async () => ({ ok: false, reason: 'quiet-hours' }));
    unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });

    errorEvents.emit('error', { severity: 'critical', message: 'first' });
    await flush();
    errorEvents.emit('error', { severity: 'critical', message: 'second' });
    await flush();

    // Both attempts reach speak because the first never went out.
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('does not leak an unhandled rejection when speak rejects', async () => {
    speak = vi.fn(async () => { throw new Error('synthesis exploded'); });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    let unhandled = null;
    const onUnhandled = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', onUnhandled);

    // try/finally so a failed assertion can't leak the process-level listener
    // into later tests (cross-test flakiness).
    try {
      unwire = wireProactiveTriggers({ io: {}, speak, limits: { error: 60_000 } });
      errorEvents.emit('error', { severity: 'critical', message: 'boom' });

      // Give the rejected promise time to surface as an unhandled rejection
      // if the guard ever regresses.
      await new Promise((r) => setTimeout(r, 50));

      expect(unhandled).toBeNull(); // load-bearing: locks in the no-leak guard
      expect(errorLog).toHaveBeenCalled();

      // Bucket did not advance — a later critical can still try.
      errorEvents.emit('error', { severity: 'critical', message: 'again' });
      await flush();
      expect(speak).toHaveBeenCalledTimes(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('default RATE_LIMIT_MS covers all three wired sources', () => {
    expect(RATE_LIMIT_MS).toHaveProperty('error');
    expect(RATE_LIMIT_MS).toHaveProperty('task:ready');
    expect(RATE_LIMIT_MS).toHaveProperty('notification');
  });
});
