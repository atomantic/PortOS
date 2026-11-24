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

// Shared by every commitSeasonsWithRemap case below — they all commit a fresh
// draft arc and vary only the seasons.
const DRAFT_ARC = Object.freeze({ logline: 'L', summary: '', themes: [], protagonistArc: '', shape: null, status: 'draft' });

describe('arcPlanner — commitSeasonsWithRemap', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('remaps child issues onto title-matched replacement seasons (the regenerate-arc path)', async () => {
    const s = await setupSeries();
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'The Velvet Pouch', episodeCountTarget: 3 });
    const oldS2 = await seasonsSvc.createSeason(s.id, { title: 'Six Blocks Down', episodeCountTarget: 3 });

    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Pilot' });
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS2.id, title: 'Middle' });

    const cur = await seriesSvc.getSeries(s.id);
    const freshSeasons = [
      // Same titles, brand-new ids — exactly what shapeSeasonOutlines emits.
      { id: 'sea-fresh-1', number: 1, title: 'The Velvet Pouch', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3, themes: [] },
      { id: 'sea-fresh-2', number: 2, title: 'Six Blocks Down', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3, themes: [] },
    ];
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      seasons: freshSeasons,
    });

    expect(out.reassignedIssueCount).toBe(2);
    expect(out.series.seasons.map((s) => s.id)).toEqual(['sea-fresh-1', 'sea-fresh-2']);

    const finalI1 = await issuesSvc.getIssue(i1.id);
    const finalI2 = await issuesSvc.getIssue(i2.id);
    expect(finalI1.seasonId).toBe('sea-fresh-1');
    expect(finalI2.seasonId).toBe('sea-fresh-2');
  });

  it('does nothing to issues when seasons[] preserves existing ids', async () => {
    const s = await setupSeries();
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'Keep me', episodeCountTarget: 3 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Pilot' });

    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      seasons: [{ ...oldS1, logline: 'updated' }],
    });
    expect(out.reassignedIssueCount).toBe(0);
    const finalI1 = await issuesSvc.getIssue(i1.id);
    expect(finalI1.seasonId).toBe(oldS1.id);
  });

  it('drops orphans to null when no remap target exists (collapsed seasons)', async () => {
    const s = await setupSeries();
    const oldS1 = await seasonsSvc.createSeason(s.id, { title: 'Only', episodeCountTarget: 3 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: oldS1.id, title: 'Orphan' });

    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      seasons: [],
    });
    expect(out.reassignedIssueCount).toBe(1);
    const finalI1 = await issuesSvc.getIssue(i1.id);
    expect(finalI1.seasonId).toBeNull();
  });

  it('preserves locked arc fields when commit rewrites the arc', async () => {
    const s = await setupSeries({
      arc: {
        logline: 'KEEP THIS LOGLINE',
        summary: 'rewrite the summary',
        themes: ['keep', 'these'],
        protagonistArc: 'rewrite the pa',
        shape: 'rags-to-riches',
        status: 'draft',
      },
      locked: { arcFields: { logline: true, themes: true } },
    });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: {
        logline: 'NEW LOGLINE (should be ignored)',
        summary: 'a fresh summary',
        themes: ['fresh', 'replaced'],
        protagonistArc: 'a fresh pa',
        shape: 'icarus',
        status: 'draft',
      },
      seasons: [],
    });
    // Locked fields preserved verbatim from the existing arc.
    expect(out.series.arc.logline).toBe('KEEP THIS LOGLINE');
    expect(out.series.arc.themes).toEqual(['keep', 'these']);
    // Unlocked fields took the new value.
    expect(out.series.arc.summary).toBe('a fresh summary');
    expect(out.series.arc.protagonistArc).toBe('a fresh pa');
    expect(out.series.arc.shape).toBe('icarus');
  });

  it('honors arc field locks toggled after the caller snapshot was read', async () => {
    const s = await setupSeries({
      arc: {
        logline: 'original logline',
        summary: 'original summary',
        themes: [],
        protagonistArc: '',
        shape: null,
        status: 'draft',
      },
    });
    const stale = await seriesSvc.getSeries(s.id);
    await seriesSvc.updateSeries(s.id, {
      arc: { ...stale.arc, logline: 'latest locked logline' },
      locked: { arcFields: { logline: true } },
    });
    const out = await planner.commitSeasonsWithRemap(stale, {
      arc: {
        ...stale.arc,
        logline: 'incoming overwrite',
        summary: 'incoming summary',
      },
      seasons: [],
    });
    expect(out.series.arc.logline).toBe('latest locked logline');
    expect(out.series.arc.summary).toBe('incoming summary');
  });

  it('self-heals a pre-existing duplicate volume number and keeps its episodes attached', async () => {
    const s = await setupSeries();
    const keep = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Salt at the Root', episodeCountTarget: 12 });
    const dupe = await seasonsSvc.createSeason(s.id, { number: 1, title: 'Salt at the Root', episodeCountTarget: 12 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: keep.id, title: 'Ep 1' });
    // An episode stranded under the duplicate must follow the survivor, not
    // fall into the ungrouped bucket.
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: dupe.id, title: 'Stranded' });

    const cur = await seriesSvc.getSeries(s.id);
    expect(cur.seasons).toHaveLength(2);

    // A perfectly ordinary arc write — the heal rides along with it.
    const out = await planner.commitSeasonsWithRemap(
      cur,
      { arc: DRAFT_ARC, seasons: cur.seasons },
      { preserveDroppedSeasons: true },
    );

    expect(out.series.seasons).toHaveLength(1);
    expect(out.series.seasons[0].id).toBe(keep.id);
    expect((await issuesSvc.getIssue(i1.id)).seasonId).toBe(keep.id);
    expect((await issuesSvc.getIssue(i2.id)).seasonId).toBe(keep.id);
  });
});

