import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;
let stageContextSpy;

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
  // Large window by default so completeness runs as a single call (mode:
  // 'whole'); a test can set `stageContextSpy` to force a small window.
  resolveStageContext: vi.fn((...args) => (stageContextSpy
    ? stageContextSpy(...args)
    : Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 }))),
}));

const issuesSvc = await import('./issues.js');
const seasonsSvc = await import('./seasons.js');
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

describe('arcPlanner — manuscript completeness + derive-from-manuscript', () => {
  it('fingerprints manuscript completeness context canonically and includes narrative references', () => {
    const initial = {
      manuscript: 'A short draft.',
      series: { premise: 'An alliance must hold.', name: 'Example' },
      arc: { summary: 'The alliance survives.' },
      existingCharactersJson: '[{"name":"Ari"}]',
    };
    const reordered = {
      existingCharactersJson: '[{"name":"Ari"}]',
      arc: { summary: 'The alliance survives.' },
      series: { name: 'Example', premise: 'An alliance must hold.' },
      manuscript: 'A short draft.',
    };

    expect(planner.completenessSourceHash(reordered)).toBe(planner.completenessSourceHash(initial));
    expect(planner.completenessSourceHash({
      ...initial,
      arc: { summary: 'The alliance shatters.' },
    })).not.toBe(planner.completenessSourceHash(initial));
  });

  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
    stageContextSpy = undefined;
  });

  it('issueSynopsisFromSeason joins logline + synopsis (and is empty for nothing)', () => {
    const { issueSynopsisFromSeason } = planner.__testing;
    expect(issueSynopsisFromSeason({ logline: 'A', synopsis: 'B' })).toBe('A\n\nB');
    expect(issueSynopsisFromSeason({ logline: 'A', synopsis: '' })).toBe('A');
    expect(issueSynopsisFromSeason(null)).toBe('');
    expect(issueSynopsisFromSeason({})).toBe('');
  });

  it('shapeCompletenessFindings coerces category/severity and drops empty problems', () => {
    const { shapeCompletenessFindings } = planner.__testing;
    const out = shapeCompletenessFindings([
      { severity: 'high', category: 'missing-content', problem: 'no climax', suggestion: 'add one' },
      { severity: 'bogus', category: 'invented-category', problem: 'thin cast' },
      { problem: '   ' }, // dropped — empty after trim
      { category: 'pacing', problem: 'rushed' }, // default severity medium
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ severity: 'high', category: 'missing-content' });
    expect(out[1]).toMatchObject({ severity: 'medium', category: 'other' }); // both coerced
    expect(out[2]).toMatchObject({ severity: 'medium', category: 'pacing' });
  });

  it('shapeCompletenessFindings sets replacementStrategy (full-page for comic-structure, delta otherwise; trusts a valid explicit value)', () => {
    const { shapeCompletenessFindings } = planner.__testing;
    const out = shapeCompletenessFindings([
      { category: 'comic-structure', problem: 'page is prose', suggestion: 'Panel 1 …' },
      { category: 'missing-content', problem: 'no climax', suggestion: 'add one' },
      // explicit strategy wins when valid …
      { category: 'pacing', problem: 'rushed', replacementStrategy: 'full-page' },
      // … and an invalid one falls back to the category default.
      { category: 'comic-structure', problem: 'another page', replacementStrategy: 'bogus' },
    ]);
    expect(out[0].replacementStrategy).toBe('full-page'); // derived from category
    expect(out[1].replacementStrategy).toBe('delta'); // narrative default
    expect(out[2].replacementStrategy).toBe('full-page'); // explicit, valid
    expect(out[3].replacementStrategy).toBe('full-page'); // invalid → category default
  });

  it('shapeCompletenessFindings reads `replace` only in the with-edits pass (trimmed; absent → no key)', () => {
    const { shapeCompletenessFindings } = planner.__testing;
    const raw = [
      { category: 'missing-content', problem: 'abrupt', anchorQuote: 'She left.', replace: '  She left, but paused.  ' },
      { category: 'pacing', problem: 'no replace', anchorQuote: 'q' }, // model omitted replace
    ];
    // Findings-only pass ignores `replace` entirely.
    const findingsOnly = shapeCompletenessFindings(raw);
    expect(findingsOnly[0]).not.toHaveProperty('replace');
    // With-edits pass carries a trimmed `replace`; an absent one yields no key.
    const withEdits = shapeCompletenessFindings(raw, { withEdits: true });
    expect(withEdits[0].replace).toBe('She left, but paused.');
    expect(withEdits[1]).not.toHaveProperty('replace');
  });

  it('analyzeManuscriptCompleteness passes withEdits into the prompt ctx and shapes replace', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: 'The hero walked in. She left.', status: 'ready' } } });
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      expect(ctx.withEdits).toBe(true);
      return {
        content: { issues: [{ severity: 'high', category: 'arc-gap', issueNumber: 1, anchorQuote: 'She left.', problem: 'abrupt', suggestion: 'add a beat', replace: 'She left, but paused.' }] },
        runId: 'rc', providerId: 'p', model: 'm',
      };
    });
    const out = await planner.analyzeManuscriptCompleteness(s.id, { withEdits: true });
    expect(out.issues[0].replace).toBe('She left, but paused.');
    expect(out.issues[0].sourceContentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('analyzeManuscriptCompleteness defaults withEdits false (ctx.withEdits=false, no replace shaped)', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: 'A short draft.', status: 'ready' } } });
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      expect(ctx.withEdits).toBe(false);
      return { content: { issues: [{ severity: 'low', category: 'pacing', problem: 'thin', replace: 'ignored' }] }, runId: 'rc', providerId: 'p', model: 'm' };
    });
    const out = await planner.analyzeManuscriptCompleteness(s.id);
    expect(out.issues[0]).not.toHaveProperty('replace');
  });

  it('capCanonReference caps combined canon size, trimming the largest block first', () => {
    const blocks = {
      objects: 'O'.repeat(10_000),
      characters: 'C'.repeat(4_000),
      places: 'P'.repeat(500),
    };
    const trimmed = planner.capCanonReference(blocks, 6_000);
    expect(trimmed).toBe(true);
    const total = Object.values(blocks).reduce((n, v) => n + v.length, 0);
    // Within budget (a small trim-marker allowance per cut block).
    expect(total).toBeLessThanOrEqual(6_200);
    // The smallest block survives untouched; the largest absorbed the cut.
    expect(blocks.places).toBe('P'.repeat(500));
    expect(blocks.objects.length).toBeLessThan(10_000);
  });

  it('capCanonReference is a no-op when already within budget', () => {
    const blocks = { a: 'x'.repeat(100), b: 'y'.repeat(100) };
    expect(planner.capCanonReference(blocks, 10_000)).toBe(false);
    expect(blocks.a).toBe('x'.repeat(100));
  });

  it('never feeds the LLM an empty manuscript on a constrained window (canon cannot starve the draft)', async () => {
    // Regression: an oversized canon/world context used to collapse usableChars
    // to 0 and slice the manuscript to '', so the model "reviewed" an empty
    // draft and reported the whole book missing. The canon cap + manuscript
    // floor must keep real script text in every chunk.
    const s = await setupSeries();
    const script = 'PAGE 1\nPANEL 1\nThe foundry hums. '.repeat(400); // ~13K chars of real script
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Act 1', arcPosition: 1, stages: { comicScript: { output: script, status: 'ready' } } });
    // Force a small planning window so the budgeter must chunk/trim.
    stageContextSpy = vi.fn(async () => ({ provider: { id: 'p' }, model: 'm', contextWindow: 32_768 }));
    const seen = [];
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      seen.push(ctx.manuscript || '');
      return { content: { issues: [] }, runId: 'rc', providerId: 'p', model: 'm' };
    });
    await planner.analyzeManuscriptCompleteness(s.id, { withEdits: true });
    expect(seen.length).toBeGreaterThan(0);
    // Every chunk the model saw must carry real manuscript text — never ''.
    expect(seen.every((m) => m && m.trim().length > 0)).toBe(true);
    expect(seen.some((m) => m.includes('The foundry hums'))).toBe(true);
  });

  it('analyzeManuscriptCompleteness reads the manuscript and returns shaped findings', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({
      seriesId: s.id, title: 'Act 1', arcPosition: 1,
      stages: { comicScript: { output: 'PAGE 1\nGiant counts his gold.', status: 'ready' } },
    });
    stageRunnerSpy = vi.fn(async (template, ctx) => {
      // The pass must see the actual drafted script, not a synopsis.
      expect(template).toBe('pipeline-manuscript-completeness');
      expect(ctx.manuscript).toContain('Giant counts his gold');
      return {
        content: { issues: [{ severity: 'high', category: 'arc-gap', problem: 'no ending', suggestion: 'write one' }] },
        runId: 'rc', providerId: 'p', model: 'm',
      };
    });
    const out = await planner.analyzeManuscriptCompleteness(s.id);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toMatchObject({ category: 'arc-gap', severity: 'high' });
    expect(out.chunked).toBe(false);
  });

  it('chunks a large manuscript that exceeds the model window and merges findings (first-wins dedupe + prior-findings digest)', async () => {
    const s = await setupSeries();
    const big = 'word '.repeat(12_000); // ~60k chars (~15k tokens) per issue
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: `ONE ${big}`, status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Two', arcPosition: 2, stages: { prose: { output: `TWO ${big}`, status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Three', arcPosition: 3, stages: { prose: { output: `THREE ${big}`, status: 'ready' } } });
    stageContextSpy = vi.fn(async () => ({ provider: { id: 'p' }, model: 'm', contextWindow: 40_000 }));
    let n = 0;
    stageRunnerSpy = vi.fn(async () => {
      n += 1;
      return {
        content: { issues: [
          // same finding surfaced by every chunk — must be recorded once
          { severity: 'high', category: 'arc-gap', issueNumber: 1, anchorQuote: 'dup', problem: 'duplicated finding', suggestion: 'x' },
          { severity: 'low', category: 'pacing', problem: `unique ${n}`, suggestion: '' },
        ] },
        runId: `r${n}`, providerId: 'p', model: 'm',
      };
    });

    const out = await planner.analyzeManuscriptCompleteness(s.id);

    expect(out.chunked).toBe(true);
    expect(out.chunkCount).toBeGreaterThanOrEqual(2);
    expect(stageRunnerSpy).toHaveBeenCalledTimes(out.chunkCount);
    // duplicate finding collapsed to one; each chunk's unique finding kept
    expect(out.issues.filter((f) => f.anchorQuote === 'dup')).toHaveLength(1);
    expect(out.issues.filter((f) => f.problem.startsWith('unique'))).toHaveLength(out.chunkCount);
    // later chunks get a digest of earlier findings inside the manuscript field
    const secondManuscript = stageRunnerSpy.mock.calls[1][1].manuscript;
    expect(secondManuscript).toContain('already recorded for EARLIER chapters');
    expect(secondManuscript).toContain('duplicated finding');
  });

  it('analyzeManuscriptCompleteness refuses when no manuscript exists', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Empty', arcPosition: 1 });
    await expect(planner.analyzeManuscriptCompleteness(s.id)).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });

  it('analyzeManuscriptCompleteness treats an idea-only issue as no manuscript (outline is not a draft)', async () => {
    const s = await setupSeries();
    // Only an idea/synopsis seed — no drafted comicScript/prose/teleplay.
    await issuesSvc.createIssue({ seriesId: s.id, title: 'Outline only', arcPosition: 1, stages: { idea: { input: 'a synopsis', status: 'edited' } } });
    await expect(planner.analyzeManuscriptCompleteness(s.id)).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
  });

  it('analyzeManuscriptCompleteness carries issueNumber + anchorQuote and tolerates their absence', async () => {
    const s = await setupSeries();
    await issuesSvc.createIssue({ seriesId: s.id, title: 'One', arcPosition: 1, stages: { prose: { output: 'A short draft.', status: 'ready' } } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { issues: [
        { severity: 'high', category: 'arc-gap', issueNumber: 1, anchorQuote: '  a quote  ', problem: 'anchored', suggestion: 'fix it' },
        { severity: 'low', category: 'pacing', problem: 'unanchored', suggestion: '' },
      ] },
      runId: 'rc', providerId: 'p', model: 'm',
    }));
    const out = await planner.analyzeManuscriptCompleteness(s.id);
    expect(out.issues[0]).toMatchObject({ issueNumber: 1, anchorQuote: 'a quote' });
    expect(out.issues[1]).toMatchObject({ issueNumber: null, anchorQuote: '' });
  });

  it('collects manuscript sections and editor formats in global issue order across volumes', async () => {
    const s = await setupSeries();
    const v1 = await seasonsSvc.createSeason(s.id, { number: 1, title: 'V1' });
    const v2 = await seasonsSvc.createSeason(s.id, { number: 2, title: 'V2' });
    // Creation is shuffled; local position restarts at 1 in the second volume.
    for (const [seasonId, arcPosition, title] of [[v2.id, 1, 'Three'], [v1.id, 2, 'Two'], [v1.id, 1, 'One'], [v2.id, 2, 'Empty']]) {
      await issuesSvc.createIssue({ seriesId: s.id, seasonId, title, arcPosition,
        stages: title === 'Empty' ? {} : { prose: { output: `Draft ${title}`, status: 'ready' } } });
    }
    const sections = await planner.collectManuscriptSections(s.id);
    expect(sections.map((section) => section.title)).toEqual(['One', 'Two', 'Three']);
    expect(sections.map((section) => section.number)).toEqual([1, 2, 3]);
    const formats = await planner.collectManuscriptByType(s.id);
    expect(formats.sectionsByType.prose.map((section) => section.title)).toEqual(['One', 'Two', 'Three', 'Empty']);
    const corpus = await planner.collectIssueSourceText(s.id, { stageOrder: planner.MANUSCRIPT_STAGES });
    expect(corpus).toBe(sections.map((section) => `# Issue ${section.number} — ${section.title} (${section.stageId})\n\n${section.content}`).join('\n\n---\n\n'));
  });

  it('deriveFromManuscript proposes a single volume + bible + zipped issue synopses', async () => {
    const s = await setupSeries();
    const sea = await seasonsSvc.createSeason(s.id, { title: 'V1', episodeCountTarget: 3 });
    await issuesSvc.createIssue({ seriesId: s.id, seasonId: sea.id, title: 'Issue 1', arcPosition: 1, stages: { comicScript: { output: 'PAGE 1\nopening', status: 'ready' } } });
    await issuesSvc.createIssue({ seriesId: s.id, seasonId: sea.id, title: 'Issue 2', arcPosition: 2, stages: { comicScript: { output: 'PAGE 1\nmiddle', status: 'ready' } } });

    stageRunnerSpy = vi.fn(async (template) => {
      expect(template).toBe('importer-arc-extract');
      return {
        content: {
          logline: 'A giant hoards gold.', summary: 'A fairy-tale retold.', themes: ['greed'], protagonistArc: 'arc', shape: null,
          seasons: [
            { number: 1, title: 'The Miracle Man', logline: 'Beanstalk begins', synopsis: 'syn1' },
            { number: 2, title: 'Magic Beans', logline: 'The climb', synopsis: 'syn2' },
          ],
        },
        runId: 'rd', providerId: 'p', model: 'm',
      };
    });

    const out = await planner.deriveFromManuscript(s.id);
    expect(out.bible).toMatchObject({ logline: 'A giant hoards gold.', premise: 'A fairy-tale retold.', issueCountTarget: 2 });
    expect(out.volume.title).toBe('Salt Run'); // defaults to series name
    expect(out.issues).toHaveLength(2);
    expect(out.issues[0].synopsisSuggestion).toContain('Beanstalk begins');
    expect(out.issues[1].synopsisSuggestion).toContain('The climb');
  });

  it('commitDerivedManuscript collapses to one volume, pins all issues, fills bible, seeds synopses, leaves scripts intact', async () => {
    const s = await setupSeries({ logline: '', premise: '', issueCountTarget: 0 });
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', episodeCountTarget: 1 });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'V2', episodeCountTarget: 1 });
    const v3 = await seasonsSvc.createSeason(s.id, { title: 'V3', episodeCountTarget: 1 });
    const v4 = await seasonsSvc.createSeason(s.id, { title: 'V4', episodeCountTarget: 1 });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Issue 1', arcPosition: 1, stages: { comicScript: { output: 'PAGE 1\nverbatim one', status: 'ready' } } });
    const i2 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v2.id, title: 'Issue 2', arcPosition: 2, stages: { comicScript: { output: 'PAGE 1\nverbatim two', status: 'ready' } } });
    const i3 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v3.id, title: 'Issue 3', arcPosition: 3, stages: { comicScript: { output: 'PAGE 1\nverbatim three', status: 'ready' } } });

    const out = await planner.commitDerivedManuscript(s.id, {
      arc: { logline: 'LG', summary: 'SM', themes: ['t'], protagonistArc: 'PA', shape: null },
      bible: { logline: 'LG', premise: 'SM', issueCountTarget: 3 },
      volume: { title: 'The Giant', logline: 'vlog', synopsis: 'vsyn' },
      issues: [
        { id: i1.id, title: 'Act One', synopsis: 'act one synopsis' },
        { id: i2.id, title: 'Act Two', synopsis: 'act two synopsis' },
        { id: i3.id, synopsis: 'act three synopsis' },
      ],
    });

    // Exactly one volume survives.
    expect(out.series.seasons).toHaveLength(1);
    const vol = out.series.seasons[0];
    expect(vol.title).toBe('The Giant');
    // Bible filled.
    expect(out.series).toMatchObject({ logline: 'LG', premise: 'SM', issueCountTarget: 3 });

    // Every issue is under the single volume.
    const all = await issuesSvc.listIssues({ seriesId: s.id });
    expect(all.every((iss) => iss.seasonId === vol.id)).toBe(true);

    // Per-issue title + synopsis applied; verbatim comicScript untouched.
    const f1 = await issuesSvc.getIssue(i1.id);
    expect(f1.title).toBe('Act One');
    expect(f1.stages.idea.input).toBe('act one synopsis');
    expect(f1.stages.comicScript.output).toBe('PAGE 1\nverbatim one');
    const f3 = await issuesSvc.getIssue(i3.id);
    expect(f3.stages.idea.input).toBe('act three synopsis');
    void v4;
  });

  it('commitDerivedManuscript respects a locked idea stage (does not overwrite synopsis)', async () => {
    const s = await setupSeries();
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1' });
    const i1 = await issuesSvc.createIssue({
      seriesId: s.id, seasonId: v1.id, title: 'Issue 1', arcPosition: 1,
      stages: { comicScript: { output: 'PAGE 1\nx', status: 'ready' }, idea: { input: 'frozen synopsis', status: 'edited', locked: true } },
    });
    await planner.commitDerivedManuscript(s.id, {
      arc: { logline: 'L', summary: 'S' },
      bible: { logline: 'L', premise: 'S', issueCountTarget: 1 },
      volume: { title: 'Vol' },
      issues: [{ id: i1.id, synopsis: 'should not apply' }],
    });
    const f1 = await issuesSvc.getIssue(i1.id);
    expect(f1.stages.idea.input).toBe('frozen synopsis');
  });

  it('commitDerivedManuscript does not strip issues out of a locked non-kept volume', async () => {
    const s = await setupSeries();
    const v1 = await seasonsSvc.createSeason(s.id, { title: 'V1', number: 1 });
    const v2 = await seasonsSvc.createSeason(s.id, { title: 'V2 (locked)', number: 2 });
    await seasonsSvc.updateSeason(s.id, v2.id, { locked: true });
    const i1 = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v1.id, title: 'Issue 1', arcPosition: 1, stages: { comicScript: { output: 'PAGE 1\nx', status: 'ready' } } });
    const iLocked = await issuesSvc.createIssue({ seriesId: s.id, seasonId: v2.id, title: 'Locked vol issue', arcPosition: 2, stages: { comicScript: { output: 'PAGE 1\ny', status: 'ready' } } });

    const out = await planner.commitDerivedManuscript(s.id, {
      arc: { logline: 'L', summary: 'S' },
      bible: { logline: 'L', premise: 'S', issueCountTarget: 2 },
      volume: { title: 'The Giant' },
      issues: [{ id: i1.id, synopsis: 'a' }, { id: iLocked.id, synopsis: 'b' }],
    });

    // The locked volume survives (commitSeasonsWithRemap re-inserts it) — so we
    // did NOT collapse to a single volume, and its issue must stay put.
    const seasonIds = out.series.seasons.map((x) => x.id);
    expect(seasonIds).toContain(v2.id);
    const fLocked = await issuesSvc.getIssue(iLocked.id);
    expect(fLocked.seasonId).toBe(v2.id); // not stripped onto the target volume
    const f1 = await issuesSvc.getIssue(i1.id);
    expect(f1.seasonId).toBe(v1.id); // the kept (lowest, unlocked) volume reused its id
  });
});
