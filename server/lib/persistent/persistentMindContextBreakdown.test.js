import { describe, expect, it } from 'vitest';
import {
  buildPersistentMindContextBreakdown,
  resolvePersistentMindWindowProvenance,
} from './persistentMindContextBreakdown.js';
import { assemblePersistentMindContext } from './persistentMindTrajectory.js';

const previewWith = (overrides = {}) => ({
  summaryState: 'empty',
  sectionChars: {
    identity: 400, instructions: 800, continuationNote: 0, memories: 1200,
    memoriesProtected: 400, memoriesRecalled: 0, memoriesOrdinary: 600,
    journalDigest: 40, rollups: 60, recentTrajectory: 0, reflection: 0,
  },
  ...overrides,
});
const toolCost = { totalChars: 4000, overheadChars: 400, families: [{ family: 'core', tools: 2, chars: 1200 }, { family: 'recipes', tools: 1, chars: 2400 }] };
const ids = (b) => b.categories.map((c) => c.id);

describe('buildPersistentMindContextBreakdown', () => {
  it('reports fixed-order categories, omits optional empties, keeps recent_trajectory at 0', () => {
    const b = buildPersistentMindContextBreakdown({ preview: previewWith(), toolCost, window: { contextMax: 32768, windowSource: 'advertised' } });
    expect(ids(b)).toEqual(['identity', 'instructions', 'memories', 'journal_digest', 'recent_trajectory', 'tool_definitions', 'output_reserve', 'free']);
    expect(b.categories.find((c) => c.id === 'recent_trajectory').tokens).toBe(0);
    expect(b.categories.find((c) => c.id === 'memories').detail.map((d) => d.id)).toEqual(['protected', 'standard']);
    expect(b.categories.find((c) => c.id === 'tool_definitions').detail.map((d) => d.id)).toEqual(['core', 'recipes', 'overhead']);
    expect(b.occupancySource).toBe('local_estimate');
    expect(b.promptCache).toBeNull();
  });

  it('includes continuation note and rollups when present', () => {
    const preview = previewWith({ summaryState: 'ready' });
    preview.sectionChars.continuationNote = 200;
    const b = buildPersistentMindContextBreakdown({ preview, window: { contextMax: 32768, windowSource: 'advertised' } });
    expect(ids(b)).toContain('continuation_note');
    expect(ids(b)).toContain('rollups');
    expect(ids(b)).not.toContain('tool_definitions');
  });

  it('keeps the window unknown rather than inventing headroom', () => {
    const b = buildPersistentMindContextBreakdown({ preview: previewWith(), window: resolvePersistentMindWindowProvenance({}) });
    expect(b.windowSource).toBe('unknown');
    expect(b.contextMax).toBeNull();
    expect(b.contextPercent).toBeNull();
    expect(ids(b)).not.toContain('free');
  });

  it('scales to a measured turn input and flags high occupancy', () => {
    const b = buildPersistentMindContextBreakdown({
      preview: previewWith(), window: { contextMax: 10000, windowSource: 'pinned' },
      lastCall: { purpose: 'turn', usage: { inputTokens: 8000, cacheReadTokens: 2000, cacheWriteTokens: 0 } },
    });
    expect(b.occupancySource).toBe('provider_usage_plus_estimate');
    expect(b.contextUsed).toBe(8000);
    expect(b.highOccupancy).toBe(true);
    expect(b.promptCache).toEqual({ cacheReadTokens: 2000, cacheWriteTokens: 0, hitRatio: 0.2 });
  });

  it('uses provider usage alone when nothing can be estimated, and ignores non-turn calls', () => {
    const measured = buildPersistentMindContextBreakdown({ window: { contextMax: 10000 }, lastCall: { purpose: 'turn', usage: { inputTokens: 500 } } });
    expect(measured.occupancySource).toBe('provider_usage');
    const summary = buildPersistentMindContextBreakdown({ preview: previewWith(), window: { contextMax: 10000 }, lastCall: { purpose: 'summary', usage: { inputTokens: 500 } } });
    expect(summary.occupancySource).toBe('local_estimate');
  });

  it('reads real assembled sections', () => {
    const preview = assemblePersistentMindContext({ identity: 'I am a mind', instructions: 'Be kind' });
    const b = buildPersistentMindContextBreakdown({ preview, window: { contextMax: 32768, windowSource: 'advertised' } });
    expect(b.categories.find((c) => c.id === 'identity').tokens).toBeGreaterThan(0);
  });
});

describe('resolvePersistentMindWindowProvenance', () => {
  it('pinned numCtx that differs from the advertised window is surfaced', () => {
    const w = resolvePersistentMindWindowProvenance({ provider: { numCtx: 32768, contextWindow: 131072 }, model: 'm', effectiveWindow: 32768 });
    expect(w).toMatchObject({ windowSource: 'pinned', contextMax: 32768, pinnedWindow: 32768, advertisedWindow: 131072, pinDisagreesWithAdvertised: true });
  });
  it('per-model pin beats provider pin; matching advertised is no disagreement', () => {
    const w = resolvePersistentMindWindowProvenance({ provider: { numCtx: 4096, modelNumCtx: { m: 8192 }, modelContextWindows: { m: 8192 } }, model: 'm', effectiveWindow: 8192 });
    expect(w).toMatchObject({ windowSource: 'pinned', pinnedWindow: 8192, pinDisagreesWithAdvertised: false });
  });
  it('advertised, fallback and unknown', () => {
    expect(resolvePersistentMindWindowProvenance({ provider: { contextWindow: 65536 }, effectiveWindow: 65536 }).windowSource).toBe('advertised');
    expect(resolvePersistentMindWindowProvenance({ provider: {}, effectiveWindow: 8192 }).windowSource).toBe('fallback');
    expect(resolvePersistentMindWindowProvenance({ provider: null }).windowSource).toBe('unknown');
  });
});
