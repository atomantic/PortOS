import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory snapshot store mirroring atomicWrite(JSON.stringify) + tryReadFile(string).
const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn(async () => {}),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, JSON.stringify(data)); }),
  tryReadFile: vi.fn(async (path) => (fileStore.has(path) ? fileStore.get(path) : null)),
  safeJSONParse: (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } },
}));

// runStagedLLM returns the next queued canned analysis.
const llmQueue = [];
const llmCalls = [];
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(async (stage, ctx) => {
    llmCalls.push({ stage, ctx });
    const content = llmQueue.shift();
    return { content, model: 'mock-model', providerId: 'mock-provider', runId: 'run-1' };
  }),
}));

// Fixture issue/series stores.
const issuesFixture = new Map();
const seriesFixture = new Map();

vi.mock('./issues.js', () => ({
  getIssue: vi.fn(async (id) => {
    const i = issuesFixture.get(id);
    if (!i) throw new Error(`Issue not found: ${id}`);
    return i;
  }),
  listIssues: vi.fn(async ({ seriesId } = {}) =>
    [...issuesFixture.values()].filter((i) => !seriesId || i.seriesId === seriesId)),
}));

vi.mock('./series.js', () => ({
  getSeries: vi.fn(async (id) => {
    const s = seriesFixture.get(id);
    if (!s) throw new Error(`Series not found: ${id}`);
    return s;
  }),
}));

const getSeriesCanonMock = vi.fn(async () => ({ characters: [{ name: 'Ada' }, { name: 'Bly' }] }));
vi.mock('./seriesCanon.js', () => ({
  getSeriesCanon: (...a) => getSeriesCanonMock(...a),
}));

const svc = await import('./editorialAnalysis.js');

const makeIssue = (id, { seriesId = 'ser-1', number = 1, arcPosition = 1, title = 'T', prose = 'Some prose.' } = {}) => ({
  id, seriesId, number, arcPosition, title, arcRole: null,
  stages: { prose: { output: prose }, comicScript: { output: '' }, teleplay: { output: '' } },
});

const cannedAnalysis = () => ({
  sections: [
    { label: 'Scene 1', excerpt: 'open', primaryEmotion: 'curiosity', emotions: ['curiosity'], tension: 40, valence: 10, note: 'opening' },
    { label: 'Scene 2', primaryEmotion: 'dread', tension: 150, valence: -200, note: 'turn' },
  ],
  characters: [
    { name: 'Ada', isProtagonist: true, role: 'protagonist', arcDirection: 'rising', arcSummary: 'grows up', beats: [{ sectionIndex: 1, state: 'resolves' }] },
    { name: 'Bly', isProtagonist: false, arcDirection: 'falling', arcSummary: 'falls apart' },
  ],
  rollup: { plotTension: 80, characterProgress: 55, readerValence: -40, readerIntensity: 70, primaryEmotion: 'dread', peakTension: 90, cliffhanger: true, oneLine: 'tense ride' },
});

beforeEach(() => {
  fileStore.clear();
  issuesFixture.clear();
  seriesFixture.clear();
  llmQueue.length = 0;
  llmCalls.length = 0;
  seriesFixture.set('ser-1', { id: 'ser-1', name: 'Test', logline: 'lg', arc: { protagonistArc: 'Ada must grow', themes: ['loss'] } });
});

