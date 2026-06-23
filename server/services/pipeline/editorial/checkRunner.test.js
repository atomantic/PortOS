import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the data sources + LLM + seed, but use the REAL registry so the runner
// exercises the actual reference checks (deterministic naming + LLM info-dump).
vi.mock('../../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../series.js', () => ({ getSeries: vi.fn(async () => ({ id: 's1', universeId: 'u1' })) }));
// Issues source — backed by a mutable fixture so the storyboard.shots continuity
// check (#1315) can be exercised; default empty so the check is gated off unless a
// test populates issues carrying storyboard scenes. The runner reads the UNCAPPED
// per-series scan (#1469), so the mock filters the fixture by seriesId.
let issuesState = [];
vi.mock('../issues.js', () => ({
  listIssuesForSeries: vi.fn(async (seriesId) => issuesState.filter((i) => i.seriesId === seriesId)),
}));
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
// Editorial-arcs source (#1295) — backed by a mutable fixture; default empty so
// the pov.justified arc cross-reference degrades gracefully unless a test
// populates detected character arcs.
let editorialState = { characters: [] };
vi.mock('../editorialAnalysis.js', () => ({ getSeriesEditorial: vi.fn(async () => editorialState) }));

const { runEditorialChecks, buildEditorialCheckPlan, getReviewWithStaleness, enabledChecksConsumeReverseOutline } = await import('./checkRunner.js');
const { runStagedLLM, resolveStageContext } = await import('../../../lib/stageRunner.js');
const { collectManuscriptSections } = await import('../arcPlanner.js');
const { getSeriesCanon } = await import('../seriesCanon.js');
const { getSeries } = await import('../series.js');
const { getSettings } = await import('../../settings.js');
const { listChecks, getCheck } = await import('../../../lib/editorial/index.js');
const { listIssuesForSeries } = await import('../issues.js');

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
  editorialState = { characters: [] };
  issuesState = [];
  seedReviewFromFindings.mockClear();
  runStagedLLM.mockClear();
  resolveStageContext.mockClear();
  collectManuscriptSections.mockClear();
  getSeriesCanon.mockClear();
  listIssuesForSeries.mockClear();
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

    // Deterministic checks self-heal: each is seeded in 'fresh' mode scoped to
    // its own checkId (so a finding it no longer produces auto-dismisses), while
    // LLM checks seed in 'merge' mode (an absent LLM finding could be variance).
    // Here: naming (deterministic) → fresh+scoped, info-dump (LLM) → merge.
    const calls = seedReviewFromFindings.mock.calls;
    const naming = calls.find((c) => c[2]?.checkId === 'naming.dissimilar-names');
    expect(naming, 'naming seeded fresh, scoped to its checkId').toBeTruthy();
    expect(naming[2]).toMatchObject({ mode: 'fresh', checkId: 'naming.dissimilar-names' });
    const merge = calls.find((c) => c[2]?.mode === 'merge');
    expect(merge, 'LLM findings seeded in merge mode').toBeTruthy();
    expect(merge[2].checkId ?? null).toBeNull();
    // No deterministic finding leaked into the merge batch — they're all routed to
    // their own fresh+scoped seed instead. (The merge batch is LLM findings only.)
    const deterministicIds = new Set(
      listChecks().filter((c) => c.kind === 'deterministic').map((c) => c.id),
    );
    expect(merge[1].some((f) => deterministicIds.has(f.checkId))).toBe(false);
    expect(merge[1].some((f) => f.checkId === 'prose.info-dumping')).toBe(true);
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

  // #1514: Series Autopilot's run provider arrives as a SOFT providerDefault so a
  // per-stage pin still wins for an LLM check; a manual route override stays a HARD
  // providerOverride. The LLM check (prose.info-dumping) routes through callStagedLLM.
  it('threads providerDefault (autopilot run provider) into LLM checks as a soft default', async () => {
    await runEditorialChecks('s1', { checkIds: ['prose.info-dumping'], providerDefault: 'codex' });
    const opts = runStagedLLM.mock.calls[0][2];
    expect(opts.providerDefault).toBe('codex');
    expect(opts.providerOverride).toBeUndefined();
  });

  it('threads a manual providerOverride into LLM checks as a hard override', async () => {
    await runEditorialChecks('s1', { checkIds: ['prose.info-dumping'], providerOverride: 'ollama' });
    const opts = runStagedLLM.mock.calls[0][2];
    expect(opts.providerOverride).toBe('ollama');
    expect(opts.providerDefault).toBeUndefined();
  });

  it('skips manuscript collection when no enabled check needs it', async () => {
    // Only the deterministic naming check (no needsManuscript) → no section I/O.
    await runEditorialChecks('s1', { checkIds: ['naming.dissimilar-names'] });
    expect(collectManuscriptSections).not.toHaveBeenCalled();
    // The info-dump check (needsManuscript) does trigger the collection.
    await runEditorialChecks('s1', { checkIds: ['prose.info-dumping'] });
    expect(collectManuscriptSections).toHaveBeenCalled();
  });

  it('feeds the comic-pacing checks off each issue\'s comic script (#1314)', async () => {
    // Issue 1 is two splash pages in a row — the deterministic comic.panel-rhythm
    // check flags the back-to-back splash run. Both comic checks read the same
    // parsed pages off ctx.issues via the shared comicLetteringIssues projection.
    issuesState = [
      { id: 'i1', seriesId: 's1', number: 1, stages: { comicScript: { output: 'PAGE 1\nPANEL 1\nSplash.\nPAGE 2\nPANEL 1\nSplash again.' } } },
      { id: 'i2', seriesId: 's1', number: 2, stages: { comicScript: { output: 'PAGE 1\nPANEL 1\nA.\nPANEL 2\nB.\nPANEL 3\nC.' } } },
    ];
    const result = await runEditorialChecks('s1', { checkIds: ['comic.panel-rhythm'] });
    const comic = result.findings.filter((f) => f.checkId === 'comic.panel-rhythm');
    expect(comic.length).toBeGreaterThan(0);
    expect(comic.some((f) => f.issueNumber === 1)).toBe(true);
    expect(comic.every((f) => f.category === 'pacing')).toBe(true);
  });

  it('produces no comic-pacing findings when no comic-pacing check is enabled', async () => {
    issuesState = [
      { number: 1, stages: { comicScript: { output: 'PAGE 1\nPANEL 1\nSplash.' } } },
    ];
    // Only the naming check runs — its gate never reads comic content, so the
    // comic checks stay inert (no comic findings produced).
    const result = await runEditorialChecks('s1', { checkIds: ['naming.dissimilar-names'] });
    expect(result.findings.some((f) => f.checkId === 'comic.panel-rhythm')).toBe(false);
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

  it('self-heals a deterministic check that finds nothing (fresh+scoped seed dismisses stale opens)', async () => {
    // A clean canon → the naming check produces zero findings. It must STILL seed
    // in 'fresh' mode scoped to its checkId so any prior open naming findings are
    // reconciled away — otherwise stale deterministic findings linger forever and
    // can permanently block the health gate.
    getSeriesCanon.mockResolvedValueOnce({
      characters: [{ name: 'Zebediah' }, { name: 'Wolfgang' }], places: [], objects: [],
    });
    const result = await runEditorialChecks('s1', { checkIds: ['naming.dissimilar-names'] });
    expect(result.findings).toEqual([]);
    expect(seedReviewFromFindings).toHaveBeenCalledTimes(1);
    const [, findings, opts] = seedReviewFromFindings.mock.calls[0];
    expect(findings).toEqual([]); // nothing found this pass
    expect(opts).toMatchObject({ mode: 'fresh', checkId: 'naming.dissimilar-names' });
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

  it('guarantees a non-empty manuscript when a huge reverse outline + a tiny window would starve the chunk (issue #1459)', async () => {
    // A context-bearing check (arc.transitions re-sends the scene map per chunk).
    // A reverse outline with many scenes makes the sceneMap overhead alone meet/
    // exceed a small window's usable budget — which used to slice the manuscript
    // chunk to ''. The context floor must trim the scene map so the manuscript
    // (the actual prose under review) still reaches the model non-empty.
    const manyScenes = Array.from({ length: 400 }, (_, i) => ({
      issueNumber: 1,
      sceneLabel: `Scene ${i + 1}`,
      setting: `An elaborately described location number ${i + 1} that goes on at length to inflate the scene map`,
      charactersPresent: ['Alina', 'Alana', 'Zog'],
    }));
    outlineState = { scenes: manyScenes };
    collectManuscriptSections.mockResolvedValueOnce([
      { number: 1, title: 'Pilot', stageId: 'prose', content: 'Alina chose to betray Zog, and in that moment she became someone new.' },
    ]);
    resolveStageContext.mockResolvedValueOnce({ provider: { type: 'api', endpoint: 'http://localhost:1234' }, model: 'm', contextWindow: 8_192 });
    let sent = null;
    runStagedLLM.mockImplementationOnce(async (_stage, vars) => { sent = vars.manuscript; return { content: { findings: [] } }; });

    await runEditorialChecks('s1', { checkIds: ['arc.transitions'] });

    expect(sent).toBeTruthy();
    // The manuscript chunk is non-empty — the scene map was trimmed, not the prose.
    expect(sent.trim().length).toBeGreaterThan(0);
    expect(sent).toContain('chose to betray');
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

describe('visual.shot-continuity (#1315)', () => {
  // Enable ONLY the shot-continuity check so the assertions don't pick up
  // naming/info-dump findings (and the LLM mock isn't exercised).
  const onlyShotContinuity = {
    pipelineEditorialChecks: {
      checks: Object.fromEntries(
        listChecks().filter((c) => c.id !== 'visual.shot-continuity').map((c) => [c.id, { enabled: false }]),
      ),
    },
  };

  it('flags a 180° axis reversal across continuity-linked shots in a storyboard scene', async () => {
    issuesState = [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { storyboards: { scenes: [{
        heading: 'INT. THRONE ROOM',
        shots: [
          { id: 'shot-01', description: 'queen faces left', screenDirection: 'left' },
          { id: 'shot-02', description: 'reverse', screenDirection: 'right', continuityFromShotId: 'shot-01' },
        ],
      }] } },
    }];
    const result = await runEditorialChecks('s1', { settings: onlyShotContinuity });
    const findings = result.findings.filter((f) => f.checkId === 'visual.shot-continuity');
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe('continuity');
    expect(findings[0].issueNumber).toBe(1);
    expect(findings[0].problem).toMatch(/axis reversal/i);
    expect(runStagedLLM).not.toHaveBeenCalled(); // deterministic — no LLM
  });

  it('skips entirely (gated off) when no issue has storyboard scenes', async () => {
    issuesState = [{ id: 'i1', seriesId: 's1', number: 1, stages: {} }];
    const result = await runEditorialChecks('s1', { settings: onlyShotContinuity });
    const row = result.perCheck.find((p) => p.checkId === 'visual.shot-continuity');
    expect(row.skipped).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('reaches a storyboard scene past the 1000-issue listIssues cap (#1469)', async () => {
    // 1000 empty issues + a 1001st carrying the offending scene. listIssues caps at
    // ISSUES_PER_RESPONSE_MAX (1000), so before the uncapped per-series scan this
    // scene was silently skipped and the continuity break went unflagged.
    const filler = Array.from({ length: 1000 }, (_, n) => ({
      id: `i${n + 1}`, seriesId: 's1', number: n + 1, stages: {},
    }));
    issuesState = [...filler, {
      id: 'i1001', seriesId: 's1', number: 1001,
      stages: { storyboards: { scenes: [{
        heading: 'INT. THRONE ROOM',
        shots: [
          { id: 'shot-01', description: 'queen faces left', screenDirection: 'left' },
          { id: 'shot-02', description: 'reverse', screenDirection: 'right', continuityFromShotId: 'shot-01' },
        ],
      }] } },
    }];
    const result = await runEditorialChecks('s1', { settings: onlyShotContinuity });
    const findings = result.findings.filter((f) => f.checkId === 'visual.shot-continuity');
    expect(findings).toHaveLength(1);
    expect(findings[0].issueNumber).toBe(1001);
    expect(findings[0].problem).toMatch(/axis reversal/i);
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

  it('stales the storyboard-continuity finding when a shot edit changes the scene (#1315)', async () => {
    // visual.shot-continuity declares 'storyboard.shots'; editing a shot's
    // direction must stale ONLY the continuity finding, not the canon-only naming one.
    issuesState = [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { storyboards: { scenes: [{
        heading: 'INT. THRONE ROOM',
        shots: [
          { id: 'shot-01', description: 'left', screenDirection: 'left' },
          { id: 'shot-02', description: 'right', screenDirection: 'right', continuityFromShotId: 'shot-01' },
        ],
      }] } },
    }];
    await seedReviewFromRun();
    expect(reviewState.comments.find((c) => c.checkId === 'visual.shot-continuity')).toBeTruthy();
    // Fix the axis (both face left) — the shot list drifts.
    issuesState = [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { storyboards: { scenes: [{
        heading: 'INT. THRONE ROOM',
        shots: [
          { id: 'shot-01', description: 'left', screenDirection: 'left' },
          { id: 'shot-02', description: 'left now', screenDirection: 'left', continuityFromShotId: 'shot-01' },
        ],
      }] } },
    }];
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'visual.shot-continuity').stale).toBe(true);
    expect(review.comments.find((c) => c.checkId === 'naming.dissimilar-names').stale).toBe(false);
  });

  it('keeps a storyboard-continuity finding fresh after an unrelated render edit (#1315 projection)', async () => {
    // The fingerprint must project to only the fields the check reads (shot
    // grammar + heading/slugline) — a render/status edit (sceneVideoJobId,
    // imageJobId) on the same scene must NOT stale the continuity finding.
    issuesState = [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { storyboards: { scenes: [{
        heading: 'INT. THRONE ROOM',
        shots: [
          { id: 'shot-01', description: 'left', screenDirection: 'left' },
          { id: 'shot-02', description: 'right', screenDirection: 'right', continuityFromShotId: 'shot-01' },
        ],
      }] } },
    }];
    await seedReviewFromRun();
    expect(reviewState.comments.find((c) => c.checkId === 'visual.shot-continuity')).toBeTruthy();
    // Same shot grammar; only a render artifact + per-shot job id changed.
    issuesState = [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { storyboards: { scenes: [{
        heading: 'INT. THRONE ROOM',
        sceneVideoJobId: 'job-rendered-42',
        shots: [
          { id: 'shot-01', description: 'left', screenDirection: 'left', startFrameJobId: 'frame-9' },
          { id: 'shot-02', description: 'right', screenDirection: 'right', continuityFromShotId: 'shot-01', startFrameJobId: 'frame-10' },
        ],
      }] } },
    }];
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'visual.shot-continuity').stale).toBe(false);
  });

  it('a panel description edit stales the page-turn finding but NOT the lettering finding (#1314 vs #1313 source split)', async () => {
    // The pacing checks (#1314) read each panel's visual `description`; the
    // lettering check (#1313) reads only caption/dialogue/SFX. They use SEPARATE
    // source tokens (`comicScript.pacing` vs `comicScript`) so a description-only
    // edit stales a page-turn finding (it read the description) WITHOUT staling a
    // lettering finding (it didn't) — and vice-versa. This pins both halves.
    const comicIssue = (desc) => [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { comicPages: { pages: [
        // A 30-word caption so the lettering check fires an over-stuffed-balloon finding too.
        { panels: [{ description: desc, caption: 'word '.repeat(30).trim(), dialogue: [], sfx: '' }] },
        { panels: [{ description: 'b1', caption: '', dialogue: [], sfx: '' }, { description: 'b2', caption: '', dialogue: [], sfx: '' }] },
      ] } },
    }];
    issuesState = comicIssue('a reveal on the wrong page');
    // Enable ONLY the two comic checks; the shared runStagedLLM mock returns a
    // finding for the page-turn stage call.
    const comicChecksOnly = {
      pipelineEditorialChecks: {
        checks: Object.fromEntries(
          listChecks()
            .filter((c) => c.id !== 'comic.page-turn-beats' && c.id !== 'comic.lettering-density')
            .map((c) => [c.id, { enabled: false }]),
        ),
      },
    };
    const { findings } = await runEditorialChecks('s1', { settings: comicChecksOnly });
    reviewState = { comments: findings.map((f) => ({ ...f, status: 'open' })) };
    expect(reviewState.comments.find((c) => c.checkId === 'comic.page-turn-beats')).toBeTruthy();
    expect(reviewState.comments.find((c) => c.checkId === 'comic.lettering-density')).toBeTruthy();
    // Only a panel description changed — panel counts + all lettering text identical.
    issuesState = comicIssue('a reveal moved to a reveal-safe page');
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'comic.page-turn-beats').stale).toBe(true);
    expect(review.comments.find((c) => c.checkId === 'comic.lettering-density').stale).toBe(false);
  });

  it('keeps a comic.panel-rhythm finding fresh on a text-only edit but stales it on a panel-count change (#1314 layout source)', async () => {
    // panel-rhythm reads only per-page panel COUNTS (comicScript.layout), so a
    // text edit that leaves the counts intact must not stale it; adding a panel must.
    const comicIssue = (extraDesc) => [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { comicPages: { pages: [
        { panels: [{ description: 'p1a', caption: '', dialogue: [], sfx: '' }] },           // splash
        { panels: [{ description: 'p1b', caption: '', dialogue: [], sfx: '' }] },           // splash → back-to-back splash run fires
        ...(extraDesc ? [{ panels: [{ description: extraDesc, caption: '', dialogue: [], sfx: '' }] }] : []),
      ] } },
    }];
    issuesState = comicIssue(null);
    const { findings } = await runEditorialChecks('s1', { checkIds: ['comic.panel-rhythm'] });
    expect(findings.some((f) => f.checkId === 'comic.panel-rhythm')).toBe(true);
    reviewState = { comments: findings.map((f) => ({ ...f, status: 'open' })) };
    // Text-only edit: reword page 1's description; panel counts [1,1] unchanged.
    issuesState = [{
      id: 'i1', seriesId: 's1', number: 1,
      stages: { comicPages: { pages: [
        { panels: [{ description: 'reworded entirely', caption: 'new caption', dialogue: [], sfx: '' }] },
        { panels: [{ description: 'p1b', caption: '', dialogue: [], sfx: '' }] },
      ] } },
    }];
    let review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'comic.panel-rhythm').stale).toBe(false);
    // Adding a third page changes the layout → the finding stales.
    issuesState = comicIssue('a new third page');
    review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'comic.panel-rhythm').stale).toBe(true);
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

  it('stales a pov.justified finding when arc coverage flips incomplete even if the arc projection is byte-identical (#1295)', async () => {
    // A prose edit that stales the editorial analysis (without re-running it)
    // leaves the arc projection unchanged but flips coverage-complete. The
    // "no detected arc" verdict depends on that flag, so the finding must go
    // stale — folding `complete` into the editorialArcs fingerprint is what
    // catches it (the projection alone wouldn't).
    outlineState = { scenes: [
      { id: 'scene-001', issueNumber: 1, heading: 'Solo A', anchorQuote: 'q1', povCharacter: 'Solo', components: { narrative: true } },
      { id: 'scene-002', issueNumber: 1, heading: 'Solo B', anchorQuote: 'q2', povCharacter: 'Solo', components: { narrative: true } },
    ] };
    editorialState = {
      characters: [{ name: 'Solo', arcDirection: 'flat', issueCount: 1, isProtagonist: false }],
      coverage: { analyzed: 1, total: 1, withContent: 1, stale: 0, noContent: 0 },
    };
    await seedReviewFromRun();
    expect(reviewState.comments.find((c) => c.checkId === 'pov.justified')).toBeTruthy();
    // Identical arc projection, but the analysis is now stale (coverage incomplete).
    editorialState = {
      characters: [{ name: 'Solo', arcDirection: 'flat', issueCount: 1, isProtagonist: false }],
      coverage: { analyzed: 1, total: 1, withContent: 1, stale: 1, noContent: 0 },
    };
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'pov.justified').stale).toBe(true);
    // A canon-only finding is unaffected by the coverage flip.
    expect(review.comments.find((c) => c.checkId === 'naming.dissimilar-names').stale).toBe(false);
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

  it('exposes whether any enabled check consumes the reverse outline (#1349)', async () => {
    const plan = await buildEditorialCheckPlan('s1');
    // Scene/POV checks ship enabled by default, so the default plan consumes it.
    expect(plan.consumesReverseOutline).toBe(true);
  });
});

describe('enabledChecksConsumeReverseOutline (#1349)', () => {
  const consumesOutline = (c) => Array.isArray(c.sources)
    && (c.sources.includes('reverseOutline') || c.sources.includes('reverseOutline.plotlines'));

  it('is true when a scene/plotline check is enabled (default settings)', () => {
    expect(enabledChecksConsumeReverseOutline({})).toBe(true);
  });

  it('is false when every reverse-outline-consuming check is disabled', () => {
    const settings = disableWhere(consumesOutline);
    expect(enabledChecksConsumeReverseOutline(settings)).toBe(false);
  });
});
