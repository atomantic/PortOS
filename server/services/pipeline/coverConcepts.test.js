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

const issuesSvc = await import('./issues.js');
const seriesSvc = await import('./series.js');
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

describe('arcPlanner — generateComicCoverConcepts', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  async function setupIssue(stageOverrides = {}) {
    const s = await setupSeries();
    const issue = await issuesSvc.createIssue({
      seriesId: s.id,
      title: 'The Pilot',
      stages: {
        idea: { status: 'ready', input: 'A silent foundry mystery.', output: '- beat 1\n- beat 2' },
        prose: { status: 'ready', output: 'The bell tower lay quiet over the brackish quay…' },
        ...stageOverrides,
      },
    });
    return { series: s, issue };
  }

  it('feeds series + issue context (name, logline, styleNotes, idea.input/output, prose excerpt) into the prompt', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front concept', backCoverConcept: 'back concept' },
      runId: 'run-cv-1', providerId: 'claude', model: 'opus-4',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id);

    expect(stageRunnerSpy).toHaveBeenCalledTimes(1);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-comic-cover-concepts',
      expect.objectContaining({
        series: expect.objectContaining({
          name: 'Salt Run',
          logline: 'A foundry city goes silent.',
          styleNotes: 'moebius linework',
        }),
        issue: expect.objectContaining({
          title: 'The Pilot',
          synopsis: 'A silent foundry mystery.',
          beats: '- beat 1\n- beat 2',
          proseExcerpt: 'The bell tower lay quiet over the brackish quay…',
        }),
      }),
      expect.objectContaining({ returnsJson: true, source: 'pipeline-comic-cover-concepts' }),
    );
    expect(out.coverConcept).toBe('front concept');
    expect(out.backCoverConcept).toBe('back concept');
    expect(out.target).toBe('both');
    // No commit ⇒ no seeding.
    expect(out.seeded).toEqual({ cover: false, backCover: false });
    expect(out.issue).toBeNull();
    expect(out.runId).toBe('run-cv-1');
  });

  it('caps very long prose at a 4000-char excerpt so the prompt budget stays bounded', async () => {
    const longProse = 'x'.repeat(5000);
    const { issue } = await setupIssue({
      prose: { status: 'ready', output: longProse },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'c', backCoverConcept: 'b' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    await planner.generateComicCoverConcepts(issue.id);

    const ctx = stageRunnerSpy.mock.calls[0][1];
    // 4000 chars of x + ellipsis truncation marker.
    expect(ctx.issue.proseExcerpt).toBe(`${'x'.repeat(4000)}…`);
    expect(ctx.issue.proseExcerpt.length).toBe(4001);
  });

  it('commit:true seeds BOTH cover + backCover scripts when slots are blank (target=both)', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front-seed', backCoverConcept: 'back-seed' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    expect(out.seeded).toEqual({ cover: true, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('front-seed');
    expect(stored.stages.comicPages.backCover.script).toBe('back-seed');
  });

  it('commit:true with target="cover" ONLY seeds the cover slot, even when LLM returns both', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front-seed', backCoverConcept: 'back-seed' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true, target: 'cover' });

    expect(out.seeded).toEqual({ cover: true, backCover: false });
    // Return shape still surfaces both concepts to the caller even though
    // only the targeted slot was seeded.
    expect(out.coverConcept).toBe('front-seed');
    expect(out.backCoverConcept).toBe('back-seed');
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('front-seed');
    expect(stored.stages.comicPages.backCover?.script || '').toBe('');
  });

  it('commit:true with target="backCover" ONLY seeds the backCover slot', async () => {
    const { issue } = await setupIssue();
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'front-seed', backCoverConcept: 'back-seed' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true, target: 'backCover' });

    expect(out.seeded).toEqual({ cover: false, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover?.script || '').toBe('');
    expect(stored.stages.comicPages.backCover.script).toBe('back-seed');
  });

  it('commit:true does NOT overwrite non-empty cover.script (preserves user edits, even with target=both)', async () => {
    const { issue } = await setupIssue();
    // User-edited cover script in place before the LLM runs.
    await issuesSvc.updateStage(issue.id, 'comicPages', {
      cover: { script: 'USER WROTE THIS' },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'LLM front', backCoverConcept: 'LLM back' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    // cover was occupied ⇒ skipped; backCover was blank ⇒ seeded.
    expect(out.seeded).toEqual({ cover: false, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('USER WROTE THIS');
    expect(stored.stages.comicPages.backCover.script).toBe('LLM back');
  });

  it('commit:true does NOT overwrite non-empty backCover.script (preserves user edits)', async () => {
    const { issue } = await setupIssue();
    await issuesSvc.updateStage(issue.id, 'comicPages', {
      backCover: { script: 'USER BACK COVER' },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'LLM front', backCoverConcept: 'LLM back' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    expect(out.seeded).toEqual({ cover: true, backCover: false });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('LLM front');
    expect(stored.stages.comicPages.backCover.script).toBe('USER BACK COVER');
  });

  it('rejects an invalid target value', async () => {
    const { issue } = await setupIssue();
    await expect(
      planner.generateComicCoverConcepts(issue.id, { target: 'sideCover' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid target') });
    // LLM should never have been called for a validation failure.
    expect(stageRunnerSpy).toBeUndefined();
  });

  it('rejects an empty-string target (does not silently fall back to "both")', async () => {
    const { issue } = await setupIssue();
    await expect(
      planner.generateComicCoverConcepts(issue.id, { target: '' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('Invalid target') });
    expect(stageRunnerSpy).toBeUndefined();
  });

  it('treats a whitespace-only existing script as blank and seeds it (client/server parity)', async () => {
    // The client gate uses `.trim()` — the server must agree so a
    // " \n " script doesn't enable the button but skip seeding.
    const { issue } = await setupIssue();
    await issuesSvc.updateStage(issue.id, 'comicPages', {
      cover: { script: '   \n  ' },
      backCover: { script: '\t' },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { coverConcept: 'LLM front', backCoverConcept: 'LLM back' },
      runId: 'r', providerId: 'p', model: 'm',
    }));

    const out = await planner.generateComicCoverConcepts(issue.id, { commit: true });

    expect(out.seeded).toEqual({ cover: true, backCover: true });
    const stored = await issuesSvc.getIssue(issue.id);
    expect(stored.stages.comicPages.cover.script).toBe('LLM front');
    expect(stored.stages.comicPages.backCover.script).toBe('LLM back');
  });
});
