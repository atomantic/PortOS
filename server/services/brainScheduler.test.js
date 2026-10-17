import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const loadMeta = vi.hoisted(() => vi.fn());
const runDailyDigest = vi.hoisted(() => vi.fn());
const runWeeklyReview = vi.hoisted(() => vi.fn());
vi.mock('./brainStorage.js', () => ({ loadMeta }));
vi.mock('./brain.js', () => ({ runDailyDigest, runWeeklyReview }));

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
});