describe('arcPlanner — mergeSeasonsWithLocks', () => {
  it('replaces an LLM-proposed season with the existing locked record when ids match', () => {
    const current = [
      { id: 'sea-a', number: 1, title: 'Locked Title', logline: 'locked log', locked: true },
      { id: 'sea-b', number: 2, title: 'Unlocked', logline: 'old log', locked: false },
    ];
    const next = [
      { id: 'sea-a', number: 1, title: 'LLM rewrite', logline: 'LLM log' },
      { id: 'sea-b', number: 2, title: 'Unlocked rewritten', logline: 'new log' },
    ];
    const merged = planner.__testing.mergeSeasonsWithLocks(current, next);
    expect(merged[0]).toBe(current[0]);
    expect(merged[0].title).toBe('Locked Title');
    expect(merged[1].title).toBe('Unlocked rewritten');
  });

  it('re-inserts a locked season that the LLM dropped from the new shape', () => {
    const current = [
      { id: 'sea-a', number: 1, title: 'Drop me', locked: true },
      { id: 'sea-b', number: 2, title: 'Keep me', locked: false },
    ];
    const next = [
      { id: 'sea-b', number: 2, title: 'Keep me' },
    ];
    const merged = planner.__testing.mergeSeasonsWithLocks(current, next);
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.id === 'sea-a')).toBe(current[0]);
  });

  it('returns next unchanged when no current season is locked', () => {
    const current = [{ id: 'sea-a', number: 1, locked: false }];
    const next = [{ id: 'sea-a', number: 1, title: 'rewrite' }];
    expect(planner.__testing.mergeSeasonsWithLocks(current, next)).toBe(next);
  });

  it('returns next unchanged when currentSeasons is not an array', () => {
    const next = [{ id: 'sea-a', number: 1 }];
    expect(planner.__testing.mergeSeasonsWithLocks(undefined, next)).toBe(next);
    expect(planner.__testing.mergeSeasonsWithLocks(null, next)).toBe(next);
  });

  it('returns nextSeasons untouched when nextSeasons is not an array', () => {
    expect(planner.__testing.mergeSeasonsWithLocks([{ id: 'a', locked: true }], null)).toBeNull();
    expect(planner.__testing.mergeSeasonsWithLocks([{ id: 'a', locked: true }], undefined)).toBeUndefined();
  });
});

