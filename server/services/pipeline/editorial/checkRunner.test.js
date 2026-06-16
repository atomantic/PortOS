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
vi.mock('../manuscriptReview.js', () => ({ seedReviewFromFindings: (...a) => seedReviewFromFindings(...a) }));

const { runEditorialChecks, buildEditorialCheckPlan } = await import('./checkRunner.js');
const { runStagedLLM } = await import('../../../lib/stageRunner.js');

beforeEach(() => {
  seedStore.length = 0;
  seedReviewFromFindings.mockClear();
  runStagedLLM.mockClear();
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

  it('skips disabled checks', async () => {
    const settings = { pipelineEditorialChecks: { checks: { 'prose.info-dumping': { enabled: false } } } };
    const result = await runEditorialChecks('s1', { settings });
    expect(runStagedLLM).not.toHaveBeenCalled();
    expect(result.findings.every((f) => f.checkId === 'naming.dissimilar-names')).toBe(true);
  });

  it('returns an empty result when no checks are enabled', async () => {
    const settings = {
      pipelineEditorialChecks: {
        checks: { 'naming.dissimilar-names': { enabled: false }, 'prose.info-dumping': { enabled: false } },
      },
    };
    const result = await runEditorialChecks('s1', { settings });
    expect(result.findings).toEqual([]);
    expect(seedReviewFromFindings).not.toHaveBeenCalled();
  });

  it('one failing check does not abort the pass', async () => {
    runStagedLLM.mockRejectedValueOnce(new Error('provider down'));
    const result = await runEditorialChecks('s1');
    // Naming still produced findings; info-dump recorded an error in perCheck.
    expect(result.findings.some((f) => f.checkId === 'naming.dissimilar-names')).toBe(true);
    const infodump = result.perCheck.find((p) => p.checkId === 'prose.info-dumping');
    expect(infodump.error).toMatch(/provider down/);
  });
});

describe('buildEditorialCheckPlan', () => {
  it('lists enabled checks for a dry run', async () => {
    const plan = await buildEditorialCheckPlan('s1');
    expect(plan.enabledCount).toBe(plan.checks.length);
    expect(plan.checks.map((c) => c.id)).toContain('naming.dissimilar-names');
  });
});
