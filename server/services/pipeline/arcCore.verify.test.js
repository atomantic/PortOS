import { describe, it, expect, vi, beforeEach } from 'vitest';
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

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

// Stub the staged-LLM runner so the test owns the LLM response shape.
// Each test sets `stageRunnerSpy = vi.fn(...)` to control what comes back.
vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  // Large window so completeness runs as a single call (mode: 'whole').
  resolveStageContext: vi.fn(() => Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 })),
}));

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const seasonsSvc = await import('./seasons.js');
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

describe('arcPlanner — verifyArc', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('throws 400 NO_ARC if the series has no arc to verify', async () => {
    const s = await setupSeries();
    await expect(planner.verifyArc(s.id))
      .rejects.toMatchObject({ status: 400, code: 'PIPELINE_NO_ARC' });
  });

  it('builds the seasons tree with grouped + ungrouped issues, then runs the prompt', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'Whole-arc pitch', summary: 'A long summary', themes: ['legacy'] },
    });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'Pilot', synopsis: 'season synopsis' });
    const grouped = await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 1', seasonId: sea.id, arcPosition: 1 });
    const ungrouped = await issuesSvc.createIssue({ seriesId: s.id, title: 'Floating' });

    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [{ severity: 'medium', location: 'season:1', problem: 'one beat', suggestion: 'add another' }] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    const out = await planner.verifyArc(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    const tree = JSON.parse(ctx.seasonsTreeJson);
    expect(tree[0].title).toBe('Pilot');
    expect(tree[0].episodes.map((e) => e.title)).toEqual([grouped.title]);
    expect(tree[tree.length - 1].title).toBe('(ungrouped issues)');
    expect(tree[tree.length - 1].episodes.map((e) => e.title)).toEqual([ungrouped.title]);

    expect(out.issues).toEqual([
      { severity: 'medium', location: 'season:1', problem: 'one beat', suggestion: 'add another' },
    ]);
  });

  // The verify prompt's arc-role imbalance check (#6) can only see what this
  // leaf renders. While `arcRole` was missing from it, a volume with a correct
  // pilot and finale still reported "zero pilot/finale" on every pass — and
  // because the foundation gate's structure arm reverts whenever verifyArc
  // leaves any blocker, that permanent false positive stalled the gate.
  it('renders climax and later finale roles with independent length profiles', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', summary: 'S' } });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1' });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 1', seasonId: sea.id, arcPosition: 1, arcRole: 'pilot' });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 2', seasonId: sea.id, arcPosition: 2 });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 3', seasonId: sea.id, arcPosition: 3, arcRole: 'climax', lengthProfile: 'extended' });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Ep 4', seasonId: sea.id, arcPosition: 4, arcRole: 'finale', lengthProfile: 'finale' });

    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r1', providerId: 'p', model: 'm' }));
    await planner.verifyArc(s.id);

    const tree = JSON.parse(stageRunnerSpy.mock.calls[0][1].seasonsTreeJson);
    // null (not absent) for the middle episode — "no role" has to be legible as
    // a value, or the check can't tell an unset role from a dropped field.
    expect(tree[0].episodes.map((e) => e.arcRole)).toEqual(['pilot', null, 'climax', 'finale']);
    expect(tree[0].episodes.map((e) => e.lengthProfile)).toEqual(['standard', 'standard', 'extended', 'finale']);
  });

  it('drops malformed verify issues + defaults severity to medium', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        issues: [
          { severity: 'high', problem: 'real one' },
          { problem: '' },                          // dropped — no problem
          { problem: 'no severity' },               // kept — severity defaults to medium
          { severity: 'bogus', problem: 'invalid severity', location: 'season:2' },
        ],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.verifyArc(s.id);
    expect(out.issues.map((i) => i.problem)).toEqual(['real one', 'no severity', 'invalid severity']);
    expect(out.issues[1].severity).toBe('medium');
    expect(out.issues[2].severity).toBe('medium');
  });
});

