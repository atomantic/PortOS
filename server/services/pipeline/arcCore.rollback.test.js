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

describe('arcPlanner — snapshotArcState / restoreArcState (resolve-round rollback)', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  // Stand up the shape one auto-resolve round can touch: an arc, two volumes,
  // and an episode under each carrying a planning synopsis.
  async function seedArc() {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'original logline', summary: 'original summary' },
      characterArcs: [{
        characterId: 'chr-lead', characterName: 'Lead', want: 'escape', need: 'trust',
        startState: 'guarded', endState: 'open',
        transitions: [{ id: 'trn-sacrifice', kind: 'sacrifice', atIssue: 12, label: 'chooses the crew' }],
      }],
    });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'Volume 1', synopsis: 'v1 synopsis', episodeCountTarget: 2 });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'Volume 2', synopsis: 'v2 synopsis', episodeCountTarget: 2 });
    const e1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Ep 1' });
    const e2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v2.id, title: 'Ep 2' });
    await issuesSvc.updateStage(e1.id, 'idea', { input: 'e1 planning synopsis' });
    await issuesSvc.updateStage(e2.id, 'idea', { input: 'e2 planning synopsis' });
    return { s, v1, v2, e1, e2 };
  }

  it('puts back the arc, the volume list and the episode synopses a round rewrote', async () => {
    const { s, v1, v2, e1, e2 } = await seedArc();
    const snapshot = await planner.snapshotArcState(s.id);

    // Simulate the damage a regressive resolve round does: rewrite the arc,
    // rewrite a volume, mint a third one, move an episode onto it, and rewrite
    // the other episode's synopsis (clearing its beats the way
    // applyEpisodeResolutions does).
    const minted = await seasonsSvc.createSeason(s.id, { title: 'Volume 1', synopsis: 'duplicate', episodeCountTarget: 2 });
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'rewritten logline', summary: 'rewritten summary' },
      characterArcs: [{
        characterId: 'chr-lead', characterName: 'Lead', want: 'escape', need: 'control',
        startState: 'guarded', endState: 'alone',
        transitions: [{ id: 'trn-sacrifice', kind: 'sacrifice', atIssue: 11, label: 'wrong milestone' }],
      }],
      seasons: [{ ...v1, synopsis: 'rewritten v1' }, v2, minted],
    });
    await issuesSvc.updateIssue(e2.id, { seasonId: minted.id });
    await issuesSvc.updateStage(e1.id, 'idea', { input: 'rewritten e1 synopsis', output: '', status: 'empty' });

    const result = await planner.restoreArcState(s.id, snapshot);
    expect(result).toMatchObject({ restored: true, episodesRestored: 1, reassignedIssueCount: 1 });

    const series = await seriesSvc.getSeries(s.id);
    expect(series.arc.logline).toBe('original logline');
    expect(series.characterArcs[0]).toMatchObject({ need: 'trust', endState: 'open' });
    expect(series.characterArcs[0].transitions[0]).toMatchObject({ id: 'trn-sacrifice', atIssue: 12, label: 'chooses the crew' });
    expect(series.seasons.map((x) => x.id)).toEqual([v1.id, v2.id]);
    expect(series.seasons[0].synopsis).toBe('v1 synopsis');
    // The minted volume is gone, so the episode it took has to come back with
    // it — otherwise the rollback strands it in the ungrouped bucket.
    expect((await issuesSvc.getIssue(e2.id)).seasonId).toBe(v2.id);
    expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('e1 planning synopsis');
  });

  // The rollback used to treat ANY difference from the snapshot as the round's
  // own work — see `createArcMutationLedger` for the run that exposed it.
  describe('restores only the episodes the resolve round is on record as writing', () => {
    // The damage every case below shares: a rewritten arc, a minted volume that
    // took an episode off its own, and a synopsis rewrite on e1.
    // Bound once so the manifest provably reports the value that was written.
    const WROTE = { input: 'resolver rewrote e1', output: '', status: 'empty' };

    async function regressiveRound({ s, v1, v2, e1 }) {
      const minted = await seasonsSvc.createSeason(s.id, { title: 'Volume 1', synopsis: 'duplicate', episodeCountTarget: 2 });
      await seriesSvc.updateSeries(s.id, {
        arc: { logline: 'rewritten logline', summary: 'rewritten summary' },
        seasons: [{ ...v1, synopsis: 'rewritten v1' }, v2, minted],
      });
      await issuesSvc.updateIssue(e1.id, { seasonId: minted.id });
      await issuesSvc.updateStage(e1.id, 'idea', { ...WROTE });
      return { e1Edit: { issueId: e1.id, idea: { ...WROTE } } };
    }

    it('reverts its own episode write and the volume it drove, and keeps an unrelated one', async () => {
      const seed = await seedArc();
      const { s, v2, e1, e2 } = seed;
      const snapshot = await planner.snapshotArcState(s.id);
      const { e1Edit } = await regressiveRound(seed);
      // Lands between the snapshot and the rollback, from outside this round.
      await issuesSvc.updateStage(e2.id, 'idea', { input: 'edited elsewhere mid-verify' });

      const result = await planner.restoreArcState(s.id, snapshot, { episodeEdits: [e1Edit] });
      expect(result).toMatchObject({ restored: true, episodesRestored: 1, reassignedIssueCount: 1 });

      const series = await seriesSvc.getSeries(s.id);
      expect(series.arc.logline).toBe('original logline');
      expect(series.seasons[0].synopsis).toBe('v1 synopsis');
      expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('e1 planning synopsis');
      // The minted volume is gone, so its episode still has to come back with it.
      expect((await issuesSvc.getIssue(e1.id)).seasonId).toBe(seed.v1.id);
      expect((await issuesSvc.getIssue(e2.id)).stages.idea.input).toBe('edited elsewhere mid-verify');
      expect((await issuesSvc.getIssue(e2.id)).seasonId).toBe(v2.id);
    });

    it('leaves an episode it wrote alone once a later write lands on top of it', async () => {
      const seed = await seedArc();
      const { s, e1 } = seed;
      const snapshot = await planner.snapshotArcState(s.id);
      const { e1Edit } = await regressiveRound(seed);
      await issuesSvc.updateStage(e1.id, 'idea', { input: 'a human kept editing after the resolver' });

      const result = await planner.restoreArcState(s.id, snapshot, { episodeEdits: [e1Edit] });
      expect(result).toMatchObject({ restored: true, episodesRestored: 0 });
      expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('a human kept editing after the resolver');
      // The arc-level revert still happens — only the episode is off limits.
      expect((await seriesSvc.getSeries(s.id)).arc.logline).toBe('original logline');
    });

    it('restores no synopsis at all for an arc-spine round (empty manifest)', async () => {
      const seed = await seedArc();
      const { s, e1 } = seed;
      const snapshot = await planner.snapshotArcState(s.id);
      await regressiveRound(seed);

      const result = await planner.restoreArcState(s.id, snapshot, { episodeEdits: [] });
      expect(result).toMatchObject({ restored: true, episodesRestored: 0, reassignedIssueCount: 1 });
      expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe(WROTE.input);
      expect((await seriesSvc.getSeries(s.id)).seasons.map((x) => x.id)).toEqual([seed.v1.id, seed.v2.id]);
      expect((await issuesSvc.getIssue(e1.id)).seasonId).toBe(seed.v1.id);
    });
  });

  it('leaves a locked idea stage alone (the resolve pass never touched it)', async () => {
    const { s, e1 } = await seedArc();
    const snapshot = await planner.snapshotArcState(s.id);
    await issuesSvc.updateStage(e1.id, 'idea', { input: 'user edit after the snapshot', locked: true });

    const result = await planner.restoreArcState(s.id, snapshot);
    expect(result.episodesRestored).toBe(0);
    expect((await issuesSvc.getIssue(e1.id)).stages.idea.input).toBe('user edit after the snapshot');
  });

  it('refuses a snapshot that belongs to another series, and a missing one', async () => {
    const { s } = await seedArc();
    const other = await planner.snapshotArcState((await seedArc()).s.id);
    expect(await planner.restoreArcState(s.id, other)).toMatchObject({ restored: false });
    expect(await planner.restoreArcState(s.id, null)).toMatchObject({ restored: false });
    // Untouched by the refused restores.
    expect((await seriesSvc.getSeries(s.id)).arc.logline).toBe('original logline');
  });

  it('snapshots by value — a later write cannot mutate what was captured', async () => {
    const { s } = await seedArc();
    const snapshot = await planner.snapshotArcState(s.id);
    await seriesSvc.updateSeries(s.id, {
      arc: { logline: 'mutated', summary: 'mutated' },
      characterArcs: [{
        characterId: 'chr-lead', characterName: 'Lead', want: 'mutated', need: 'mutated',
        startState: 'mutated', endState: 'mutated', transitions: [],
      }],
    });
    expect(snapshot.arc.logline).toBe('original logline');
    expect(snapshot.characterArcs[0].want).toBe('escape');
  });
});

describe('arcPlanner — resolvedEpisodeEdits (rollback mutation manifest)', () => {
  it('carries only the writes that landed, with the value they left', () => {
    expect(planner.resolvedEpisodeEdits({
      episodesResolved: [
        { issueId: 'iss-1', number: 1, idea: { input: 'rewritten', output: '', status: 'empty' } },
        { issueId: 'iss-2', number: 2, skipped: 'locked' },
        { issueId: 'iss-3', number: 3, skipped: 'write-failed' },
        { seasonNumber: 2, episodeNumber: 9, skipped: 'no-match' },
      ],
    })).toEqual([{ issueId: 'iss-1', idea: { input: 'rewritten', output: '', status: 'empty' } }]);
  });

  it('is empty for a round that reported nothing — including an arc-spine one', () => {
    expect(planner.resolvedEpisodeEdits({ applied: true, episodesResolved: [] })).toEqual([]);
    expect(planner.resolvedEpisodeEdits({ applied: false })).toEqual([]);
    expect(planner.resolvedEpisodeEdits(null)).toEqual([]);
  });
});