describe('arcPlanner — commitSeasonsWithRemap (season locks)', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it('preserves a locked season verbatim when the LLM tries to rewrite its content', async () => {
    const s = await setupSeries();
    const s1 = await seasonsSvc.createSeason(s.id, {
      title: 'Locked Title',
      logline: 'locked logline',
      synopsis: 'locked synopsis',
      episodeCountTarget: 3,
      number: 1,
    });
    await seasonsSvc.updateSeason(s.id, s1.id, { locked: true });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      seasons: [
        // LLM tries to rewrite the locked season's content under the same id.
        { id: s1.id, number: 1, title: 'LLM rewrite', logline: 'LLM logline', synopsis: 'LLM synopsis', endingHook: '', episodeCountTarget: 9, themes: [] },
      ],
    });
    const persisted = out.series.seasons.find((x) => x.id === s1.id);
    expect(persisted.title).toBe('Locked Title');
    expect(persisted.logline).toBe('locked logline');
    expect(persisted.synopsis).toBe('locked synopsis');
    expect(persisted.episodeCountTarget).toBe(3);
    expect(persisted.locked).toBe(true);
  });

  it('re-inserts a locked season the LLM dropped, with no issue reassignment', async () => {
    const s = await setupSeries();
    const s1 = await seasonsSvc.createSeason(s.id, { title: 'Locked', episodeCountTarget: 3, number: 1 });
    await seasonsSvc.updateSeason(s.id, s1.id, { locked: true });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: s1.id, title: 'Pilot' });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      // LLM proposed dropping the locked season entirely.
      seasons: [],
    });
    expect(out.series.seasons.map((x) => x.id)).toContain(s1.id);
    expect(out.reassignedIssueCount).toBe(0);
    const finalI1 = await issuesSvc.getIssue(i1.id);
    expect(finalI1.seasonId).toBe(s1.id);
  });

  it('still rewrites unlocked sibling seasons while preserving the locked one', async () => {
    const s = await setupSeries();
    const locked = await seasonsSvc.createSeason(s.id, { title: 'Frozen', episodeCountTarget: 4, number: 1 });
    await seasonsSvc.updateSeason(s.id, locked.id, { locked: true });
    const unlocked = await seasonsSvc.createSeason(s.id, { title: 'Editable', episodeCountTarget: 4, number: 2 });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      seasons: [
        { id: locked.id, number: 1, title: 'LLM rewrite of frozen', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 1, themes: [] },
        { id: unlocked.id, number: 2, title: 'Editable v2', logline: 'updated', synopsis: '', endingHook: '', episodeCountTarget: 5, themes: [] },
      ],
    });
    const frozenAfter = out.series.seasons.find((x) => x.id === locked.id);
    const editableAfter = out.series.seasons.find((x) => x.id === unlocked.id);
    expect(frozenAfter.title).toBe('Frozen');
    expect(frozenAfter.locked).toBe(true);
    expect(editableAfter.title).toBe('Editable v2');
    expect(editableAfter.episodeCountTarget).toBe(5);
  });

  // `preserveDroppedSeasons` — the autopilot's unlock-for-run mode clears the
  // per-season locks above, so this is what keeps a rewrite from DELETING a
  // volume once they're gone.
  it('keeps an UNLOCKED season the rewrite dropped, and still applies rewrites to survivors', async () => {
    const s = await setupSeries();
    const dropped = await seasonsSvc.createSeason(s.id, { title: 'Would vanish', episodeCountTarget: 3, number: 1 });
    const kept = await seasonsSvc.createSeason(s.id, { title: 'Old title', episodeCountTarget: 3, number: 2 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: dropped.id, title: 'Pilot' });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, {
      arc: DRAFT_ARC,
      seasons: [{ id: kept.id, number: 2, title: 'New title', logline: '', synopsis: '', endingHook: '', episodeCountTarget: 4, themes: [] }],
    }, { preserveDroppedSeasons: true });
    expect(out.series.seasons.map((x) => x.id)).toContain(dropped.id);
    expect(out.series.seasons.find((x) => x.id === kept.id).title).toBe('New title');
    // The dropped volume's issue stays attached — nothing was reassigned away.
    expect(await issuesSvc.getIssue(i1.id).then((i) => i.seasonId)).toBe(dropped.id);
  });

  // Regression: preserved records must survive `sanitizeSeasonList`'s
  // first-N cap. Appending them meant a rewrite returning a full cap's worth of
  // brand-new volumes pushed every existing volume past the cap, the sanitizer
  // dropped them, and the remap then reassigned their issues — the exact
  // deletion `preserveDroppedSeasons` exists to refuse.
  it('keeps existing volumes when the rewrite returns a full cap of brand-new ones', async () => {
    const s = await setupSeries();
    const existing = await seasonsSvc.createSeason(s.id, { title: 'Must survive', episodeCountTarget: 3, number: 1 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: existing.id, title: 'Pilot' });
    const cur = await seriesSvc.getSeries(s.id);
    // SEASONS_PER_SERIES_MAX brand-new volumes, none reusing the existing id.
    const flood = Array.from({ length: 50 }, (_, i) => ({
      id: `sea-new-${i}`, number: i + 10, title: `New ${i}`,
      logline: '', synopsis: '', endingHook: '', episodeCountTarget: 3, themes: [],
    }));
    const out = await planner.commitSeasonsWithRemap(cur, { arc: DRAFT_ARC, seasons: flood }, { preserveDroppedSeasons: true });
    expect(out.series.seasons.map((x) => x.id)).toContain(existing.id);
    // Its issue was never reassigned to a surviving volume.
    expect(await issuesSvc.getIssue(i1.id).then((i) => i.seasonId)).toBe(existing.id);
  });

  it('still drops an unlocked season when the flag is off (default behavior unchanged)', async () => {
    const s = await setupSeries();
    const dropped = await seasonsSvc.createSeason(s.id, { title: 'Would vanish', episodeCountTarget: 3, number: 1 });
    const cur = await seriesSvc.getSeries(s.id);
    const out = await planner.commitSeasonsWithRemap(cur, { arc: DRAFT_ARC, seasons: [] });
    expect(out.series.seasons.map((x) => x.id)).not.toContain(dropped.id);
  });
});

