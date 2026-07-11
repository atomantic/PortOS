/**
 * Tests for seriesAutopilotScheduler (#2174) — the machine-local per-series cron
 * that fires startSeriesAutopilot unattended. Covers:
 *  - activeSchedules() pure filter (enabled + valid cron + dedup by seriesId)
 *  - registration/cancellation on sync (added, removed, disabled, edited cron)
 *  - the handler re-reads settings, honors the cos-off gate, and forwards only
 *    the pinned run options to startSeriesAutopilot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./eventScheduler.js', () => ({
  schedule: vi.fn(),
  cancel: vi.fn(),
  // Accept the standard 5-field crons the tests use; reject the sentinel bad one.
  isValidCron: vi.fn((expr) => typeof expr === 'string' && expr !== 'not a cron' && expr.trim().split(/\s+/).length === 5),
}));

// settingsEvents only needs `.on` at module load (the re-sync subscription).
vi.mock('./settings.js', () => ({ getSettings: vi.fn(), settingsEvents: { on: vi.fn() } }));
vi.mock('./pipeline/series.js', () => ({ getSeries: vi.fn() }));
vi.mock('./pipeline/seriesAutopilot.js', () => ({ startSeriesAutopilot: vi.fn() }));
vi.mock('../lib/timezone.js', () => ({ getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles') }));

import { schedule, cancel } from './eventScheduler.js';
import { getSettings } from './settings.js';
import { getSeries } from './pipeline/series.js';
import { startSeriesAutopilot } from './pipeline/seriesAutopilot.js';
import {
  activeSchedules,
  syncSeriesAutopilotSchedules,
  startSeriesAutopilotScheduler,
  stopSeriesAutopilotScheduler,
} from './seriesAutopilotScheduler.js';

const withSchedules = (schedules) => ({ seriesAutopilot: { schedules } });

beforeEach(() => {
  // Clear the module-level registered Set BEFORE clearing mocks, so the teardown
  // cancel() calls for a prior test's leftover registrations aren't recorded
  // against this test's cancel mock.
  stopSeriesAutopilotScheduler();
  vi.clearAllMocks();
  getSeries.mockResolvedValue({ id: 's1', name: 'Test Series' });
  startSeriesAutopilot.mockResolvedValue({ runId: 'r1' });
});

describe('activeSchedules', () => {
  it('keeps only enabled entries with a valid cron and a seriesId', () => {
    const out = activeSchedules(withSchedules([
      { seriesId: 's1', enabled: true, cron: '0 3 * * *' },
      { seriesId: 's2', enabled: false, cron: '0 3 * * *' },   // disabled
      { seriesId: 's3', enabled: true, cron: 'not a cron' },   // bad cron
      { seriesId: '', enabled: true, cron: '0 3 * * *' },      // no id
      { enabled: true, cron: '0 3 * * *' },                    // no id key
    ]));
    expect(out.map((s) => s.seriesId)).toEqual(['s1']);
  });

  it('deduplicates by seriesId (last-wins)', () => {
    const out = activeSchedules(withSchedules([
      { seriesId: 's1', enabled: true, cron: '0 3 * * *' },
      { seriesId: 's1', enabled: true, cron: '0 9 * * *' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].cron).toBe('0 9 * * *');
  });

  it('returns [] for missing/malformed settings', () => {
    expect(activeSchedules(undefined)).toEqual([]);
    expect(activeSchedules({})).toEqual([]);
    expect(activeSchedules({ seriesAutopilot: { schedules: 'nope' } })).toEqual([]);
  });
});

describe('syncSeriesAutopilotSchedules', () => {
  it('registers a cron per active schedule, honoring per-entry then user timezone', async () => {
    const count = await syncSeriesAutopilotSchedules(withSchedules([
      { seriesId: 's1', enabled: true, cron: '0 3 * * *', timezone: 'Europe/Paris' },
      { seriesId: 's2', enabled: true, cron: '30 2 * * *' },
    ]));
    expect(count).toBe(2);
    expect(schedule).toHaveBeenCalledTimes(2);
    expect(schedule.mock.calls[0][0]).toMatchObject({
      id: 'series-autopilot-s1', type: 'cron', cron: '0 3 * * *', timezone: 'Europe/Paris',
    });
    // Falls back to the user timezone when the entry has none.
    expect(schedule.mock.calls[1][0]).toMatchObject({
      id: 'series-autopilot-s2', timezone: 'America/Los_Angeles',
    });
  });

  it('cancels a cron whose schedule was removed or disabled on a later sync', async () => {
    await syncSeriesAutopilotSchedules(withSchedules([
      { seriesId: 's1', enabled: true, cron: '0 3 * * *' },
      { seriesId: 's2', enabled: true, cron: '0 3 * * *' },
    ]));
    schedule.mockClear();

    // s2 disabled, s1 kept.
    await syncSeriesAutopilotSchedules(withSchedules([
      { seriesId: 's1', enabled: true, cron: '0 3 * * *' },
      { seriesId: 's2', enabled: false, cron: '0 3 * * *' },
    ]));
    expect(cancel).toHaveBeenCalledWith('series-autopilot-s2');
    expect(cancel).not.toHaveBeenCalledWith('series-autopilot-s1');
  });

  it('re-reads settings when none passed', async () => {
    getSettings.mockResolvedValue(withSchedules([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]));
    const count = await syncSeriesAutopilotSchedules();
    expect(getSettings).toHaveBeenCalled();
    expect(count).toBe(1);
  });

  it('short-circuits a re-sync when nothing registration-affecting changed', async () => {
    const snap = withSchedules([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]);
    await syncSeriesAutopilotSchedules(snap);
    schedule.mockClear();
    // Same schedules → no re-registration (an unrelated settings save shouldn't churn crons).
    await syncSeriesAutopilotSchedules(snap);
    expect(schedule).not.toHaveBeenCalled();
    // A changed cron DOES re-register.
    await syncSeriesAutopilotSchedules(withSchedules([{ seriesId: 's1', enabled: true, cron: '0 9 * * *' }]));
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe('scheduled handler', () => {
  async function registerAndGetHandler(entry) {
    await syncSeriesAutopilotSchedules(withSchedules([entry]));
    return schedule.mock.calls.at(-1)[0].handler;
  }

  it('starts the autopilot, mapping provider/model to the override keys', async () => {
    const entry = { seriesId: 's1', enabled: true, cron: '0 3 * * *', provider: 'anthropic', model: 'claude-opus-4-8' };
    const handler = await registerAndGetHandler(entry);
    getSettings.mockResolvedValue(withSchedules([entry]));
    await handler();
    // provider/model are mapped to the pipeline's providerOverride/modelOverride keys.
    expect(startSeriesAutopilot).toHaveBeenCalledWith('s1', {
      providerOverride: 'anthropic', modelOverride: 'claude-opus-4-8',
    });
  });

  it('skips when the schedule was disabled since registration', async () => {
    const handler = await registerAndGetHandler({ seriesId: 's1', enabled: true, cron: '0 3 * * *' });
    getSettings.mockResolvedValue(withSchedules([{ seriesId: 's1', enabled: false, cron: '0 3 * * *' }]));
    await handler();
    expect(startSeriesAutopilot).not.toHaveBeenCalled();
  });

  it('delegates the cos-off gate to startSeriesAutopilot and handles its rejection', async () => {
    // The scheduler no longer pre-checks the cos domain (it lives in cos state,
    // not settings) — startSeriesAutopilot owns the gate and returns rejected.
    const handler = await registerAndGetHandler({ seriesId: 's1', enabled: true, cron: '0 3 * * *' });
    getSettings.mockResolvedValue(withSchedules([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]));
    startSeriesAutopilot.mockResolvedValue({ rejected: true, mode: 'off' });
    await expect(handler()).resolves.toBeUndefined();
    expect(startSeriesAutopilot).toHaveBeenCalledWith('s1', {});
  });

  it('skips when the series no longer exists', async () => {
    const handler = await registerAndGetHandler({ seriesId: 's1', enabled: true, cron: '0 3 * * *' });
    getSettings.mockResolvedValue(withSchedules([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]));
    getSeries.mockResolvedValue(null);
    await handler();
    expect(startSeriesAutopilot).not.toHaveBeenCalled();
  });

  it('never throws even if startSeriesAutopilot rejects (runs outside the request lifecycle)', async () => {
    const handler = await registerAndGetHandler({ seriesId: 's1', enabled: true, cron: '0 3 * * *' });
    getSettings.mockResolvedValue(withSchedules([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]));
    startSeriesAutopilot.mockRejectedValue(new Error('boom'));
    await expect(handler()).resolves.toBeUndefined();
  });
});

describe('startSeriesAutopilotScheduler', () => {
  it('is a thin boot wrapper over the settings-reading sync', async () => {
    getSettings.mockResolvedValue(withSchedules([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]));
    await startSeriesAutopilotScheduler();
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'series-autopilot-s1' }));
  });
});
