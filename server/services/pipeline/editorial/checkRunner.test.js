import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the data sources + LLM + seed, but use the REAL registry so the runner
// exercises the actual reference checks (deterministic naming + LLM info-dump).
vi.mock('../../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../series.js', () => ({ getSeries: vi.fn(async () => ({ id: 's1', universeId: 'u1' })) }));
vi.mock('../issues.js', () => ({ listIssues: vi.fn(async () => []) }));
vi.mock('../seriesCanon.js', () => ({
  getSeriesCanon: vi.fn(async () => ({
    characters: [{ name: 'Alina' }, { name: 'Alana' }, { name: 'Zog' }],
    places: [],
    objects: [],
  })),
}));
vi.mock('../arcPlanner.js', () => ({
  collectManuscriptSections: vi.fn(async () => [
    { number: 1, title: 'Pilot', stageId: 'prose', content: 'As you know, Bob, the kingdom fell.' },
  ]),
  sectionsCorpus: vi.fn((sections) => sections.map((s) => s.content).join('\n')),
  manuscriptSectionHeader: vi.fn((s) => `# Issue ${s.number}`),
}));
vi.mock('../../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(async () => ({
    runId: 'llm-run',
    content: {
      findings: [
        { severity: 'medium', issueNumber: 1, location: 'p1', problem: 'Info dump in opening', suggestion: 'Dramatize it', anchorQuote: 'As you know, Bob' },
      ],
    },
  })),
  // Inline sibling for user-defined (custom) checks (#1346) — same finding shape.
  runInlineLLM: vi.fn(async () => ({
    runId: 'inline-run',
    content: {
      findings: [
        { severity: 'medium', issueNumber: 1, location: 'p1', problem: 'Anachronism in opening', suggestion: 'Cut it', anchorQuote: 'As you know, Bob' },
      ],
    },
  })),
  // A roomy window by default → manuscript LLM checks run in one whole-corpus call.
  resolveStageContext: vi.fn(async () => ({ provider: { type: 'cli' }, model: 'm', contextWindow: 1_000_000 })),
}));

// A real-ish seed that applies the same checkId-aware dedup key the store uses,
// so the runner-dedup test reflects production behavior.
const seedStore = [];
const findingKey = (c) => `${c.checkId ?? ''}|${c.issueNumber ?? ''}|${c.anchorQuote}|${c.problem}`;
const seedReviewFromFindings = vi.fn(async (_seriesId, findings) => {
  const seen = new Set(seedStore.map(findingKey));
  for (const f of findings) {
    const k = findingKey(f);
    if (!seen.has(k)) { seedStore.push(f); seen.add(k); }
  }
  return { comments: seedStore };
});
// `getReview` is backed by a mutable fixture the staleness tests set per-case.
let reviewState = { comments: [] };
vi.mock('../manuscriptReview.js', () => ({
  seedReviewFromFindings: (...a) => seedReviewFromFindings(...a),
  getReview: async () => reviewState,
}));
// Reverse-outline source (#1296) — backed by a mutable fixture; default empty so
// the scene.component-balance check is gated off unless a test populates scenes.
let outlineState = { scenes: [] };
vi.mock('../reverseOutline.js', () => ({ getReverseOutline: vi.fn(async () => outlineState) }));

const { runEditorialChecks, buildEditorialCheckPlan, getReviewWithStaleness } = await import('./checkRunner.js');
const { runStagedLLM, resolveStageContext } = await import('../../../lib/stageRunner.js');
const { collectManuscriptSections } = await import('../arcPlanner.js');
const { getSeriesCanon } = await import('../seriesCanon.js');
const { getSeries } = await import('../series.js');
const { getSettings } = await import('../../settings.js');
const { listChecks, getCheck } = await import('../../../lib/editorial/index.js');

// Build a `pipelineEditorialChecks.checks` map that disables every check
// matching `predicate` — keeps these fixtures robust as the registry grows
// (new checks shouldn't silently break a "no LLM" / "no checks" assertion).
const disableWhere = (predicate) => ({
  pipelineEditorialChecks: {
    checks: Object.fromEntries(listChecks().filter(predicate).map((c) => [c.id, { enabled: false }])),
  },
});

beforeEach(() => {
  seedStore.length = 0;
  reviewState = { comments: [] };
  outlineState = { scenes: [] };
  seedReviewFromFindings.mockClear();
  runStagedLLM.mockClear();
  resolveStageContext.mockClear();
  collectManuscriptSections.mockClear();
  getSeriesCanon.mockClear();
});

