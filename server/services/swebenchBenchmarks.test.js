vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})), updateSettingsWith: vi.fn() }));
import { describe, expect, it, vi } from 'vitest';
import {
  fetchSwebenchLeaderboards,
  transformSwebenchResultsToObservations,
  syncSwebenchCatalog,
} from './swebenchBenchmarks.js';
import * as modelComparison from './modelComparison.js';

const leaderboard = (name, results) => ({ name, results });
const result = overrides => ({
  agent: 'mini-SWE-agent', agent_org: 'Example Org', checked: true,
  cost: 10, date: '2026-02-13', folder: '20260213_mini-v2.0.0a0_example-model',
  instance_calls: 50, instance_cost: 0.35, model_display: 'Example Model',
  model_org: 'Example Org', name: 'Example Model', os_model: false, os_system: true,
  reasoning_effort: null, resolved: 52.62, tags: ['Model: example-model', 'Org: Example Org'], warning: null,
  ...overrides,
});

describe('swebenchBenchmarks service', () => {
  describe('transformSwebenchResultsToObservations', () => {
    it('maps a scored-track submission into a scaffold-scoped observation', () => {
      const obs = transformSwebenchResultsToObservations([leaderboard('Verified', [result()])], { retrievedAt: '2026-09-17T00:00:00Z' });
      expect(obs).toHaveLength(1);
      expect(obs[0]).toMatchObject({
        id: 'swebench-verified-example-model-mini-swe-agent-20260213-mini-v2.0.0a0-example-model',
        provider: 'Example Org',
        model: 'example-model',
        effort: 'unspecified',
        billing: 'api',
        benchmark: 'SWE-bench Verified (pass@1, mini-SWE-agent)',
      });
      expect(obs[0].quality.value).toBe(52.62);
      expect(obs[0].quality.source.methodology).toContain('agent scaffold mini-SWE-agent');
      expect(obs[0].costPerTask.value).toBe(0.35);
      expect(obs[0].costPerTask.source.methodology).toContain('mean USD cost per instance');
      expect(obs[0].inputPerMillion).toBeNull();
      expect(obs[0].responseSeconds).toBeNull();
    });

    it('excludes the Test playground track and rows without an attributable model', () => {
      const obs = transformSwebenchResultsToObservations([
        leaderboard('Test', [result()]),
        leaderboard('Verified', [result({ model_display: 'Undisclosed' }), result({ folder: '20260213_b_example-model' })]),
        leaderboard('Lite', [result({ model_display: 'Multiple' })]),
        leaderboard('Multimodal', [result()]),
      ]);
      expect(obs).toHaveLength(2);
      expect(obs.map(o => o.benchmark).sort()).toEqual([
        'SWE-bench Multimodal (pass@1, mini-SWE-agent)', 'SWE-bench Verified (pass@1, mini-SWE-agent)',
      ]);
    });

    it('keeps a run without published cost as unknown billing and skips rows with no sourced metric', () => {
      const obs = transformSwebenchResultsToObservations([leaderboard('Verified', [
        result({ instance_cost: null, cost: null }),
        result({ resolved: null, instance_cost: null }),
      ])]);
      expect(obs).toHaveLength(1);
      expect(obs[0].billing).toBe('unknown');
      expect(obs[0].costPerTask).toBeNull();
      expect(obs[0].quality.value).toBe(52.62);
    });

    it('keeps duplicate runs of one model+agent as distinct observations under one series', () => {
      const obs = transformSwebenchResultsToObservations([leaderboard('Verified', [
        result(),
        result({ folder: '20260101_mini-v2.0.0a0_example-model', date: '2026-01-01' }),
      ])]);
      expect(obs).toHaveLength(2);
      expect(new Set(obs.map(o => o.id)).size).toBe(2);
      expect(new Set(obs.map(o => o.benchmark)).size).toBe(1);
    });

    it('maps a recognized reasoning effort and keeps a leaderboard warning in notes', () => {
      const obs = transformSwebenchResultsToObservations([leaderboard('Verified', [
        result({ reasoning_effort: 'high', warning: 'Older submission' }),
        result({ reasoning_effort: 'unrecognized-effort' }),
      ])]);
      expect(obs.map(o => o.effort)).toEqual(['high', 'unspecified']);
      expect(obs[0].notes).toContain('Leaderboard warning: Older submission');
    });
  });

  describe('fetchSwebenchLeaderboards', () => {
    it('maps a non-ok response to a 502', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'boom' })));
      try {
        await expect(fetchSwebenchLeaderboards()).rejects.toMatchObject({ name: 'ServerError', status: 502 });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('refuses a page without the leaderboard data script', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => '<html><body>empty</body></html>' })));
      try {
        await expect(fetchSwebenchLeaderboards()).rejects.toThrow(/no leaderboard data/);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('extracts the inline leaderboard JSON', async () => {
      const data = [leaderboard('Verified', [result()])];
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200,
        text: async () => `<html><script type="application/json" id="leaderboard-data">${JSON.stringify(data)}</script></html>`,
      })));
      try {
        expect(await fetchSwebenchLeaderboards()).toEqual(data);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('syncSwebenchCatalog', () => {
    it('syncs and imports observations without a key', async () => {
      const importSpy = vi.spyOn(modelComparison, 'importModelComparison').mockResolvedValue({
        schemaVersion: 1, observations: [{ id: 'obs-1' }],
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200,
        text: async () => `<html><script type="application/json" id="leaderboard-data">${JSON.stringify([leaderboard('Verified', [result()])])}</script></html>`,
      })));
      try {
        const res = await syncSwebenchCatalog();
        expect(res.success).toBe(true);
        expect(res.fetched).toBe(1);
        expect(res.observations).toBe(1);
        expect(importSpy.mock.calls[0][0].observations[0].benchmark).toBe('SWE-bench Verified (pass@1, mini-SWE-agent)');
      } finally {
        vi.unstubAllGlobals();
        importSpy.mockRestore();
      }
    });

    it('refuses a sync that produces no attributable observations', async () => {
      const importSpy = vi.spyOn(modelComparison, 'importModelComparison');
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200,
        text: async () => `<html><script type="application/json" id="leaderboard-data">${JSON.stringify([leaderboard('Test', [result()])])}</script></html>`,
      })));
      try {
        await expect(syncSwebenchCatalog()).rejects.toThrow(/no attributable observations/);
        expect(importSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        importSpy.mockRestore();
      }
    });
  });
});