// Non-destructive guarantee behind the autopilot's unlock-for-run mode: once
// that pass clears the per-season locks, nothing else stops an LLM-proposed arc
// from deleting a volume — so the commit re-inserts dropped records while still
// applying content rewrites to the ones that survived.
describe('arcPlanner — preserveDroppedSeasonRecords', () => {
  const { preserveDroppedSeasonRecords } = planner.__testing;

  it('re-appends a dropped season without freezing the ones that survived', () => {
    const current = [{ id: 'sea-a', number: 1, title: 'Drop me' }, { id: 'sea-b', number: 2, title: 'Old' }];
    const next = [{ id: 'sea-b', number: 2, title: 'Rewritten' }];
    const merged = preserveDroppedSeasonRecords(current, next);
    expect(merged).toHaveLength(2);
    expect(merged.find((s) => s.id === 'sea-b').title).toBe('Rewritten');
    expect(merged.find((s) => s.id === 'sea-a')).toBe(current[0]);
  });

  it('returns next untouched when nothing was dropped', () => {
    const current = [{ id: 'sea-a', number: 1 }];
    const next = [{ id: 'sea-a', number: 1, title: 'x' }];
    expect(preserveDroppedSeasonRecords(current, next)).toBe(next);
  });

  it('is a no-op for a missing/empty current list or a non-array next', () => {
    const next = [{ id: 'a' }];
    expect(preserveDroppedSeasonRecords([], next)).toBe(next);
    expect(preserveDroppedSeasonRecords(null, next)).toBe(next);
    expect(preserveDroppedSeasonRecords([{ id: 'a' }], null)).toBeNull();
  });
});

