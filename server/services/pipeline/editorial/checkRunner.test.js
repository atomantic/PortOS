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

const { runEditorialChecks, buildEditorialCheckPlan, getReviewWithStaleness } = await import('./checkRunner.js');
const { runStagedLLM } = await import('../../../lib/stageRunner.js');
const { collectManuscriptSections } = await import('../arcPlanner.js');
const { getSeriesCanon } = await import('../seriesCanon.js');
const { getSeries } = await import('../series.js');
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
  seedReviewFromFindings.mockClear();
  runStagedLLM.mockClear();
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

  it('stales a manuscript-check finding (not a canon-only one) when the series style guide changes', async () => {
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', styleGuide: { readingLevel: 8 } });
    await seedReviewFromRun();
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', styleGuide: { readingLevel: 12 } });
    const review = await getReviewWithStaleness('s1');
    expect(review.comments.find((c) => c.checkId === 'prose.info-dumping').stale).toBe(true);
    // styleGuide is in the manuscript segment only → a canon-only finding stays fresh.
    expect(review.comments.find((c) => c.checkId === 'naming.dissimilar-names').stale).toBe(false);
  });

  it('stales a canon-only finding (not a manuscript one) when the arc ticking clock changes', async () => {
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', arc: { tickingClock: { name: 'storm' } } });
    await seedReviewFromRun();
    getSeries.mockResolvedValueOnce({ id: 's1', universeId: 'u1', arc: { tickingClock: { name: 'eclipse' } } });
    const review = await getReviewWithStaleness('s1');
    // tickingClock is in the canon segment only → the manuscript finding stays fresh.
    expect(review.comments.find((c) => c.checkId === 'naming.dissimilar-names').stale).toBe(true);
    expect(review.comments.find((c) => c.checkId === 'prose.info-dumping').stale).toBe(false);
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
