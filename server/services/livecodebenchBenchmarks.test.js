vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})), updateSettingsWith: vi.fn() }));
import { describe, expect, it, vi } from 'vitest';
import {
  fetchLiveCodeBenchPerformances,
  transformLiveCodeBenchToObservations,
  syncLiveCodeBenchCatalog,
} from './livecodebenchBenchmarks.js';
import * as modelComparison from './modelComparison.js';

const day = date => Date.parse(date);
const payload = {
  performances: [
    { question_id: '1_A', model: 'Example-Model', date: day('2024-01-01'), difficulty: 'easy', 'pass@1': 100.0, platform: 'codeforces' },
    { question_id: '2_A', model: 'Example-Model', date: day('2024-06-01'), difficulty: 'hard', 'pass@1': 50.0, platform: 'leetcode' },
    { question_id: '1_A', model: 'Other-Model (High)', date: day('2024-01-01'), difficulty: 'easy', 'pass@1': 80.0, platform: 'codeforces' },
    { question_id: '2_A', model: 'NoScore-Model', date: day('2024-01-01'), difficulty: 'easy', 'pass@1': 30.0, platform: 'codeforces' },
    { question_id: '3_A', model: 'Skipped-Model', date: day('2024-01-01'), difficulty: 'easy', 'pass@1': null, platform: 'codeforces' },
  ],
  models: [
    { model_name: 'example-model', model_repr: 'Example-Model', model_style: 'OpenAIChat', release_date: 1, link: 'https://example.com/model' },
    { model_name: 'other-model', model_repr: 'Other-Model (High)', model_style: 'OpenAIReason', release_date: 1, link: 'https://example.com/other' },
    { model_name: 'noscore', model_repr: 'NoScore-Model', model_style: 'XBai', release_date: 1, link: 'https://example.com/x' },
    { model_name: 'skipped', model_repr: 'Skipped-Model', model_style: 'XBai', release_date: 1, link: 'https://example.com/s' },
  ],
  date_marks: [],
};

describe('livecodebenchBenchmarks service', () => {
  describe('transformLiveCodeBenchToObservations', () => {
    it('aggregates pass@1 per model over the full window and names the window in the benchmark', () => {
      const obs = transformLiveCodeBenchToObservations(payload, { retrievedAt: '2026-09-17T00:00:00Z' });
      expect(obs).toHaveLength(3);
      const example = obs.find(o => o.model === 'example-model');
      expect(example).toMatchObject({
        id: 'lcb-generation-2024-01-01--2024-06-01-example-model-unspecified',
        provider: 'OpenAI',
        effort: 'unspecified',
        billing: 'api',
        benchmark: 'LiveCodeBench (generation, pass@1, 2024-01-01 to 2024-06-01)',
      });
      expect(example.quality.value).toBe(75.0);
      expect(example.quality.source.methodology).toContain('pass@1 mean over 2 problems');
      expect(example.costPerTask).toBeNull();
      expect(example.responseSeconds).toBeNull();
    });

    it('parses the parenthetical effort and its serving family', () => {
      const obs = transformLiveCodeBenchToObservations(payload);
      const other = obs.find(o => o.model === 'other-model');
      expect(other.effort).toBe('high');
      expect(other.configuration).toBe('High');
      expect(other.id).toBe('lcb-generation-2024-01-01--2024-06-01-other-model-high');
      expect(other.provider).toBe('OpenAI');
    });

    it('keeps an unmapped serving family as Unknown with the style in notes, and skips models with no numeric pass@1', () => {
      const obs = transformLiveCodeBenchToObservations(payload);
      expect(obs.some(o => o.model === 'skipped-model')).toBe(false);
      const unknown = obs.find(o => o.model === 'noscore-model');
      expect(unknown.provider).toBe('Unknown');
      expect(unknown.notes).toContain('serving style XBai');
    });

    it('refuses rows without any dated problem', () => {
      expect(() => transformLiveCodeBenchToObservations({
        performances: [{ question_id: '1_A', model: 'Example-Model', date: null, difficulty: 'easy', 'pass@1': 50.0 }],
        models: [],
      })).toThrow(/no dated problems/);
    });

    it('merges two reprs that normalize to one model+effort series', () => {
      const merged = transformLiveCodeBenchToObservations({
        performances: [
          { question_id: '1_A', model: 'Example-Model', date: day('2024-01-01'), difficulty: 'easy', 'pass@1': 100.0 },
          { question_id: '2_A', model: 'Example-Model', date: day('2024-01-01'), difficulty: 'easy', 'pass@1': 60.0 },
        ],
        models: [{ model_name: 'example', model_repr: 'Example-Model', model_style: 'OpenAIChat' }],
      });
      expect(merged).toHaveLength(1);
      expect(merged[0].quality.value).toBe(80.0);
      expect(merged[0].quality.source.methodology).toContain('over 2 problems');
    });
  });

  describe('fetchLiveCodeBenchPerformances', () => {
    it('maps a non-ok response to a 502', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, statusText: 'missing' })));
      try {
        await expect(fetchLiveCodeBenchPerformances()).rejects.toMatchObject({ name: 'ServerError', status: 502 });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      ['missing performances', { models: [] }],
      ['empty performances', { performances: [], models: [] }],
      ['missing models', { performances: [{ question_id: '1_A', model: 'Example-Model', date: 1, 'pass@1': 50 }] }],
    ])('refuses %s without importing', async (_label, body) => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
      try {
        await expect(fetchLiveCodeBenchPerformances()).rejects.toThrow(/invalid performance data/);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('syncLiveCodeBenchCatalog', () => {
    it('syncs and imports aggregated observations without a key', async () => {
      const importSpy = vi.spyOn(modelComparison, 'importModelComparison').mockResolvedValue({
        schemaVersion: 1, observations: [{ id: 'obs-1' }],
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
      try {
        const res = await syncLiveCodeBenchCatalog();
        expect(res.success).toBe(true);
        expect(res.fetched).toBe(5);
        expect(res.observations).toBe(3);
        expect(importSpy.mock.calls[0][0].observations[0].benchmark).toContain('LiveCodeBench (generation, pass@1,');
      } finally {
        vi.unstubAllGlobals();
        importSpy.mockRestore();
      }
    });

    it('refuses a sync whose window spans no dated problems', async () => {
      const importSpy = vi.spyOn(modelComparison, 'importModelComparison');
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ performances: [{ question_id: '1_A', model: 'Example-Model', date: null, 'pass@1': 50.0 }], models: [] }),
      })));
      try {
        await expect(syncLiveCodeBenchCatalog()).rejects.toThrow(/no dated problems/);
        expect(importSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        importSpy.mockRestore();
      }
    });
  });
});
