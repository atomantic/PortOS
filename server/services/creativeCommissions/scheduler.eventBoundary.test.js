import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// #7528: the real regression only shows up at the eventScheduler boundary — a
// pre-fire read failure caught INSIDE the handler (the old `.catch(() => null)`)
// never reaches `runEvent`'s own try/catch, so the schedule's own history read
// `success: true` for a tick that generated nothing. Unlike scheduler.test.js
// (which mocks eventScheduler.js so isValidCron is deterministic), this suite
// runs the REAL eventScheduler.js so the propagate-and-rearm contract is
// verified against the actual contained boundary, not a mock standing in for it.

vi.mock('../userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
const settingsEvents = new EventEmitter();
vi.mock('../settings.js', () => ({ settingsEvents, getSettings: async () => ({}) }));

const getCommissionMock = vi.fn();
const recordRunMock = vi.fn(async () => ({}));
const commissionEvents = new EventEmitter();
vi.mock('./store.js', () => ({
  listCommissions: async () => [],
  getCommission: (...a) => getCommissionMock(...a),
  recordCommissionRun: (...a) => recordRunMock(...a),
  commissionEvents,
  ERR_NOT_FOUND: 'NOT_FOUND',
  commissionStore: () => ({ readRaw: async () => null }),
  sanitizeCommission: (raw) => raw,
}));

const { schedule, cancel, triggerNow, getEvent, getHistory } = await import('../eventScheduler.js');
const { runScheduledCommission } = await import('./scheduler.js');

const EVENT_ID = 'creative-commission-boundary-test-7528';

afterEach(() => {
  cancel(EVENT_ID); // clears the real pending timer so the test process can exit
  vi.clearAllMocks();
});

function arm() {
  return schedule({
    id: EVENT_ID,
    type: 'cron',
    cron: '0 0 * * *',
    handler: () => runScheduledCommission('commission-boundary'),
    metadata: { source: 'creativeCommissionScheduler', commissionId: 'commission-boundary' },
  });
}

describe('runScheduledCommission through the real eventScheduler boundary (#7528)', () => {
  it('a pre-fire read failure is caught by runEvent, recorded failed on the SCHEDULE history, and the recurring event stays armed', async () => {
    getCommissionMock.mockRejectedValueOnce(Object.assign(new Error('storage timeout'), { code: 'ETIMEDOUT' }));
    arm();

    await triggerNow(EVENT_ID);

    // The contained boundary (runEvent) caught the throw — it never escaped as
    // an unhandled rejection, and the tick reads as a failure, not a success.
    const [entry] = getHistory({ eventId: EVENT_ID, limit: 1 });
    expect(entry.success).toBe(false);
    expect(entry.error).toBe('storage timeout');

    // The recurring event is still active with a next run scheduled — a failed
    // read must not cancel the schedule.
    const event = getEvent(EVENT_ID);
    expect(event.active).toBe(true);
    expect(event.nextRunAt).toEqual(expect.any(Number));

    // The failure also landed on the commission's OWN run history.
    expect(recordRunMock).toHaveBeenCalledWith('commission-boundary', expect.objectContaining({
      status: 'failed', trigger: 'schedule', error: 'read-failed:ETIMEDOUT',
    }));
  });

  it('the next tick after a failed read runs normally — the schedule was never wedged', async () => {
    getCommissionMock.mockRejectedValueOnce(Object.assign(new Error('storage timeout'), { code: 'ETIMEDOUT' }));
    arm();
    await triggerNow(EVENT_ID);

    recordRunMock.mockClear();
    getCommissionMock.mockResolvedValueOnce({ id: 'commission-boundary', enabled: false });
    await triggerNow(EVENT_ID);

    const [latest] = getHistory({ eventId: EVENT_ID, limit: 1 });
    expect(latest.success).toBe(true); // the disabled commission is a quiet, successful no-op
    expect(recordRunMock).not.toHaveBeenCalled();
    expect(getEvent(EVENT_ID).active).toBe(true);
  });

  it('confirmed deletion (ERR_NOT_FOUND) reads as a quiet success on the schedule history — no failed tick, no ledger write', async () => {
    getCommissionMock.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }));
    arm();

    await triggerNow(EVENT_ID);

    const [entry] = getHistory({ eventId: EVENT_ID, limit: 1 });
    expect(entry.success).toBe(true);
    expect(recordRunMock).not.toHaveBeenCalled();
  });
});