describe('runEditorialChecks', () => {
  it('runs enabled checks, stamps checkId, and seeds findings', async () => {
    const result = await runEditorialChecks('s1');
    // Naming finds the Alina/Alana pair; info-dump returns one LLM finding.
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    for (const f of result.findings) {
      expect(f.checkId, 'every finding carries its checkId').toBeTruthy();
    }
    expect(result.findings.some((f) => f.checkId === 'naming.dissimilar-names')).toBe(true);
    expect(result.findings.some((f) => f.checkId === 'prose.info-dumping')).toBe(true);

    // Seeded once, in 'merge' mode (never auto-dismiss other checks' findings).
    expect(seedReviewFromFindings).toHaveBeenCalledTimes(1);
    expect(seedReviewFromFindings.mock.calls[0][2]).toMatchObject({ mode: 'merge' });
  });

  it('reports per-check counts', async () => {
    const result = await runEditorialChecks('s1');
    const naming = result.perCheck.find((p) => p.checkId === 'naming.dissimilar-names');
    expect(naming.count).toBeGreaterThan(0);
  });

  it('re-running dedups findings (checkId-aware key)', async () => {
    await runEditorialChecks('s1');
    const afterFirst = seedStore.length;
    expect(afterFirst).toBeGreaterThan(0);
    await runEditorialChecks('s1');
    expect(seedStore.length, 're-run adds no duplicates').toBe(afterFirst);
  });

  it('runs only the requested subset', async () => {
    const result = await runEditorialChecks('s1', { checkIds: ['naming.dissimilar-names'] });
    expect(runStagedLLM).not.toHaveBeenCalled(); // info-dump (the only LLM check) skipped
    expect(result.findings.every((f) => f.checkId === 'naming.dissimilar-names')).toBe(true);
  });

  it('skips manuscript collection when no enabled check needs it', async () => {
    // Only the deterministic naming check (no needsManuscript) → no section I/O.
    await runEditorialChecks('s1', { checkIds: ['naming.dissimilar-names'] });
    expect(collectManuscriptSections).not.toHaveBeenCalled();
    // The info-dump check (needsManuscript) does trigger the collection.
    await runEditorialChecks('s1', { checkIds: ['prose.info-dumping'] });
    expect(collectManuscriptSections).toHaveBeenCalled();
  });

  it('skips disabled checks', async () => {
    // Disable every LLM check → no provider call, only deterministic findings.
    // The mock canon has no objects/links, so naming is the only producer.
    const settings = disableWhere((c) => c.kind === 'llm');
    const result = await runEditorialChecks('s1', { settings });
    expect(runStagedLLM).not.toHaveBeenCalled();
    expect(result.findings.every((f) => f.checkId === 'naming.dissimilar-names')).toBe(true);
  });

  it('returns an empty result when no checks are enabled', async () => {
    const settings = disableWhere(() => true);
    const result = await runEditorialChecks('s1', { settings });
    expect(result.findings).toEqual([]);
    expect(seedReviewFromFindings).not.toHaveBeenCalled();
  });

  it('skips seeding when canceled mid-run (no partial review mutation)', async () => {
    // Abort during the LLM check; the deterministic naming check already
    // collected findings, but a canceled run must not persist them.
    const controller = new AbortController();
    runStagedLLM.mockImplementationOnce(async () => { controller.abort(); return { runId: 'x', content: { findings: [] } }; });
    const result = await runEditorialChecks('s1', { signal: controller.signal });
    expect(result.canceled).toBe(true);
    expect(seedReviewFromFindings).not.toHaveBeenCalled();
  });

  it('chunks the manuscript per provider window and reviews every section (issue #1340)', async () => {
    // Three big sections + a small context window → the manuscript can't fit in
    // one call, so the runner chunks it. Every chunk must reach the model, so a
    // long series is fully reviewed instead of truncated.
    const big = (marker) => `${marker} ${'A'.repeat(12_000)}`;
    collectManuscriptSections.mockResolvedValueOnce([
      { number: 1, title: 'One', stageId: 'prose', content: big('SEC1') },
      { number: 2, title: 'Two', stageId: 'prose', content: big('SEC2') },
      { number: 3, title: 'Three', stageId: 'prose', content: big('SEC3') },
    ]);
    resolveStageContext.mockResolvedValueOnce({ provider: { type: 'api', endpoint: 'http://localhost:11434' }, model: 'm', contextWindow: 10_000 });

    await runEditorialChecks('s1', { checkIds: ['prose.info-dumping'] });

    // More than one model call ⇒ the corpus was split across the small window.
    expect(runStagedLLM.mock.calls.length).toBeGreaterThan(1);
    // Across all chunks, every section's content was sent to the model.
    const allSent = runStagedLLM.mock.calls.map((c) => c[1].manuscript).join('\n');
    expect(allSent).toContain('SEC1');
    expect(allSent).toContain('SEC2');
    expect(allSent).toContain('SEC3');
  });

  it('feeds a prior-chunk digest to later chunks for a cross-chunk-digest check, but not the first (#1383)', async () => {
    // A long manuscript + small window → chunked. style.conformance opts into the
    // cross-chunk digest, so chunks AFTER the first carry a digest of prior findings.
    const big = (marker) => `${marker} ${'A'.repeat(12_000)}`;
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', styleGuide: { tense: 'past', povPerson: 'first' } });
    collectManuscriptSections.mockResolvedValueOnce([
      { number: 1, title: 'One', stageId: 'prose', content: big('SEC1') },
      { number: 2, title: 'Two', stageId: 'prose', content: big('SEC2') },
      { number: 3, title: 'Three', stageId: 'prose', content: big('SEC3') },
    ]);
    resolveStageContext.mockResolvedValueOnce({ provider: { type: 'api', endpoint: 'http://localhost:11434' }, model: 'm', contextWindow: 10_000 });
    // The default runStagedLLM mock returns a finding on every call, so the first
    // chunk seeds the digest fed to later chunks (no custom impl needed — that
    // would leak past this test).

    await runEditorialChecks('s1', { checkIds: ['style.conformance'] });
    const sent = runStagedLLM.mock.calls.map((c) => c[1].manuscript);
    expect(sent.length).toBeGreaterThan(1);
    // First chunk: no digest preamble.
    expect(sent[0]).not.toContain('EARLIER parts of this manuscript');
    // At least one later chunk carries the digest of the first chunk's finding.
    const withDigest = sent.slice(1).filter((m) => m.includes('EARLIER parts of this manuscript'));
    expect(withDigest.length).toBeGreaterThan(0);
    expect(withDigest[0]).toContain('Info dump in opening');
  });

  it('still sends a non-empty manuscript on a small/fallback context window (issue #1340)', async () => {
    // An unknown local provider falls back to the 8K window. With the contextBudget
    // default 8K output reserve this would leave a 0-char input budget and feed the
    // model an empty manuscript — the editorial-sized output reserve must prevent that.
    resolveStageContext.mockResolvedValueOnce({ provider: { type: 'api', endpoint: 'http://localhost:1234' }, model: 'm', contextWindow: 8_192 });
    let sent = null;
    runStagedLLM.mockImplementationOnce(async (_stage, vars) => { sent = vars.manuscript; return { content: { findings: [] } }; });
    await runEditorialChecks('s1', { checkIds: ['prose.info-dumping'] });
    expect(sent).toBeTruthy();
    expect(sent.trim().length).toBeGreaterThan(0);
    expect(sent).toContain('kingdom fell'); // the actual section content, not an empty slice
  });

  it('stops launching chunk calls once cancelled mid-run (issue #1340)', async () => {
    // Three chunks; cancel during the first chunk's LLM call. The remaining
    // chunks must NOT be sent to the model, and the run is canceled (no seed).
    const big = (marker) => `${marker} ${'A'.repeat(12_000)}`;
    collectManuscriptSections.mockResolvedValueOnce([
      { number: 1, title: 'One', stageId: 'prose', content: big('SEC1') },
      { number: 2, title: 'Two', stageId: 'prose', content: big('SEC2') },
      { number: 3, title: 'Three', stageId: 'prose', content: big('SEC3') },
    ]);
    resolveStageContext.mockResolvedValueOnce({ provider: { type: 'api', endpoint: 'http://localhost:11434' }, model: 'm', contextWindow: 10_000 });
    const controller = new AbortController();
    runStagedLLM.mockImplementationOnce(async () => { controller.abort(); return { content: { findings: [] } }; });

    const result = await runEditorialChecks('s1', { checkIds: ['prose.info-dumping'], signal: controller.signal });

    expect(runStagedLLM).toHaveBeenCalledTimes(1); // chunks 2 and 3 skipped after abort
    expect(result.canceled).toBe(true);
    expect(seedReviewFromFindings).not.toHaveBeenCalled();
  });

  it('one failing check does not abort the pass', async () => {
    // Make info-dumping the only enabled LLM check so the single rejection lands
    // on it (the object LLM checks would otherwise consume the mockRejectedOnce).
    const settings = disableWhere((c) => c.kind === 'llm' && c.id !== 'prose.info-dumping');
    runStagedLLM.mockRejectedValueOnce(new Error('provider down'));
    const result = await runEditorialChecks('s1', { settings });
    // Naming still produced findings; info-dump recorded an error in perCheck.
    expect(result.findings.some((f) => f.checkId === 'naming.dissimilar-names')).toBe(true);
    const infodump = result.perCheck.find((p) => p.checkId === 'prose.info-dumping');
    expect(infodump.error).toMatch(/provider down/);
  });
});

