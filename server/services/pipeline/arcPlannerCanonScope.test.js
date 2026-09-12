import { describe, it, expect, vi } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  resolveStageContext: vi.fn(),
}));

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const seasonsSvc = await import('./seasons.js');
const worldSvc = await import('../universeBuilder.js');
const planner = await import('./arcPlanner.js');

async function setupSeries(overrides = {}) {
  return seriesSvc.createSeries({
    name: 'Salt Run',
    logline: 'A foundry city goes silent.',
    premise: 'Long-form premise.',
    styleNotes: 'moebius linework',
    issueCountTarget: 24,
    ...overrides,
  });
}

describe('planning canon at verifier boundaries', () => {
  it('keeps canon named only by current issue plans without admitting sibling or obsolete draft cast', async () => {
    const world = await worldSvc.createUniverse({
      name: 'Shared World',
      characters: [{ name: 'Jo Mercy' }, { name: 'Lio Fen' }, { name: 'Old Director' }, { name: 'Sibling Scout' }],
      places: [{ name: 'Lantern Archive' }],
      objects: [{ name: 'Brass Stamp' }],
    });
    const s = await setupSeries({ universeId: world.id });
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'A disputed testimony' } });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1', logline: 'The hearing' });
    await issuesSvc.createIssue({
      seriesId: s.id, seasonId: sea.id, title: 'The witness',
      stages: { idea: { input: 'Jo Mercy and Lio Fen enter the Lantern Archive with the Brass Stamp.', output: 'Old Director commands them.' }, prose: { output: 'Old Director wins.' } },
    });
    const sibling = await setupSeries({ universeId: world.id });
    await issuesSvc.createIssue({
      seriesId: sibling.id, title: 'Other series', stages: { idea: { input: 'Sibling Scout arrives.' } },
    });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'rv', providerId: 'p', model: 'm' }));

    await planner.verifyVolume(s.id, sea.id, { synopsisOnly: true });
    await planner.verifyArc(s.id);

    for (const [, ctx] of stageRunnerSpy.mock.calls) {
      for (const name of ['Jo Mercy', 'Lio Fen', 'Lantern Archive', 'Brass Stamp']) {
        expect(ctx.worldCanonText).toContain(name);
      }
      expect(ctx.worldCanonText).not.toContain('Old Director');
      expect(ctx.worldCanonText).not.toContain('Sibling Scout');
    }
    const arcContext = stageRunnerSpy.mock.calls[1][1];
    expect(JSON.parse(arcContext.existingCharactersJson).map((c) => c.name)).toEqual(['Jo Mercy', 'Lio Fen']);
  });
});
