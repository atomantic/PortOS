/**
 * Foundation gate — structure repair rollback OWNERSHIP, against the real arc
 * store (#4135).
 *
 * `foundationJudge.test.js` stubs `restoreArcState`, so it can prove which
 * manifest each rollback is handed but not what the store looks like afterwards.
 * That is the half that mattered here: the repair's rollbacks used to revert
 * every episode `idea` that merely DIFFERED from the checkpoint, so a write that
 * landed from elsewhere across a resolve plus up to three correct/verify pairs
 * was reverted along with the candidate.
 *
 * These run `applyFoundationFix('…', 'structure')` with the REAL arc resolver,
 * snapshot and restore over an in-memory series/issue store (the setup
 * `arcPlanner.test.js` uses), stubbing only `verifyArc` — which doubles as the
 * place a foreign write lands mid-verification, exactly where the exposure is.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../../lib/fileUtils.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: '/mock/data' },
    ensureDir: vi.fn().mockResolvedValue(undefined),
    tryReadFile: vi.fn().mockResolvedValue(null),
    atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
    readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
  };
});

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  resolveStageContext: vi.fn(async () => ({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 })),
  resolveJudgeForStage: vi.fn(async () => ({ provider: { id: 'judge-x' }, model: 'jm' })),
}));

// Everything about the arc planner is REAL except the specialized verifier —
// the repair's control flow is driven by what it returns, and it is the one
// call that runs between a resolve and the rollback that judges it.
vi.mock('./arcPlanner.js', async (importActual) => ({
  ...(await importActual()),
  verifyArc: vi.fn(),
}));

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const seasonsSvc = await import('./seasons.js');
const arcPlanner = await import('./arcPlanner.js');
const { applyFoundationFix } = await import('./foundationJudge.js');

const REPAIR_FINDING = { gap: 'The issue plan contradicts the spine.', fix: 'Reconcile it.' };
const blockers = (n, prefix) => Array.from({ length: n }, (_, i) => ({
  severity: 'high', location: `Issue ${i + 1}`, problem: `${prefix} ${i + 1}`,
}));

// Two episodes under one volume, each with a planning synopsis the repair could
// rewrite. Only e1 is ever named by the resolver's response.
async function seedSeries() {
  const series = await seriesSvc.createSeries({
    name: 'Example Series',
    logline: 'A relay station goes dark.',
    premise: 'Long-form premise.',
    issueCountTarget: 2,
  });
  await seriesSvc.updateSeries(series.id, { arc: { logline: 'original logline', summary: 'original summary' } });
  const volume = await seasonsSvc.createSeason(series.id, { title: 'Volume 1', episodeCountTarget: 2 });
  const e1 = await issuesSvc.createIssue({ seriesId: series.id, seasonId: volume.id, title: 'Ep 1' });
  const e2 = await issuesSvc.createIssue({ seriesId: series.id, seasonId: volume.id, title: 'Ep 2' });
  await issuesSvc.updateStage(e1.id, 'idea', { input: 'e1 planning synopsis', status: 'empty' });
  await issuesSvc.updateStage(e2.id, 'idea', { input: 'e2 planning synopsis', status: 'empty' });
  return { series, volume, e1: await issuesSvc.getIssue(e1.id), e2: await issuesSvc.getIssue(e2.id) };
}

// A resolve response that rewrites the arc logline and e1's synopsis, and names
// nothing else. `synopsis` varies per pass so each pass's write is identifiable.
const resolveResponse = ({ volume, e1, logline, synopsis }) => ({
  content: {
    arc: { logline, summary: 'rewritten summary', themes: [], protagonistArc: '' },
    seasons: [],
    episodes: [{ seasonNumber: volume.number, episodeNumber: e1.number, synopsis }],
    notes: '',
  },
  runId: 'r', providerId: 'p', model: 'm',
});

const ideaInput = async (id) => (await issuesSvc.getIssue(id)).stages.idea.input;

describe('applyFoundationFix — structure repair restores only what it wrote', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
    vi.mocked(arcPlanner.verifyArc).mockReset();
  });

  it('keeps a write that landed mid-verification when the whole repair is reverted', async () => {
    const { series, volume, e1, e2 } = await seedSeries();
    let pass = 0;
    stageRunnerSpy = vi.fn(async () => {
      pass += 1;
      return resolveResponse({ volume, e1, logline: `rewritten logline ${pass}`, synopsis: `resolver rewrote e1 (${pass})` });
    });
    // Never improves, so the repair spends its cap and reverts to the pre-repair
    // plan. The first verification is where the foreign write lands — from
    // outside this repair, on an episode the resolver never named.
    let verifies = 0;
    vi.mocked(arcPlanner.verifyArc).mockImplementation(async () => {
      verifies += 1;
      if (verifies === 1) await issuesSvc.updateStage(e2.id, 'idea', { input: 'edited elsewhere mid-verify' });
      return { issues: blockers(1, 'still blocked') };
    });

    const r = await applyFoundationFix(series.id, 'structure', { finding: REPAIR_FINDING });

    expect(r).toMatchObject({ dimension: 'structure', applied: false, reverted: true });
    // The repair's own writes are gone…
    expect((await seriesSvc.getSeries(series.id)).arc.logline).toBe('original logline');
    expect(await ideaInput(e1.id)).toBe('e1 planning synopsis');
    // …and the write it never made is still standing. This is the regression:
    // without a manifest the rollback reverted e2 to 'e2 planning synopsis'.
    expect(await ideaInput(e2.id)).toBe('edited elsewhere mid-verify');
  });

  it('undoes only the passes after its best checkpoint when it retains a partial improvement', async () => {
    const { series, volume, e1, e2 } = await seedSeries();
    let pass = 0;
    stageRunnerSpy = vi.fn(async () => {
      pass += 1;
      return resolveResponse({ volume, e1, logline: `rewritten logline ${pass}`, synopsis: `resolver rewrote e1 (${pass})` });
    });
    // 9 blockers → 1 (the checkpoint worth keeping) → 5 (regressed, rewound).
    // The foreign write lands during the LAST verification, i.e. after the kept
    // checkpoint was captured — so a manifest-free rewind would undo it.
    let verifies = 0;
    vi.mocked(arcPlanner.verifyArc).mockImplementation(async () => {
      verifies += 1;
      if (verifies === 1) return { issues: blockers(9, 'initial') };
      if (verifies === 2) return { issues: blockers(1, 'best') };
      await issuesSvc.updateStage(e2.id, 'idea', { input: 'edited elsewhere mid-verify' });
      return { issues: blockers(5, 'regressed') };
    });

    const r = await applyFoundationFix(series.id, 'structure', { finding: REPAIR_FINDING });

    expect(r).toMatchObject({ dimension: 'structure', applied: true, partial: true });
    // The rewind undid the third pass only, so the retained second pass's arc
    // and synopsis rewrites both survive…
    expect((await seriesSvc.getSeries(series.id)).arc.logline).toBe('rewritten logline 2');
    expect(await ideaInput(e1.id)).toBe('resolver rewrote e1 (2)');
    // …as does the write that was never this repair's to revert.
    expect(await ideaInput(e2.id)).toBe('edited elsewhere mid-verify');
  });
});