describe('analyzeIssue', () => {
  it('clamps LLM output, stores a snapshot, and carries run attribution', async () => {
    issuesFixture.set('iss-1', makeIssue('iss-1'));
    llmQueue.push(cannedAnalysis());

    const snap = await svc.analyzeIssue('iss-1');
    expect(snap.status).toBe('complete');
    expect(snap.sections).toHaveLength(2);
    // Section 2's tension 150 → 100, valence −200 → −100.
    expect(snap.sections[1].tension).toBe(100);
    expect(snap.sections[1].valence).toBe(-100);
    expect(snap.rollup.cliffhanger).toBe(true);
    expect(snap.providerId).toBe('mock-provider');
    expect(snap.runId).toBe('run-1');
    expect(snap.sourceStage).toBe('prose');
    expect(snap.sourceContentHash).toBeTruthy();
    // Canon must be resolved from the SERIES OBJECT (not the seriesId string) —
    // a regression to getSeriesCanon(issue.seriesId) would silently drop the
    // character hints in production while a loose mock stayed green.
    expect(getSeriesCanonMock).toHaveBeenCalledWith(seriesFixture.get('ser-1'));
  });

  it('returns no-content when the issue has no drafted prose/script', async () => {
    issuesFixture.set('iss-2', makeIssue('iss-2', { prose: '' }));
    const res = await svc.analyzeIssue('iss-2');
    expect(res.status).toBe('no-content');
    expect(llmCalls).toHaveLength(0);
  });

  it('returns a cached snapshot when content is unchanged, re-runs on force', async () => {
    issuesFixture.set('iss-3', makeIssue('iss-3'));
    llmQueue.push(cannedAnalysis(), cannedAnalysis());

    await svc.analyzeIssue('iss-3');
    const cached = await svc.analyzeIssue('iss-3');
    expect(cached.cached).toBe(true);
    expect(llmCalls).toHaveLength(1);

    await svc.analyzeIssue('iss-3', { force: true });
    expect(llmCalls).toHaveLength(2);
  });
});

describe('getIssueAnalysis', () => {
  it('flags stale when the content hash changes after analysis', async () => {
    issuesFixture.set('iss-4', makeIssue('iss-4', { prose: 'original' }));
    llmQueue.push(cannedAnalysis());
    await svc.analyzeIssue('iss-4');

    const fresh = await svc.getIssueAnalysis('iss-4');
    expect(fresh.stale).toBe(false);

    // Edit the prose — the stored snapshot's hash no longer matches.
    issuesFixture.set('iss-4', makeIssue('iss-4', { prose: 'rewritten' }));
    const stale = await svc.getIssueAnalysis('iss-4');
    expect(stale.stale).toBe(true);
  });

  it('returns null when never analyzed', async () => {
    issuesFixture.set('iss-5', makeIssue('iss-5'));
    expect(await svc.getIssueAnalysis('iss-5')).toBeNull();
  });
});