describe('source-content hash stamping (#1345)', () => {
  it('stamps every finding with a non-empty sourceContentHash', async () => {
    const result = await runEditorialChecks('s1');
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(typeof f.sourceContentHash).toBe('string');
      expect(f.sourceContentHash.length).toBeGreaterThan(0);
    }
  });

  it('hashes canon-only checks differently from manuscript-consuming checks', async () => {
    const result = await runEditorialChecks('s1');
    const naming = result.findings.find((f) => f.checkId === 'naming.dissimilar-names');
    const infodump = result.findings.find((f) => f.checkId === 'prose.info-dumping');
    // Naming is canon-only (no needsManuscript); info-dumping reads the manuscript.
    expect(getCheck('naming.dissimilar-names').needsManuscript).toBeFalsy();
    expect(getCheck('prose.info-dumping').needsManuscript).toBe(true);
    expect(naming.sourceContentHash).not.toBe(infodump.sourceContentHash);
  });
});

describe('getReviewWithStaleness (#1345)', () => {
  // Seed the review fixture from a real run so each comment carries the exact
  // hash the runner stamped, then re-read under (un)changed content.
  const seedReviewFromRun = async () => {
    const { findings } = await runEditorialChecks('s1');
    reviewState = { comments: findings.map((f) => ({ ...f, status: 'open' })) };
    return findings;
  };

  it('flags nothing stale when the content is unchanged', async () => {
    await seedReviewFromRun();
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.length).toBeGreaterThan(0);
    for (const c of review.comments) expect(c.stale).toBe(false);
  });

  it('flags manuscript-consuming findings stale when the manuscript changes (canon-only stay fresh)', async () => {
    await seedReviewFromRun();
    // Only the manuscript drifts — canon is unchanged.
    collectManuscriptSections.mockResolvedValueOnce([
      { number: 1, title: 'Pilot', stageId: 'prose', content: 'A completely rewritten opening paragraph.' },
    ]);
    const review = await getReviewWithStaleness('s1');
    const naming = review.comments.find((c) => c.checkId === 'naming.dissimilar-names');
    const infodump = review.comments.find((c) => c.checkId === 'prose.info-dumping');
    expect(infodump.stale).toBe(true);
    expect(naming.stale).toBe(false);
  });

  it('flags canon-only findings stale when the canon changes', async () => {
    await seedReviewFromRun();
    getSeriesCanon.mockResolvedValueOnce({ characters: [{ name: 'Reardon' }], places: [], objects: [] });
    const review = await getReviewWithStaleness('s1');
    const naming = review.comments.find((c) => c.checkId === 'naming.dissimilar-names');
    expect(naming.stale).toBe(true);
  });

  it('stales only the style-guide-reading checks when the series style guide changes (#1387 precision)', async () => {
    // style.conformance declares 'series.styleGuide'; prose.info-dumping is
    // manuscript-only and naming is canon-only — so editing the style guide must
    // stale ONLY the style check, not every manuscript-consuming finding (the
    // pre-#1387 heuristic over-flagged info-dumping here).
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', styleGuide: { tense: 'past' } });
    await seedReviewFromRun();
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', styleGuide: { tense: 'present' } });
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'style.conformance').stale).toBe(true);
    expect(review.comments.find((c) => c.checkId === 'prose.info-dumping').stale).toBe(false);
    expect(review.comments.find((c) => c.checkId === 'naming.dissimilar-names').stale).toBe(false);
  });

  it('stales only the ticking-clock check when the arc ticking clock changes (#1387 precision)', async () => {
    // arc.ticking-clock-hygiene declares 'series.arc.tickingClock'; naming is
    // canon-only and info-dumping manuscript-only — so editing the ticking clock
    // must stale ONLY the ticking-clock finding (the pre-#1387 heuristic folded the
    // clock into the shared canon segment and over-flagged naming/object findings).
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', arc: { tickingClock: { enabled: true } } });
    await seedReviewFromRun();
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', arc: { tickingClock: { enabled: true, label: 'eclipse' } } });
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'arc.ticking-clock-hygiene').stale).toBe(true);
    expect(review.comments.find((c) => c.checkId === 'naming.dissimilar-names').stale).toBe(false);
    expect(review.comments.find((c) => c.checkId === 'prose.info-dumping').stale).toBe(false);
  });

  it('stales only the reverse-outline-reading check when the scene segmentation changes (#1296/#1387 precision)', async () => {
    // scene.component-balance declares 'reverseOutline'; naming is canon-only and
    // info-dumping manuscript-only — so editing the scenes must stale ONLY the scene
    // finding, and the scene finding must NOT stale on manuscript/canon edits.
    outlineState = { scenes: [{ id: 'scene-001', issueNumber: 1, heading: 'Talking heads', anchorQuote: 'q', components: { narrative: false, action: false, dialogue: true } }] };
    await seedReviewFromRun();
    expect(reviewState.comments.find((c) => c.checkId === 'scene.component-balance')).toBeTruthy();
    // Mutate only the scene components (give it a second mode) — the outline drifts.
    outlineState = { scenes: [{ id: 'scene-001', issueNumber: 1, heading: 'Talking heads', anchorQuote: 'q', components: { narrative: true, action: false, dialogue: true } }] };
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'scene.component-balance').stale).toBe(true);
    expect(review.comments.find((c) => c.checkId === 'naming.dissimilar-names').stale).toBe(false);
    expect(review.comments.find((c) => c.checkId === 'prose.info-dumping').stale).toBe(false);
  });

  it('keeps a scene finding fresh when the manuscript changes (reverseOutline-only source)', async () => {
    outlineState = { scenes: [{ id: 'scene-001', issueNumber: 1, heading: 'Talking heads', anchorQuote: 'q', components: { narrative: false, action: false, dialogue: true } }] };
    await seedReviewFromRun();
    collectManuscriptSections.mockResolvedValueOnce([
      { number: 1, title: 'Pilot', stageId: 'prose', content: 'A completely rewritten opening.' },
    ]);
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'scene.component-balance').stale).toBe(false);
  });

  it('stales a custom-check finding when its authored prompt changes, even if the manuscript is unchanged (#1387)', async () => {
    // A custom check's run logic is its prompt (user data), so a prompt edit must
    // stale its prior findings — the manuscript source alone can't catch that.
    const settingsWithPrompt = (prompt) => ({
      pipelineEditorialChecks: {
        customChecks: [{ id: 'custom.anachronism', label: 'Anachronisms', prompt, scope: 'issue', severityDefault: 'medium' }],
      },
    });
    getSettings.mockResolvedValueOnce(settingsWithPrompt('Flag modern tech in a period setting.'));
    const { findings } = await runEditorialChecks('s1');
    reviewState = { comments: findings.map((f) => ({ ...f, status: 'open' })) };
    const custom = findings.find((f) => f.checkId === 'custom.anachronism');
    expect(custom, 'custom check produced a finding').toBeTruthy();

    // Same prompt → fresh (the manuscript-only segment is unchanged).
    getSettings.mockResolvedValueOnce(settingsWithPrompt('Flag modern tech in a period setting.'));
    const fresh = await getReviewWithStaleness('s1');
    expect(fresh.comments.find((c) => c.checkId === 'custom.anachronism').stale).toBe(false);

    // Edited prompt → stale, despite the unchanged manuscript.
    getSettings.mockResolvedValueOnce(settingsWithPrompt('Flag anachronistic slang in dialogue.'));
    const stale = await getReviewWithStaleness('s1');
    expect(stale.comments.find((c) => c.checkId === 'custom.anachronism').stale).toBe(true);
  });

  it('leaves legacy findings (no hash), completeness comments (no checkId), and unknown checks unannotated', async () => {
    reviewState = {
      comments: [
        { id: 'a', checkId: 'naming.dissimilar-names', anchorQuote: 'x', problem: 'legacy', status: 'open' }, // no hash
        { id: 'b', checkId: null, anchorQuote: 'y', problem: 'completeness', status: 'open', sourceContentHash: 'abc' },
        { id: 'c', checkId: 'does.not-exist', anchorQuote: 'z', problem: 'unknown check', status: 'open', sourceContentHash: 'abc' },
      ],
    };
    const review = await getReviewWithStaleness('s1');
    // No evaluable comment → passthrough, no recompute, no `stale` key added.
    for (const c of review.comments) expect(c).not.toHaveProperty('stale');
    expect(collectManuscriptSections).not.toHaveBeenCalled();
    expect(getSeriesCanon).not.toHaveBeenCalled();
  });
});

describe('buildEditorialCheckPlan', () => {
  it('lists enabled checks for a dry run', async () => {
    const plan = await buildEditorialCheckPlan('s1');
    expect(plan.enabledCount).toBe(plan.checks.length);
    expect(plan.checks.map((c) => c.id)).toContain('naming.dissimilar-names');
  });
});
