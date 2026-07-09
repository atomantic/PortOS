import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory doc store mirroring atomicWrite(JSON.stringify) + tryReadFile(string).
const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn(async () => {}),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, JSON.stringify(data)); }),
  tryReadFile: vi.fn(async (path) => (fileStore.has(path) ? fileStore.get(path) : null)),
  safeJSONParse: (str, fallback) => { try { return JSON.parse(str); } catch { return fallback; } },
}));

// runStagedLLM dispatches by stage: rewrite stage returns text, analysis stage
// returns the next queued JSON object.
const analysisQueue = [];
const llmCalls = [];
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(async (stage, ctx) => {
    llmCalls.push({ stage, ctx });
    if (stage === 'pipeline-pov-rewrite') {
      return { content: `REWRITE[${ctx.povCharacter.name}]`, model: 'm', providerId: 'p', runId: 'run-rw' };
    }
    return { content: analysisQueue.shift(), model: 'm', providerId: 'p', runId: 'run-an' };
  }),
  resolveStageContext: vi.fn(async () => ({ contextWindow: 1_000_000 })),
}));

const issuesFixture = new Map();
const seriesFixture = new Map();

vi.mock('./issues.js', () => ({
  getIssue: vi.fn(async (id) => {
    const i = issuesFixture.get(id);
    if (!i) throw new Error(`Issue not found: ${id}`);
    return i;
  }),
}));

vi.mock('./series.js', () => ({
  getSeries: vi.fn(async (id) => {
    const s = seriesFixture.get(id);
    if (!s) throw new Error(`Series not found: ${id}`);
    return s;
  }),
}));

let canonChars = [];
vi.mock('./seriesCanon.js', () => ({
  getSeriesCanon: vi.fn(async () => ({ characters: canonChars })),
}));

const svc = await import('./perspectiveRewrite.js');

const seedIssue = (over = {}) => {
  const issue = {
    id: 'iss-1',
    seriesId: 'ser-1',
    number: 3,
    title: 'The Reckoning',
    stages: { prose: { output: 'Original prose passage.', status: 'ready' } },
    ...over,
  };
  issuesFixture.set(issue.id, issue);
  seriesFixture.set('ser-1', { id: 'ser-1', name: 'Test Series', universeId: 'uni-1' });
  return issue;
};

beforeEach(() => {
  fileStore.clear();
  analysisQueue.length = 0;
  llmCalls.length = 0;
  issuesFixture.clear();
  seriesFixture.clear();
  canonChars = [
    { id: 'char-ada', name: 'Ada', role: 'protagonist', personality: 'driven', physicalDescription: 'tall' },
    { id: 'char-bly', name: 'Bly', role: 'rival' },
  ];
});

describe('sanitizeAnalysis', () => {
  it('clamps, defaults, and caps untrusted model output', () => {
    const out = svc.__testing.sanitizeAnalysis({
      newInformation: ['a', '', 123, 'b'],
      hiddenInformation: 'not-an-array',
      arcStrength: { score: 250, strongerThanOriginal: 'yes', rationale: 7 },
      foldBackSuggestions: [{ suggestion: 'do x', rationale: 'because' }, { rationale: 'no suggestion' }, 'bad'],
      povJustification: 'switch POV',
      oneLine: 'a line',
    });
    expect(out.newInformation).toEqual(['a', 'b']);
    expect(out.hiddenInformation).toEqual([]);
    expect(out.arcStrength.score).toBe(100);
    expect(out.arcStrength.strongerThanOriginal).toBe(false); // only literal true counts
    expect(out.arcStrength.rationale).toBe('');
    expect(out.foldBackSuggestions).toEqual([{ suggestion: 'do x', rationale: 'because' }]);
    expect(out.povJustification).toBe('switch POV');
    expect(out.oneLine).toBe('a line');
  });

  it('tolerates a non-object', () => {
    const out = svc.__testing.sanitizeAnalysis(null);
    expect(out.newInformation).toEqual([]);
    expect(out.arcStrength.score).toBe(0);
  });
});