describe('arcPlanner — verifyVolume', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('throws 400 NO_ARC if the series has no arc to anchor the volume against', async () => {
    const s = await setupSeries();
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1', logline: 'l' });
    await expect(planner.verifyVolume(s.id, sea.id))
      .rejects.toMatchObject({ status: 400, code: 'PIPELINE_NO_ARC' });
  });

  it('throws NOT_FOUND when the season id does not exist on the series', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    await expect(planner.verifyVolume(s.id, 'sea-does-not-exist'))
      .rejects.toMatchObject({ code: 'PIPELINE_SEASON_NOT_FOUND' });
  });

  it('emits beats for expanded issues and synopsis for un-expanded ones, never both', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'Whole arc', summary: 'sum', themes: ['legacy'] },
    });
    const sea = await seasonsSvc.createSeason(s.id, {
      title: 'V1', logline: 'volume l', synopsis: 'volume s', endingHook: 'hook',
      episodeCountTarget: 3,
    });
    // Issue 1: has beats (LLM output filled). Expect `beats` field, no `synopsis`.
    const beatsIssue = await issuesSvc.createIssue({
      seriesId: s.id, title: 'Ep 1', seasonId: sea.id, arcPosition: 1,
      stages: { idea: { input: 'seed', output: 'beat 1\nbeat 2\nbeat 3', status: 'ready' } },
    });
    // Issue 2: synopsis-only (idea.input set, output empty). Expect `synopsis`,
    // no `beats`.
    const synopsisIssue = await issuesSvc.createIssue({
      seriesId: s.id, title: 'Ep 2', seasonId: sea.id, arcPosition: 2,
      stages: { idea: { input: 'just a seed', status: 'edited' } },
    });
    // Issue from another season — must not leak into this volume's payload.
    const otherSeason = await seasonsSvc.createSeason(s.id, { title: 'V2', logline: 'other' });
    await issuesSvc.createIssue({
      seriesId: s.id, title: 'Other vol issue', seasonId: otherSeason.id, arcPosition: 1,
      stages: { idea: { input: 'other', output: 'other beats', status: 'ready' } },
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [{ severity: 'high', problem: 'X', location: 'episode:1', suggestion: 'Y' }] },
      runId: 'rv', providerId: 'p', model: 'm',
    }));

    const out = await planner.verifyVolume(s.id, sea.id);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-volume-verify',
      expect.any(Object),
      expect.objectContaining({ returnsJson: true, source: 'pipeline-volume-verify' }),
    );

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.volume.title).toBe('V1');
    expect(ctx.volume.endingHook).toBe('hook');

    const volumeIssues = JSON.parse(ctx.volumeIssuesJson);
    expect(volumeIssues).toHaveLength(2);
    expect(volumeIssues[0].title).toBe(beatsIssue.title);
    expect(volumeIssues[0].beats).toContain('beat 1');
    expect(volumeIssues[0]).not.toHaveProperty('synopsis');
    expect(volumeIssues[1].title).toBe(synopsisIssue.title);
    expect(volumeIssues[1].synopsis).toBe('just a seed');
    expect(volumeIssues[1]).not.toHaveProperty('beats');

    expect(out.issues).toEqual([
      { severity: 'high', location: 'episode:1', problem: 'X', suggestion: 'Y' },
    ]);
    expect(out.seasonId).toBe(sea.id);
  });

  it('can force synopsis-only verification for the pre-beat autopilot planning gate', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'Whole arc' } });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1', logline: 'volume' });
    await issuesSvc.createIssue({
      seriesId: s.id,
      title: 'Ep 1',
      seasonId: sea.id,
      stages: { idea: { input: 'synopsis seed', output: 'existing beat sheet', status: 'ready' } },
    });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));

    await planner.verifyVolume(s.id, sea.id, { synopsisOnly: true });

    const [volumeIssue] = JSON.parse(stageRunnerSpy.mock.calls[0][1].volumeIssuesJson);
    expect(volumeIssue.synopsis).toBe('synopsis seed');
    expect(volumeIssue).not.toHaveProperty('beats');
  });

  it('includes only the immediate-neighbor volumes (prior + next), excluding self', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', logline: 'one' });
    const _v2 = await seasonsSvc.createSeason(s.id, { title: 'V2', logline: 'two', endingHook: 'hook2' });
    const v3 = await seasonsSvc.createSeason(s.id, { title: 'V3', logline: 'three' });
    const v4 = await seasonsSvc.createSeason(s.id, { title: 'V4', logline: 'four' });

    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm',
    }));
    // Verifying the middle volume should expose V2 (prior) + V4 (next), never V1 or V3 itself.
    await planner.verifyVolume(s.id, v3.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    const neighbors = JSON.parse(ctx.neighborsJson);
    expect(neighbors.map((n) => n.position)).toEqual(['prior', 'next']);
    expect(neighbors[0].title).toBe('V2');
    expect(neighbors[0].endingHook).toBe('hook2');
    expect(neighbors[1].title).toBe('V4');
    expect(neighbors.find((n) => n.title === 'V3')).toBeUndefined();
    expect(neighbors.find((n) => n.title === 'V1')).toBeUndefined();

    // First volume has no prior, only next.
    stageRunnerSpy.mockClear();
    stageRunnerSpy.mockImplementation(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v1.id);
    const firstNeighbors = JSON.parse(stageRunnerSpy.mock.calls[0][1].neighborsJson);
    expect(firstNeighbors.map((n) => n.position)).toEqual(['next']);

    // Last volume has no next, only prior.
    stageRunnerSpy.mockClear();
    stageRunnerSpy.mockImplementation(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v4.id);
    const lastNeighbors = JSON.parse(stageRunnerSpy.mock.calls[0][1].neighborsJson);
    expect(lastNeighbors.map((n) => n.position)).toEqual(['prior']);
  });

  it('returns empty issues for a clean volume + drops malformed entries', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L' } });
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V', logline: 'l' });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        issues: [
          { problem: '' },                                  // dropped
          { severity: 'low', problem: 'real but tiny' },    // kept
          'not an object',                                  // dropped
        ],
      },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await planner.verifyVolume(s.id, sea.id);
    expect(out.issues.map((i) => i.problem)).toEqual(['real but tiny']);
  });

  it('threads the shape + per-volume curve placement into the verifier context', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', shape: 'icarus', status: 'draft' } });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', number: 1, logline: 'l1' });
    await seasonsSvc.createSeason(s.id, { title: 'V2', number: 2, logline: 'l2' });
    await seasonsSvc.createSeason(s.id, { title: 'V3', number: 3, logline: 'l3' });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v1.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.shapeGuidance).toContain('Icarus');
    expect(ctx.volumeShapePosition).toContain('Volume 1 of 3');
    expect(ctx.volumeShapePosition).toContain('Icarus');
  });

  it('shape position falls back to a neutral note when no shape is selected', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { arc: { logline: 'L', status: 'draft' } });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', number: 1, logline: 'l1' });
    stageRunnerSpy = vi.fn(async () => ({ content: { issues: [] }, runId: 'r', providerId: 'p', model: 'm' }));
    await planner.verifyVolume(s.id, v1.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.volumeShapePosition).toMatch(/no story shape selected/i);
  });
});
