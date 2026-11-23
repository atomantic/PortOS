/**
 * Regression (#17596): aggregateTwinEvidence, interpretConsumption and the peer-sync
 * merge all read-modify-write taste-observed.json; they must serialize so neither
 * the AI interpretation nor the fresh rollup is lost to a stale read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const files = new Map();
const tick = () => new Promise((r) => setTimeout(r, 5));

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { digitalTwin: '/tw', data: '/tw' },
  ensureDir: async () => {},
  readJSONFile: async (p, fallback) => {
    await tick();
    return files.has(p) ? structuredClone(files.get(p)) : fallback;
  },
  atomicWrite: async (p, v) => {
    await tick();
    files.set(p, structuredClone(v));
  },
}));
vi.mock('../lib/db.js', () => ({ ensureSchema: async () => {}, query: async () => ({ rows: [] }) }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('./provider/providers.js', () => ({
  getProviderById: async () => ({ id: 'p', name: 'P', enabled: true, defaultModel: 'm' }),
}));
vi.mock('./promptRunner.js', () => ({
  runPromptThroughProvider: async () => {
    await tick();
    return { text: 'you like jazz', model: 'm' };
  },
}));

const { aggregateTwinEvidence, interpretConsumption, applyTasteObservedMerge } = await import('./twinEnrichment.js');

const key = () => [...files.keys()].find((k) => k.endsWith('taste-observed.json'));

describe('taste-observed.json write serialization', () => {
  beforeEach(() => files.clear());

  it('keeps the interpretation and the rollup/merge under overlapping writers', async () => {
    await aggregateTwinEvidence();
    await Promise.all([
      interpretConsumption({ providerId: 'p' }),
      aggregateTwinEvidence(),
      applyTasteObservedMerge((local) => ({ merged: { ...local, syncedMarker: true }, changed: true })),
      aggregateTwinEvidence(),
    ]);
    const final = files.get(key());
    expect(final.interpretation?.text).toBe('you like jazz');
    expect(final.windows).toBeTruthy();
    // merge ran serialized: either it saw the interpretation, or a later aggregate
    // preserved it; the marker must never vanish with the interpretation intact.
    await applyTasteObservedMerge((local) => ({ merged: { ...local, syncedMarker: true }, changed: true }));
    expect(files.get(key()).interpretation?.text).toBe('you like jazz');
  });
});