describe('generatePerspectiveRewrite', () => {
  it('runs both stages and stores a non-destructive artifact (original untouched)', async () => {
    const issue = seedIssue();
    analysisQueue.push({ newInformation: ['Ada fears failure'], oneLine: 'tense' });

    const result = await svc.generatePerspectiveRewrite('iss-1', { povCharacterId: 'char-ada' });

    expect(result.status).toBe('complete');
    expect(result.rewrite.povCharacterName).toBe('Ada');
    expect(result.rewrite.rewrite).toBe('REWRITE[Ada]');
    expect(result.rewrite.analysis.newInformation).toEqual(['Ada fears failure']);
    // both stages invoked, rewrite before analysis
    expect(llmCalls.map((c) => c.stage)).toEqual(['pipeline-pov-rewrite', 'pipeline-pov-analysis']);
    // canonical prose untouched
    expect(issue.stages.prose.output).toBe('Original prose passage.');

    // persisted + readable
    const read = await svc.getPerspectiveRewrites('iss-1');
    expect(read.rewrites).toHaveLength(1);
    expect(read.rewrites[0].id).toBe(result.rewrite.id);
    expect(read.cast.map((c) => c.id)).toEqual(['char-ada', 'char-bly']);
    // cast on the wire is stripped of the heavy descriptor
    expect(read.cast[0].descriptor).toBeUndefined();
  });

  it('returns no-content when the issue has no drafted passage', async () => {
    seedIssue({ stages: {} });
    const result = await svc.generatePerspectiveRewrite('iss-1', { povCharacterId: 'char-ada' });
    expect(result.status).toBe('no-content');
    expect(llmCalls).toHaveLength(0);
  });

  it('returns unknown-character for an off-roster POV id', async () => {
    seedIssue();
    const result = await svc.generatePerspectiveRewrite('iss-1', { povCharacterId: 'char-ghost' });
    expect(result.status).toBe('unknown-character');
  });

  it('exempts a reveal-gated POV character from gating even when selected by NAME (#2178)', async () => {
    // Ada is reveal-gated to a later issue than this one (#3), so without the
    // name-form exemption she'd be surfaced/dropped and a name-form POV request
    // would either return unknown-character or lose her full private canon.
    canonChars = [
      { id: 'char-ada', name: 'Ada', role: 'protagonist', personality: 'driven', physicalDescription: 'tall', revealIssue: 8, surfaceDescriptor: 'a quiet stranger' },
      { id: 'char-bly', name: 'Bly', role: 'rival', revealIssue: 8 },
    ];
    seedIssue();
    analysisQueue.push({ oneLine: 'tense' });

    const result = await svc.generatePerspectiveRewrite('iss-1', { povCharacterId: 'Ada' });

    expect(result.status).toBe('complete');
    expect(result.rewrite.povCharacterName).toBe('Ada');
    // The POV narrator keeps her full private canon: the rewrite prompt's
    // povCharacter descriptor still carries her personality (which a surfaced
    // view would strip). Without the name-form exemption this request would
    // have returned unknown-character or lost this private context.
    const povCtx = llmCalls.find((c) => c.stage === 'pipeline-pov-rewrite').ctx.povCharacter;
    expect(povCtx.name).toBe('Ada');
    expect(povCtx.descriptor).toContain('Personality: driven');
    // The prompt's rendered cast roster (gated to this issue) keeps the full POV
    // narrator but reduces Bly (gated, no surfaceDescriptor, not the POV) — she is
    // dropped, so her name doesn't appear in the drafting roster.
    const roster = llmCalls.find((c) => c.stage === 'pipeline-pov-rewrite').ctx.series.characters;
    expect(roster.map((c) => c.name)).toContain('Ada');
    expect(roster.map((c) => c.name)).not.toContain('Bly');
  });

  it('caps stored rewrites and keeps newest first', async () => {
    seedIssue();
    for (let i = 0; i < 14; i++) {
      analysisQueue.push({ oneLine: `run ${i}` });
      await svc.generatePerspectiveRewrite('iss-1', { povCharacterId: i % 2 ? 'char-bly' : 'char-ada' });
    }
    const read = await svc.getPerspectiveRewrites('iss-1');
    expect(read.rewrites.length).toBeLessThanOrEqual(12);
    // newest is last generated (povCharacterId for i=13 is char-bly)
    expect(read.rewrites[0].povCharacterName).toBe('Bly');
  });
});

describe('staleness', () => {
  it('flags a rewrite stale once the source draft changes', async () => {
    const issue = seedIssue();
    analysisQueue.push({ oneLine: 'x' });
    await svc.generatePerspectiveRewrite('iss-1', { povCharacterId: 'char-ada' });

    let read = await svc.getPerspectiveRewrites('iss-1');
    expect(read.rewrites[0].stale).toBe(false);

    issue.stages.prose.output = 'Edited prose passage — different now.';
    read = await svc.getPerspectiveRewrites('iss-1');
    expect(read.rewrites[0].stale).toBe(true);
  });
});

describe('deletePerspectiveRewrite', () => {
  it('removes a stored artifact, no-ops on unknown id', async () => {
    seedIssue();
    analysisQueue.push({ oneLine: 'x' });
    const { rewrite } = await svc.generatePerspectiveRewrite('iss-1', { povCharacterId: 'char-ada' });

    expect((await svc.deletePerspectiveRewrite('iss-1', 'nope')).removed).toBe(false);
    expect((await svc.deletePerspectiveRewrite('iss-1', rewrite.id)).removed).toBe(true);
    const read = await svc.getPerspectiveRewrites('iss-1');
    expect(read.rewrites).toHaveLength(0);
  });
});
