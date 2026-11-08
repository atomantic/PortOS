import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadMeta = vi.hoisted(() => vi.fn());
const runDailyDigest = vi.hoisted(() => vi.fn());
const runWeeklyReview = vi.hoisted(() => vi.fn());
const getUserTimezone = vi.hoisted(() => vi.fn());
vi.mock('./brainStorage.js', () => ({ loadMeta }));
vi.mock('./brain.js', () => ({ runDailyDigest, runWeeklyReview, TOOL_FREE_REQUIRED: 'TOOL_FREE_REQUIRED' }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone }));

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('brainScheduler opt-in', () => {
  let startBrainScheduler;
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    runDailyDigest.mockReset().mockResolvedValue({});
    runWeeklyReview.mockReset().mockResolvedValue({});
    getUserTimezone.mockReset().mockResolvedValue('UTC');
    ({ startBrainScheduler } = await import('./brainScheduler.js'));
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const meta = (extra = {}) => ({
    dailyDigestTime: '00:00', weeklyReviewTime: '00:00', weeklyReviewDay: 'sunday',
    lastDailyDigest: null, lastWeeklyReview: null, ...extra
  });

  it('makes no provider call at start or at the digest time while disabled', async () => {
    loadMeta.mockResolvedValue(meta());
    startBrainScheduler();
    await flush();
    vi.setSystemTime(new Date(2026, 9, 18, 0, 0, 0));
    await vi.advanceTimersByTimeAsync(60000);
    expect(runDailyDigest).not.toHaveBeenCalled();
    expect(runWeeklyReview).not.toHaveBeenCalled();
  });

  it('catches up a missed digest and review once per boot when enabled, without retrying after failure', async () => {
    loadMeta.mockResolvedValue(meta({ scheduledReviewsEnabled: true }));
    runDailyDigest.mockRejectedValue(new Error('provider down'));
    startBrainScheduler();
    await flush();
    expect(runDailyDigest).toHaveBeenCalledTimes(1);
    expect(runWeeklyReview).toHaveBeenCalledTimes(1);

    // Past the 30 minute cooldown: still no second catch-up this boot.
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(60000);
    expect(runDailyDigest).toHaveBeenCalledTimes(1);
    expect(runWeeklyReview).toHaveBeenCalledTimes(1);
  });

  it('runs the digest at the configured local time, not the UTC hour of the same clock value', async () => {
    getUserTimezone.mockResolvedValue('America/Los_Angeles');
    // 16:00 UTC is 09:00 PDT on 2026-10-18.
    vi.setSystemTime(new Date('2026-10-18T16:00:00Z'));
    loadMeta.mockResolvedValue(meta({
      scheduledReviewsEnabled: true, dailyDigestTime: '09:00',
      lastDailyDigest: '2026-10-17T16:00:00Z'
    }));
    startBrainScheduler();
    await flush();
    expect(runDailyDigest).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith('🧠 Scheduler: Running daily digest...');
  });

  it('does not run the digest at 09:00 UTC when the configured 09:00 is in another timezone', async () => {
    getUserTimezone.mockResolvedValue('America/Los_Angeles');
    // 09:00 UTC is 02:00 PDT, well before the configured 09:00 local time.
    vi.setSystemTime(new Date('2026-10-18T09:00:00Z'));
    loadMeta.mockResolvedValue(meta({
      scheduledReviewsEnabled: true, dailyDigestTime: '09:00',
      lastDailyDigest: '2026-10-17T16:00:00Z'
    }));
    startBrainScheduler();
    await flush();
    expect(runDailyDigest).not.toHaveBeenCalled();
  });

  it('runs the weekly review on the configured local weekday, not the UTC weekday', async () => {
    getUserTimezone.mockResolvedValue('Asia/Tokyo');
    // Sunday 14:00 UTC is Sunday 23:00 JST.
    vi.setSystemTime(new Date('2026-11-08T14:00:00Z'));
    loadMeta.mockResolvedValue(meta({
      scheduledReviewsEnabled: true, weeklyReviewDay: 'sunday', weeklyReviewTime: '23:00',
      lastWeeklyReview: '2026-11-01T14:00:00Z'
    }));
    startBrainScheduler();
    await flush();
    expect(runWeeklyReview).toHaveBeenCalledTimes(1);
  });

  it('treats a digest from earlier on the same local day as already run even when the UTC date differs', async () => {
    getUserTimezone.mockResolvedValue('Asia/Tokyo');
    // 02:00 UTC is 11:00 JST on 2026-10-18; the last digest was 01:00 JST that day (UTC date 10-17).
    vi.setSystemTime(new Date('2026-10-18T02:00:00Z'));
    loadMeta.mockResolvedValue(meta({
      scheduledReviewsEnabled: true, dailyDigestTime: '01:30',
      lastDailyDigest: '2026-10-17T16:00:00Z'
    }));
    startBrainScheduler();
    await flush();
    expect(runDailyDigest).not.toHaveBeenCalled();
  });

  it('skips a run refused for a tool-capable provider without crashing or logging an error', async () => {
    loadMeta.mockResolvedValue(meta({ scheduledReviewsEnabled: true }));
    const refusal = Object.assign(new Error("Brain provider 'x' cannot run without tools"), { code: 'TOOL_FREE_REQUIRED' });
    runDailyDigest.mockRejectedValue(refusal);
    runWeeklyReview.mockRejectedValue(refusal);
    startBrainScheduler();
    await flush();
    expect(runDailyDigest).toHaveBeenCalledTimes(1);
    expect(runWeeklyReview).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });
});