describe('getSeriesEditorial', () => {
  it('aggregates roadmap, coverage, protagonist, and supporting arcs', async () => {
    issuesFixture.set('iss-a', makeIssue('iss-a', { number: 1, arcPosition: 1 }));
    issuesFixture.set('iss-b', makeIssue('iss-b', { number: 2, arcPosition: 2, prose: 'more' }));
    issuesFixture.set('iss-c', makeIssue('iss-c', { number: 3, arcPosition: 3, prose: '' })); // no content
    llmQueue.push(cannedAnalysis(), cannedAnalysis());
    await svc.analyzeIssue('iss-a');
    await svc.analyzeIssue('iss-b');

    const agg = await svc.getSeriesEditorial('ser-1');
    expect(agg.coverage.total).toBe(3);
    expect(agg.coverage.analyzed).toBe(2);
    expect(agg.coverage.noContent).toBe(1);
    expect(agg.roadmap).toHaveLength(3);

    const analyzed = agg.roadmap.filter((r) => r.analyzed);
    expect(analyzed).toHaveLength(2);
    // reader = valenceToScore(−40) = (−40+100)/2 = 30
    expect(analyzed[0].reader).toBe(30);
    expect(analyzed[0].plot).toBe(80);

    expect(agg.protagonist?.name).toBe('Ada');
    expect(agg.protagonist.isProtagonist).toBe(true);
    const supportingNames = agg.supportingArcs.map((c) => c.name);
    expect(supportingNames).toContain('Bly');
    expect(supportingNames).not.toContain('Ada');
  });

  it('reports zero coverage with empty roadmap entries when nothing is analyzed', async () => {
    issuesFixture.set('iss-x', makeIssue('iss-x'));
    const agg = await svc.getSeriesEditorial('ser-1');
    expect(agg.coverage.analyzed).toBe(0);
    expect(agg.coverage.withContent).toBe(1);
    expect(agg.roadmap[0].analyzed).toBe(false);
    expect(agg.protagonist).toBeNull();
  });

  it('does not crown a character the LLM mostly marked NOT protagonist (net votes)', async () => {
    const cannedWith = (characters) => ({
      sections: [{ label: 'S', primaryEmotion: 'x', tension: 50, valence: 0 }],
      characters,
      rollup: { plotTension: 50, characterProgress: 50, readerValence: 0, readerIntensity: 50, primaryEmotion: 'x', peakTension: 50, cliffhanger: false, oneLine: 'o' },
    });
    issuesFixture.set('iss-1', makeIssue('iss-1', { number: 1, arcPosition: 1 }));
    issuesFixture.set('iss-2', makeIssue('iss-2', { number: 2, arcPosition: 2 }));
    issuesFixture.set('iss-3', makeIssue('iss-3', { number: 3, arcPosition: 3 }));
    issuesFixture.set('iss-4', makeIssue('iss-4', { number: 4, arcPosition: 4 }));
    // Noisy: 1 yes + 2 no (net negative) → must NOT be crowned despite having a yes-vote.
    llmQueue.push(cannedWith([{ name: 'Noisy', isProtagonist: true, arcDirection: 'flat' }]));
    llmQueue.push(cannedWith([{ name: 'Noisy', isProtagonist: false, arcDirection: 'flat' }]));
    llmQueue.push(cannedWith([{ name: 'Noisy', isProtagonist: false, arcDirection: 'flat' }]));
    llmQueue.push(cannedWith([{ name: 'Quiet', isProtagonist: null, arcDirection: 'rising', arcSummary: 'grows' }]));
    await svc.analyzeIssue('iss-1');
    await svc.analyzeIssue('iss-2');
    await svc.analyzeIssue('iss-3');
    await svc.analyzeIssue('iss-4');

    const agg = await svc.getSeriesEditorial('ser-1');
    expect(agg.protagonist?.name).not.toBe('Noisy');
    expect(agg.protagonist?.name).toBe('Quiet'); // falls back to the character with a real arc
  });

  it('counts protagonist votes at most once per issue (no skew from duplicated names)', async () => {
    const cannedWith = (characters) => ({
      sections: [{ label: 'S', primaryEmotion: 'x', tension: 50, valence: 0 }],
      characters,
      rollup: { plotTension: 50, characterProgress: 50, readerValence: 0, readerIntensity: 50, primaryEmotion: 'x', peakTension: 50, cliffhanger: false, oneLine: 'o' },
    });
    issuesFixture.set('iss-1', makeIssue('iss-1', { number: 1, arcPosition: 1 }));
    issuesFixture.set('iss-2', makeIssue('iss-2', { number: 2, arcPosition: 2 }));
    // Dup listed 3× in ONE issue would beat Real (2 issues) if votes weren't deduped.
    llmQueue.push(cannedWith([
      { name: 'Dup', isProtagonist: true, arcDirection: 'rising' },
      { name: 'Dup', isProtagonist: true },
      { name: 'Dup', isProtagonist: true },
      { name: 'Real', isProtagonist: true, arcDirection: 'rising' },
    ]));
    llmQueue.push(cannedWith([{ name: 'Real', isProtagonist: true, arcDirection: 'rising' }]));
    await svc.analyzeIssue('iss-1');
    await svc.analyzeIssue('iss-2');

    const agg = await svc.getSeriesEditorial('ser-1');
    expect(agg.protagonist?.name).toBe('Real');
  });

  it('marks an analyzed issue stale when its content was removed afterward', async () => {
    issuesFixture.set('iss-d', makeIssue('iss-d', { prose: 'draft' }));
    llmQueue.push(cannedAnalysis());
    await svc.analyzeIssue('iss-d');
    // Clear the prose — the snapshot now describes content that no longer exists.
    issuesFixture.set('iss-d', makeIssue('iss-d', { prose: '' }));

    const agg = await svc.getSeriesEditorial('ser-1');
    const entry = agg.roadmap.find((r) => r.issueId === 'iss-d');
    expect(entry.analyzed).toBe(true);
    expect(entry.stale).toBe(true);
    expect(agg.coverage.stale).toBe(1);
  });
});

describe('__testing.valenceToScore', () => {
  it('maps −100..100 to 0..100', () => {
    expect(svc.__testing.valenceToScore(-100)).toBe(0);
    expect(svc.__testing.valenceToScore(0)).toBe(50);
    expect(svc.__testing.valenceToScore(100)).toBe(100);
  });
});
