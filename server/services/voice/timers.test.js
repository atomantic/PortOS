import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-ins for the disk store + notification sink so the module's
// persistence/fire paths run without touching the filesystem.
const { atomicWriteMock, readJSONFileMock, storeRef } = vi.hoisted(() => {
  const storeRef = { value: { version: 1, timers: [] } };
  return {
    storeRef,
    atomicWriteMock: vi.fn(async (_path, data) => { storeRef.value = data; }),
    readJSONFileMock: vi.fn(async () => storeRef.value),
  };
});
vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/portos-voice-timers-test' },
  atomicWrite: (...a) => atomicWriteMock(...a),
  readJSONFile: (...a) => readJSONFileMock(...a),
}));
const addNotificationMock = vi.hoisted(() => vi.fn(async () => ({ id: 'notif-1' })));
vi.mock('../notifications.js', () => ({
  addNotification: (...a) => addNotificationMock(...a),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));

const { scheduleTimer, initVoiceTimers, __resetVoiceTimers } = await import('./timers.js');

const tick = () => Promise.resolve(); // flush a microtask (persist chain)

beforeEach(() => {
  __resetVoiceTimers();
  storeRef.value = { version: 1, timers: [] };
  atomicWriteMock.mockClear();
  readJSONFileMock.mockClear();
  addNotificationMock.mockClear();
});

describe('scheduleTimer', () => {
  it('arms a timer that raises a notification when it elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    const res = scheduleTimer({ totalMs: 600000, label: 'call mom' });
    expect(res.deduped).toBe(false);
    expect(typeof res.id).toBe('string');
    await vi.advanceTimersByTimeAsync(600000);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      title: '⏰ call mom',
      priority: 'high',
      metadata: expect.objectContaining({ source: 'voice-timer' }),
    }));
    vi.useRealTimers();
  });

  it('persists a pending timer (handle stripped) and clears it after firing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    scheduleTimer({ totalMs: 600000, label: 'tea' });
    await tick(); await tick(); // let the schedule's queued persist() write run
    const afterSchedule = atomicWriteMock.mock.calls.at(-1)[1];
    expect(afterSchedule.timers).toHaveLength(1);
    expect(afterSchedule.timers[0]).toMatchObject({ label: 'tea' });
    expect(afterSchedule.timers[0].handle).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600000);
    const afterFire = atomicWriteMock.mock.calls.at(-1)[1];
    expect(afterFire.timers).toHaveLength(0);
    vi.useRealTimers();
  });

  it('rejects an out-of-range duration without arming anything', () => {
    vi.useFakeTimers();
    expect(scheduleTimer({ totalMs: 500, label: 'too short' })).toBeNull();
    expect(scheduleTimer({ totalMs: 25 * 60 * 60 * 1000, label: 'too long' })).toBeNull();
    expect(scheduleTimer({ totalMs: NaN, label: 'nan' })).toBeNull();
    vi.useRealTimers();
  });

  it('dedups a re-issued identical timer but keeps a distinct label / out-of-window one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    const a = scheduleTimer({ totalMs: 600000, label: 'tea' });
    const b = scheduleTimer({ totalMs: 600000, label: 'tea' });
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);

    // Behavioral effect, not just the return value: the dup must NOT arm or
    // persist a second timer — exactly one 'tea' is on disk.
    await tick(); await tick();
    const snap = atomicWriteMock.mock.calls.at(-1)[1];
    expect(snap.timers.filter((t) => t.label === 'tea')).toHaveLength(1);

    // Different label → not a duplicate.
    expect(scheduleTimer({ totalMs: 600000, label: 'eggs' }).deduped).toBe(false);

    // Same label but fireAt now 20s past the original → outside the dedup
    // window → a genuinely new timer.
    vi.advanceTimersByTime(20000);
    expect(scheduleTimer({ totalMs: 600000, label: 'tea' }).deduped).toBe(false);
    vi.useRealTimers();
  });
});

describe('initVoiceTimers', () => {
  it('fires overdue timers once and re-arms future ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    const now = Date.now();
    storeRef.value = {
      version: 1,
      timers: [
        { id: 'past', label: 'overdue', fireAt: now - 1000, createdAt: now - 600000 },
        { id: 'future', label: 'soon', fireAt: now + 300000, createdAt: now },
        { id: 'bad', label: 42, fireAt: now + 1000 },        // malformed label → skipped
        { id: 'nan', label: 'nan', fireAt: Number.NaN },     // NaN fireAt → skipped (not armed-now)
        { id: 'inf', label: 'inf', fireAt: Infinity },       // Infinity fireAt → skipped
        { id: 'huge', label: 'huge', fireAt: now + 40 * 24 * 60 * 60 * 1000 }, // > 24h cap → skipped
      ],
    };
    const res = await initVoiceTimers();
    expect(res).toEqual({ armed: 1, fired: 1 });
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ title: '⏰ overdue' }));

    // Store rewritten with only the still-pending future timer.
    const persisted = atomicWriteMock.mock.calls.at(-1)[1];
    expect(persisted.timers.map((t) => t.id)).toEqual(['future']);

    // The future timer fires when its time comes.
    addNotificationMock.mockClear();
    await vi.advanceTimersByTimeAsync(300000);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ title: '⏰ soon' }));
    vi.useRealTimers();
  });

  it('does not double-notify on duplicate ids in a corrupt store (both overdue)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    const now = Date.now();
    storeRef.value = {
      version: 1,
      timers: [
        { id: 'dup', label: 'dup', fireAt: now - 1000, createdAt: now },
        { id: 'dup', label: 'dup', fireAt: now - 2000, createdAt: now }, // duplicate overdue id
      ],
    };
    const res = await initVoiceTimers();
    expect(res).toEqual({ armed: 0, fired: 1 }); // fired once, not twice
    expect(addNotificationMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('is idempotent — a second init is skipped', async () => {
    const first = await initVoiceTimers();
    expect(first).toEqual({ armed: 0, fired: 0 });
    const second = await initVoiceTimers();
    expect(second).toEqual({ skipped: true });
  });

  it('skips a persisted record whose id is already live in memory (boot race, both branches)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-26T12:00:00Z'));
    const now = Date.now();
    // Simulate the race: a timer_set is scheduled (and persisted) while boot
    // init is still mid-read, so init reads the same id back. Mark the persisted
    // copy OVERDUE to exercise the overdue branch — the in-memory timer is
    // authoritative, so init must skip the record entirely (neither fire it as
    // overdue nor re-arm a second handle), leaving exactly one live timer.
    const scheduled = scheduleTimer({ totalMs: 300000, label: 'overlap' });
    await tick(); await tick(); // let scheduleTimer's persist settle first
    storeRef.value = {
      version: 1,
      timers: [{ id: scheduled.id, label: 'overlap', fireAt: now - 1000, createdAt: now }],
    };
    const res = await initVoiceTimers();
    expect(res).toEqual({ armed: 0, fired: 0 }); // skipped — not fired-as-overdue, not re-armed
    addNotificationMock.mockClear();
    await vi.advanceTimersByTimeAsync(300000);
    expect(addNotificationMock).toHaveBeenCalledTimes(1); // the one live timer fires once
    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '⏰ overlap', metadata: expect.objectContaining({ timerId: scheduled.id }) })
    );
    vi.useRealTimers();
  });
});