// The duplicate-volume divergence (2026-08-09): auto-resolve returned a
// rewritten Volume 1 without echoing its id, `preserveDroppedSeasons` re-inserted
// the original alongside the mint, and arc-verify filed "three records numbered
// 1" as a blocking finding — one MORE finding than the round started with, every
// round, until the autopilot paused for no net progress.
describe('arcPlanner — matchProposedSeasons', () => {
  const { matchProposedSeasons } = planner.__testing;
  const existing = [
    { id: 'sea-a', number: 1, title: 'Salt at the Root' },
    { id: 'sea-b', number: 2, title: 'Six Blocks Down' },
  ];

  it('matches an id-less rewrite to the existing record by title', () => {
    const matched = matchProposedSeasons(existing, [
      { number: 1, title: 'salt at the ROOT  ', synopsis: 'rewritten' },
    ]);
    expect(matched[0]).toBe(existing[0]);
  });

  it('matches by number when the title was rewritten too', () => {
    const matched = matchProposedSeasons(existing, [{ number: 2, title: 'A New Name' }]);
    expect(matched[0]).toBe(existing[1]);
  });

  it('lets an id-carrying proposal win its own record over a same-titled sibling', () => {
    // Greedy single-pass matching would let the title-only proposal claim
    // sea-a first, forcing the id-carrying one to mint a duplicate.
    const matched = matchProposedSeasons(existing, [
      { number: 1, title: 'Salt at the Root' },
      { id: 'sea-a', number: 1, title: 'Salt at the Root' },
    ]);
    expect(matched[1]).toBe(existing[0]);
    expect(matched[0]).toBeNull();
  });

  it('leaves a genuinely new volume unmatched so it mints', () => {
    expect(matchProposedSeasons(existing, [{ number: 3, title: 'Brand New' }])).toEqual([null]);
  });

  it('refuses an ambiguous number match', () => {
    const dupes = [
      { id: 'sea-a', number: 1, title: 'One' },
      { id: 'sea-b', number: 1, title: 'Two' },
    ];
    expect(matchProposedSeasons(dupes, [{ number: 1, title: 'Neither' }])).toEqual([null]);
  });

  it('tolerates missing/empty inputs', () => {
    expect(matchProposedSeasons(null, [{ number: 1 }])).toEqual([null]);
    expect(matchProposedSeasons(existing, null)).toEqual([]);
  });
});

