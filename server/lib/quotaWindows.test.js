import { describe, expect, it } from 'vitest';
import { classifyWindows, isLimitStale, staleThresholdMs, windowLabelOf, windowPeriodHours } from './quotaWindows.js';

// The scope/label vocabulary the four in-tree adapters actually emit — the point
// of the classifier is that each of these resolves, so a real card is never
// ranked by "unknown period".
describe('windowPeriodHours', () => {
  it('classifies every shape the providerUsage adapters emit', () => {
    expect(windowPeriodHours({ scope: 'session', label: 'Current session' })).toBe(5);
    expect(windowPeriodHours({ scope: 'week', label: 'Current week (all models)' })).toBe(168);
    expect(windowPeriodHours({ scope: 'week', label: 'Current week (Opus)' })).toBe(168);
    expect(windowPeriodHours({ scope: '5-hour', label: 'Gemini · 5-hour' })).toBe(5);
    expect(windowPeriodHours({ scope: 'weekly', label: 'Gemini · Weekly' })).toBe(168);
    expect(windowPeriodHours({ scope: 'month', label: 'Monthly' })).toBe(720);
  });

  it('prefers a stated periodHours over the scope word', () => {
    // Codex's telemetry states window_minutes exactly. A plan whose primary
    // window is 7h must not be read as the 5h `session` default.
    expect(windowPeriodHours({ scope: 'session', periodHours: 7 })).toBe(7);
    // Zero / negative / non-numeric are not statements — fall through.
    expect(windowPeriodHours({ scope: 'session', periodHours: 0 })).toBe(5);
    expect(windowPeriodHours({ scope: 'week', periodHours: 'soon' })).toBe(168);
  });

  it('reads a numeric unit out of a label before any keyword', () => {
    expect(windowPeriodHours({ label: 'Current 5h window' })).toBe(5);
    expect(windowPeriodHours({ label: 'Current 2 days' })).toBe(48);
    expect(windowPeriodHours({ label: 'Current 45m window' })).toBeCloseTo(0.75, 5);
  });

  it('returns null — not zero — for a window it cannot classify', () => {
    // Null must stay distinct from a real period: ranked as the narrowest, an
    // unknown window would become the clock a denial backs off to. Only the
    // vocabulary the adapters actually emit is classified; anything else takes
    // the documented soonest-reset fallback rather than being guessed at.
    expect(windowPeriodHours({ scope: 'image', label: 'Agy · imagen' })).toBeNull();
    expect(windowPeriodHours({ scope: 'annual', label: 'Yearly' })).toBeNull();
    expect(windowPeriodHours({})).toBeNull();
    expect(windowPeriodHours(null)).toBeNull();
  });
});

describe('classifyWindows', () => {
  const hoursUntil = (limit) => limit.hours ?? null;
  const session = { scope: 'session', label: '5-hour', hours: 3 };
  const week = { scope: 'week', label: 'Weekly', hours: 30 };
  const classify = (limits) => classifyWindows(limits, hoursUntil);

  it('targets the broadest window and marks the narrowest as limiting', () => {
    // The 5-hour window resets sooner, but the WEEKLY allowance is the one that
    // expires unused — and the 5-hour one is what will refuse the run.
    for (const order of [[session, week], [week, session]]) {
      const { target, limiting } = classify(order);
      expect(target.limit).toBe(week);
      expect(target.hours).toBe(30);
      expect(limiting).toBe(session);
    }
  });

  it('still targets the broadest when the weekly window is about to roll', () => {
    // Near the weekly reset the WEEK is the soonest-resetting window — ranking
    // by reset time would flip the target back to the 5-hour one right when the
    // deadline that matters is closest.
    const closing = { scope: 'week', label: 'Weekly', hours: 1 };
    expect(classify([session, closing]).target.limit).toBe(closing);
  });

  it('breaks a same-period tie on the soonest reset', () => {
    const all = { scope: 'week', label: 'Current week (all models)', hours: 30 };
    const opus = { scope: 'week', label: 'Current week (Opus)', hours: 26 };
    expect(classify([all, opus]).target.limit).toBe(opus);
  });

  it('falls back to soonest-reset when nothing states a classifiable period', () => {
    // A provider whose vocabulary this doesn't know must keep working, not park
    // — but nothing can be asserted to be the narrowest, so there is no limiter.
    const burst = { scope: 'burst', label: 'Burst', hours: 3 };
    const pool = { scope: 'pool', label: 'Pool', hours: 8 };
    const { target, limiting } = classify([burst, pool]);
    expect(target.limit).toBe(burst);
    expect(limiting).toBeNull();
  });

  it('ignores unclassifiable windows when a classifiable one exists', () => {
    const opaque = { scope: 'burst', label: 'Burst', hours: 50 };
    const { target, limiting } = classify([opaque, week]);
    expect(target.limit).toBe(week);
    expect(limiting).toBe(week);
  });

  it('excludes an unreadable reset from the target but not from the limiter', () => {
    // A short window whose reset the provider didn't state can't be the
    // deadline, but it is still what refuses first.
    const undated = { scope: 'session', label: '5-hour', hours: null };
    const { target, limiting } = classify([undated, week]);
    expect(target.limit).toBe(week);
    expect(limiting).toBe(undated);
  });

  it('returns nulls for an empty set', () => {
    expect(classify([])).toEqual({ target: null, limiting: null });
    expect(classify(null)).toEqual({ target: null, limiting: null });
  });
});

describe('staleThresholdMs / isLimitStale', () => {
  it('scales the threshold to 10% of the window, floored at 5 minutes', () => {
    // 5h session: 10% is 30min, well above the floor.
    expect(staleThresholdMs(5)).toBe(30 * 60 * 1000);
    // Weekly: 10% of 168h is ~16.8h.
    expect(staleThresholdMs(168)).toBe(16.8 * 60 * 60 * 1000);
    // A hypothetical fast-moving window still floors at 5 minutes rather than
    // going permanently stale.
    expect(staleThresholdMs(0.5)).toBe(5 * 60 * 1000);
  });

  it('returns null for an unclassifiable period', () => {
    expect(staleThresholdMs(null)).toBeNull();
    expect(staleThresholdMs(0)).toBeNull();
    expect(staleThresholdMs(-1)).toBeNull();
  });

  it('flags a 5-hour session meter read 55 minutes ago, but not a weekly one read 70 minutes ago', () => {
    const session = { scope: 'session', label: 'Current session' };
    const weekly = { scope: 'week', label: 'Weekly' };
    expect(isLimitStale(session, 55 * 60 * 1000)).toBe(true);
    expect(isLimitStale(weekly, 70 * 60 * 1000)).toBe(false);
  });

  it('never flags a window whose period is unknown, however old the reading', () => {
    expect(isLimitStale({ scope: 'burst', label: 'Burst' }, 999 * 60 * 60 * 1000)).toBe(false);
  });

  it('never flags an unparseable age', () => {
    expect(isLimitStale({ scope: 'session' }, null)).toBe(false);
    expect(isLimitStale({ scope: 'session' }, NaN)).toBe(false);
  });
});

describe('windowLabelOf', () => {
  it('names a window however the adapter labelled it, falling back to its scope', () => {
    expect(windowLabelOf({ label: 'Weekly', scope: 'week' })).toBe('Weekly');
    expect(windowLabelOf({ scope: 'week' })).toBe('week');
    expect(windowLabelOf(null)).toBe('window');
  });
});
