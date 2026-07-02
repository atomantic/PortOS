import { describe, it, expect } from 'vitest';
import {
  cadenceStatus as clientCadenceStatus,
  daysSinceDate as clientDaysSinceDate,
  DEFAULT_CADENCE_DAYS as CLIENT_DEFAULT,
  SOON_WINDOW_DAYS as CLIENT_SOON,
} from './tribeCadence.js';
// The server copy is authoritative; the client copy is a mirror. Importing both
// here (vitest resolves the cross-boundary path, same as providers.test.js) and
// asserting identical output is the anti-drift guarantee for issue #2060 — if
// either file's cadence rules change without the other, this suite fails.
import {
  cadenceStatus as serverCadenceStatus,
  daysSinceDate as serverDaysSinceDate,
  DEFAULT_CADENCE_DAYS as SERVER_DEFAULT,
  SOON_WINDOW_DAYS as SERVER_SOON,
} from '../../../server/lib/tribeCadence.js';

// N days before today as a YYYY-MM-DD string, so the suite is date-independent.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('tribeCadence — client/server mirror is byte-identical', () => {
  it('exposes identical tuning constants', () => {
    expect(CLIENT_DEFAULT).toBe(SERVER_DEFAULT);
    expect(CLIENT_SOON).toBe(SERVER_SOON);
    expect(CLIENT_DEFAULT).toBe(45);
    expect(CLIENT_SOON).toBe(7);
  });

  const entities = [
    { ring: 'external', lastContact: daysAgo(999), cadenceDays: 7 }, // external excluded
    { ring: 'core', lastContact: null, cadenceDays: 21 }, // missing
    { ring: 'core', lastContact: undefined, cadenceDays: 21 }, // missing (undefined)
    { ring: 'support', lastContact: 'not-a-date', cadenceDays: 7 }, // unparseable → missing
    { ring: 'support', lastContact: daysAgo(10), cadenceDays: 7 }, // overdue
    { ring: 'core', lastContact: daysAgo(21), cadenceDays: 21 }, // 0 remaining → soon boundary
    { ring: 'core', lastContact: daysAgo(14), cadenceDays: 21 }, // 7 remaining → soon upper boundary
    { ring: 'core', lastContact: daysAgo(13), cadenceDays: 21 }, // 8 remaining → steady
    { ring: 'village', lastContact: daysAgo(2), cadenceDays: 90 }, // steady
    { ring: 'tribe', lastContact: daysAgo(45), cadenceDays: 0 }, // cadenceDays 0 → default 45
  ];

  it.each(entities)('cadenceStatus matches across boundary for %o', (entity) => {
    expect(clientCadenceStatus(entity)).toEqual(serverCadenceStatus(entity));
  });

  it.each([null, undefined, '', 'garbage', daysAgo(0), daysAgo(3)])(
    'daysSinceDate matches across boundary for %o',
    (value) => {
      expect(clientDaysSinceDate(value)).toBe(serverDaysSinceDate(value));
    },
  );
});

describe('tribeCadence — cadence rules (semantics preserved from #2032)', () => {
  it('external members are excluded from care (never nagged)', () => {
    expect(clientCadenceStatus({ ring: 'external', lastContact: daysAgo(999), cadenceDays: 7 }))
      .toEqual({ state: 'external', daysRemaining: null, daysOverdue: 0 });
  });

  it('distinguishes missing (never contacted) from overdue', () => {
    const missing = clientCadenceStatus({ ring: 'core', lastContact: null, cadenceDays: 21 });
    expect(missing.state).toBe('missing');
    expect(missing.daysRemaining).toBeNull();
    expect(missing.daysOverdue).toBeNull(); // missing sorts above dated-overdue

    const overdue = clientCadenceStatus({ ring: 'support', lastContact: daysAgo(10), cadenceDays: 7 });
    expect(overdue.state).toBe('overdue');
    expect(overdue.daysOverdue).toBe(3);
  });

  it('treats <=7 days remaining as soon, >7 as steady', () => {
    expect(clientCadenceStatus({ ring: 'core', lastContact: daysAgo(14), cadenceDays: 21 }).state).toBe('soon');
    expect(clientCadenceStatus({ ring: 'core', lastContact: daysAgo(13), cadenceDays: 21 }).state).toBe('steady');
  });
});