describe('arcPlanner — collapseDuplicateSeasonNumbers', () => {
  const { collapseDuplicateSeasonNumbers, hasDuplicateSeasonNumbers } = planner.__testing;

  it('detects duplicate numbers', () => {
    expect(hasDuplicateSeasonNumbers([{ number: 1 }, { number: 2 }])).toBe(false);
    expect(hasDuplicateSeasonNumbers([{ number: 1 }, { number: 1 }])).toBe(true);
    expect(hasDuplicateSeasonNumbers(null)).toBe(false);
  });

  it('keeps the record holding the episodes and reports the absorbed ids', () => {
    // The live shape: the original carries the 12 episodes, the two mints are
    // newer and empty.
    const seasons = [
      { id: 'sea-orig', number: 1, title: 'V1', createdAt: '2026-05-11T00:00:00.000Z', updatedAt: '2026-05-11T00:00:00.000Z', synopsis: 'original', themes: ['t'] },
      { id: 'sea-dup1', number: 1, title: 'V1', createdAt: '2026-08-09T14:25:00.000Z', updatedAt: '2026-08-09T14:25:00.000Z', synopsis: 'rev a', themes: [] },
      { id: 'sea-dup2', number: 1, title: 'V1', createdAt: '2026-08-09T14:30:00.000Z', updatedAt: '2026-08-09T14:30:00.000Z', synopsis: 'rev b', themes: [] },
    ];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(
      seasons,
      new Map([['sea-orig', 12]]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('sea-orig');
    expect(out[0].synopsis).toBe('original'); // never clobbered by a duplicate
    expect([...absorbed]).toEqual([['sea-dup1', 'sea-orig'], ['sea-dup2', 'sea-orig']]);
  });

  it('back-fills only fields the survivor left empty, newest duplicate first', () => {
    const seasons = [
      { id: 'sea-orig', number: 1, title: 'V1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', synopsis: '', endingHook: 'keep me', themes: [] },
      { id: 'sea-old', number: 1, title: 'V1', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', synopsis: 'stale', endingHook: 'drop me', themes: ['old'] },
      { id: 'sea-new', number: 1, title: 'V1', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z', synopsis: 'freshest', endingHook: 'drop me too', themes: ['new'] },
    ];
    const { seasons: out } = collapseDuplicateSeasonNumbers(seasons, new Map([['sea-orig', 3]]));
    expect(out[0].id).toBe('sea-orig');
    expect(out[0].synopsis).toBe('freshest');
    expect(out[0].endingHook).toBe('keep me');
    expect(out[0].themes).toEqual(['new']);
  });

  it('prefers a locked record over a better-populated unlocked one', () => {
    const seasons = [
      { id: 'sea-loose', number: 1, title: 'V1', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'sea-locked', number: 1, title: 'V1', locked: true, createdAt: '2026-02-01T00:00:00.000Z' },
    ];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(seasons, new Map([['sea-loose', 9]]));
    expect(out[0].id).toBe('sea-locked');
    expect(absorbed.get('sea-loose')).toBe('sea-locked');
  });

  it('leaves a group with two locked records intact rather than deleting a frozen volume', () => {
    const seasons = [
      { id: 'sea-l1', number: 1, title: 'V1', locked: true },
      { id: 'sea-l2', number: 1, title: 'V1', locked: true },
    ];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(seasons, new Map());
    expect(out).toHaveLength(2);
    expect(absorbed.size).toBe(0);
  });

  it('leaves a clean list untouched and keeps number ordering', () => {
    const seasons = [{ id: 'b', number: 2 }, { id: 'a', number: 1 }];
    const { seasons: out, absorbed } = collapseDuplicateSeasonNumbers(seasons, new Map());
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
    expect(absorbed.size).toBe(0);
  });
});

describe('arcPlanner — mergeArcWithLocks', () => {
  it('replaces locked fields with the current arc values', () => {
    const current = { logline: 'a', summary: 'b', themes: ['t1'], protagonistArc: 'c', shape: 's1' };
    const next = { logline: 'A', summary: 'B', themes: ['t2'], protagonistArc: 'C', shape: 's2' };
    const merged = planner.__testing.mergeArcWithLocks(current, next, { logline: true, themes: true });
    expect(merged.logline).toBe('a');
    expect(merged.themes).toEqual(['t1']);
    expect(merged.summary).toBe('B');
    expect(merged.shape).toBe('s2');
  });

  it('returns next unchanged when lockedFields is empty / absent', () => {
    const current = { logline: 'a' };
    const next = { logline: 'A' };
    expect(planner.__testing.mergeArcWithLocks(current, next, {})).toEqual({ logline: 'A' });
    expect(planner.__testing.mergeArcWithLocks(current, next, null)).toEqual({ logline: 'A' });
    expect(planner.__testing.mergeArcWithLocks(current, next, undefined)).toEqual({ logline: 'A' });
  });

  it('passes next through when there is no current arc to preserve from', () => {
    const next = { logline: 'A' };
    expect(planner.__testing.mergeArcWithLocks(null, next, { logline: true })).toEqual({ logline: 'A' });
  });

  it('returns next when next is null/undefined (no-op)', () => {
    expect(planner.__testing.mergeArcWithLocks({ logline: 'a' }, null, { logline: true })).toBeNull();
    expect(planner.__testing.mergeArcWithLocks({ logline: 'a' }, undefined, { logline: true })).toBeUndefined();
  });

  it('ignores unknown lock keys (only ARC_LOCKABLE_FIELDS are honored)', () => {
    const current = { logline: 'a', summary: 'b' };
    const next = { logline: 'A', summary: 'B' };
    const merged = planner.__testing.mergeArcWithLocks(current, next, { logline: true, bogusKey: true });
    expect(merged.logline).toBe('a');
    expect(merged.summary).toBe('B');
    // bogusKey didn't survive into the merged shape.
    expect(merged.bogusKey).toBeUndefined();
  });
});

describe('arcPlanner — buildSeasonRemap', () => {
  it('matches by normalized title first', () => {
    const dropped = [{ id: 'old1', number: 1, title: 'The Velvet Pouch' }];
    const minted = [{ id: 'new1', number: 1, title: '  THE VELVET POUCH  ' }];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new1');
  });

  it('falls back to unique number match', () => {
    const dropped = [{ id: 'old1', number: 2, title: 'Renamed' }];
    const minted = [
      { id: 'new1', number: 1, title: 'Different' },
      { id: 'new2', number: 2, title: 'Also Different' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new2');
  });

  it('pairs 2-old × 2-new entirely via unique-number when titles diverge but numbers match', () => {
    // Pre-tightening this case used to flow through Pass 3 (positional fallback);
    // now Pass 2 handles it because the numbers 1↔1 and 2↔2 are each unique.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [
      { id: 'old1', number: 1, title: 'A' },
      { id: 'old2', number: 2, title: 'B' },
    ];
    const minted = [
      { id: 'new1', number: 1, title: 'X' },
      { id: 'new2', number: 2, title: 'Y' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new1');
    expect(remap.get('old2')).toBe('new2');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('falls back positionally when exactly one unmatched on each side (forced 1↔1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [{ id: 'old1', number: 1, title: 'A' }];
    const minted = [{ id: 'new1', number: 2, title: 'X' }];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBe('new1');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Pass 3 fired'),
    );
    warnSpy.mockRestore();
  });

  it('sanitizes multi-line / control-char titles in the Pass 3 warning to keep logging single-line', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [{ id: 'old1', number: 1, title: 'A\n\tWith newline' }];
    const minted = [{ id: 'new1', number: 2, title: '' }];
    planner.buildSeasonRemap(dropped, minted);
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).not.toMatch(/\n/);
    expect(msg).toContain('A With newline');
    expect(msg).toContain('new1'); // empty title → falls back to id
    warnSpy.mockRestore();
  });

  it('strips C0/C1 control chars and full ANSI CSI sequences from titles before logging', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped = [{ id: 'old1', number: 1, title: 'Pre\x1b[31mEvil\x1b[0mSuffix\x07' }];
    const minted = [{ id: 'new1', number: 2, title: 'Clean\u0085Title' }]; // U+0085 = NEL (C1)
    planner.buildSeasonRemap(dropped, minted);
    const msg = warnSpy.mock.calls[0][0];
    expect(msg).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
    // stripAnsi removes the full CSI sequences (ESC + '[31m' / ESC + '[0m'),
    // not just the ESC byte — so the '[31m' / '[0m' payload tails do NOT leak.
    expect(msg).toContain('PreEvilSuffix');
    expect(msg).not.toMatch(/\[31m|\[0m/);
    expect(msg).toContain('Clean Title');
    warnSpy.mockRestore();
  });

  it('drops orphans to null when 2+ unmatched on each side after pass 1/2', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Titles diverge AND numbers diverge → Pass 1 (title) and Pass 2 (unique
    // number) leave 2-old × 2-new unmatched. Old behavior would positionally
    // pair them; new behavior refuses and warns.
    const dropped = [
      { id: 'old1', number: 10, title: 'A' },
      { id: 'old2', number: 20, title: 'B' },
    ];
    const minted = [
      { id: 'new1', number: 1, title: 'X' },
      { id: 'new2', number: 2, title: 'Y' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBeNull();
    expect(remap.get('old2')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('skipped positional fallback'),
    );
    warnSpy.mockRestore();
  });

  it('maps to null when nothing plausible exists', () => {
    const dropped = [{ id: 'old1', number: 1, title: 'A' }];
    const minted = [];
    const remap = planner.buildSeasonRemap(dropped, minted);
    expect(remap.get('old1')).toBeNull();
  });

  it('claims each minted season only once', () => {
    const dropped = [
      { id: 'old1', number: 1, title: 'Same' },
      { id: 'old2', number: 2, title: 'Same' },
    ];
    const minted = [
      { id: 'new1', number: 1, title: 'Same' },
    ];
    const remap = planner.buildSeasonRemap(dropped, minted);
    // First old gets the title match; second has no remaining mint.
    expect(remap.get('old1')).toBe('new1');
    expect(remap.get('old2')).toBeNull();
  });
});
