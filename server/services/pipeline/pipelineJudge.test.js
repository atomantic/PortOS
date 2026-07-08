import { describe, it, expect, vi, beforeEach } from 'vitest';

// I/O is the only thing mocked in fileUtils — PATHS/safeJSONParse stay real so
// the snapshot round-trip logic runs against the actual parser.
vi.mock('../../lib/fileUtils.js', async (importActual) => ({
  ...(await importActual()),
  tryReadFile: vi.fn(async () => null),
  atomicWrite: vi.fn(async () => {}),
  ensureDir: vi.fn(async () => {}),
}));

vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  resolveStageContext: vi.fn(async () => ({ contextWindow: 200_000 })),
  resolveJudgeForStage: vi.fn(async () => ({ provider: { id: 'judge-x' }, model: 'jm-heavy' })),
}));

vi.mock('../promptService.js', () => ({ getStage: vi.fn(() => ({ name: 'writer' })) }));
vi.mock('../universeBuilder.js', () => ({ getUniverse: vi.fn(async () => null) }));
vi.mock('./issues.js', async (importActual) => ({
  ...(await importActual()),
  getIssue: vi.fn(),
  listIssues: vi.fn(async () => []),
}));
vi.mock('./series.js', async (importActual) => ({
  ...(await importActual()),
  getSeries: vi.fn(async () => ({ name: 'S', logline: 'L', premise: 'P' })),
}));
vi.mock('./seriesCanon.js', async (importActual) => ({
  ...(await importActual()),
  getSeriesCanon: vi.fn(async () => ({ characters: [] })),
}));

const fileUtils = await import('../../lib/fileUtils.js');
const stageRunner = await import('../../lib/stageRunner.js');
const issuesSvc = await import('./issues.js');
const { computeSlopPenalty } = await import('../../lib/editorial/slopScore.js');
const {
  judgeIssue,
  getIssueJudge,
  getSeriesJudge,
  computeQualityScore,
  sanitizeJudge,
  isValidJudgeShape,
  pickJudgeContent,
  JUDGE_DIMENSIONS,
  __testing,
} = await import('./pipelineJudge.js');

const dims = (score = 6) => Object.fromEntries(
  JUDGE_DIMENSIONS.map((k) => [k, { score, weakestMoment: `weak ${k}`, fix: `fix ${k}` }]),
);

const validJudge = (overall = 7) => ({
  overall,
  dimensions: dims(6),
  strongestSentences: ['a', 'b', 'c'],
  weakestSentences: ['x', 'y', 'z'],
  sceneVsSummaryRatio: 0.7,
  topRevisions: ['r1', 'r2', 'r3'],
  oneLineVerdict: 'needs tightening',
});

const proseIssue = (text = 'The team opens the door. Rain falls hard on the roof.') => ({
  id: 'iss-abc',
  seriesId: 'ser-1',
  number: 3,
  title: 'The Reckoning',
  stages: { idea: { output: '## Scenes\n1. Open' }, prose: { output: text } },
});

beforeEach(() => {
  vi.clearAllMocks();
  fileUtils.tryReadFile.mockResolvedValue(null);
  stageRunner.resolveStageContext.mockResolvedValue({ contextWindow: 200_000 });
  stageRunner.resolveJudgeForStage.mockResolvedValue({ provider: { id: 'judge-x' }, model: 'jm-heavy' });
});

describe('computeQualityScore — composite math', () => {
  it('subtracts the slop penalty from the judge overall', () => {
    expect(computeQualityScore(8, 2)).toBe(6);
    expect(computeQualityScore(7.5, 1.25)).toBe(6.25);
  });
  it('clamps to >= 0 (slop cannot drive a negative score)', () => {
    expect(computeQualityScore(3, 9)).toBe(0);
  });
  it('clamps to <= 10', () => {
    expect(computeQualityScore(12, 0)).toBe(10);
  });
  it('treats non-finite terms as 0 (never NaN-poisons)', () => {
    expect(computeQualityScore(undefined, 2)).toBe(0);
    expect(computeQualityScore(6, NaN)).toBe(6);
    expect(computeQualityScore('x', 'y')).toBe(0);
  });
});

describe('isValidJudgeShape — retry gate', () => {
  it('accepts a response carrying the dimensions rubric', () => {
    expect(isValidJudgeShape(validJudge())).toBe(true);
  });
  it('rejects JSON that parsed but omits dimensions', () => {
    expect(isValidJudgeShape({ overall: 7 })).toBe(false);
    expect(isValidJudgeShape(null)).toBe(false);
    expect(isValidJudgeShape('not an object')).toBe(false);
  });
});

describe('sanitizeJudge — defensive shape', () => {
  it('fills every rubric dimension with clamped scores + capped strings', () => {
    const out = sanitizeJudge(validJudge(9));
    expect(Object.keys(out.dimensions).sort()).toEqual([...JUDGE_DIMENSIONS].sort());
    expect(out.overall).toBe(9);
    expect(out.dimensions.proseQuality.score).toBe(6);
  });
  it('defaults a missing dimension to a zeroed entry', () => {
    const raw = validJudge();
    delete raw.dimensions.engagement;
    const out = sanitizeJudge(raw);
    expect(out.dimensions.engagement).toEqual({ score: 0, weakestMoment: '', fix: '' });
  });
  it('clamps sceneVsSummaryRatio into [0,1] and caps sentence/revision lists at 3', () => {
    const out = sanitizeJudge({
      ...validJudge(),
      sceneVsSummaryRatio: 1.8,
      strongestSentences: ['1', '2', '3', '4', '5'],
      topRevisions: ['a', 'b', 'c', 'd'],
    });
    expect(out.sceneVsSummaryRatio).toBe(1);
    expect(out.strongestSentences).toHaveLength(3);
    expect(out.topRevisions).toHaveLength(3);
  });
  it('nulls a non-numeric sceneVsSummaryRatio', () => {
    expect(sanitizeJudge({ ...validJudge(), sceneVsSummaryRatio: 'lots' }).sceneVsSummaryRatio).toBeNull();
  });
  it('clamps out-of-range dimension scores to [0,10]', () => {
    const out = sanitizeJudge({ dimensions: { voiceAdherence: { score: 42 } } });
    expect(out.dimensions.voiceAdherence.score).toBe(10);
  });
});

describe('pickJudgeContent', () => {
  it('prefers prose when no stageId is given', () => {
    expect(pickJudgeContent(proseIssue('hello')).sourceStage).toBe('prose');
  });
  it('honors an explicit stageId', () => {
    const iss = { stages: { comicScript: { output: 'PANEL 1' }, prose: { output: 'p' } } };
    expect(pickJudgeContent(iss, 'comicScript')).toEqual({ text: 'PANEL 1', sourceStage: 'comicScript' });
  });
  it('returns null when the requested stage is empty', () => {
    expect(pickJudgeContent({ stages: {} }, 'prose')).toBeNull();
  });
});

describe('isSnapshotStale — content-hash staleness pinning', () => {
  const { isSnapshotStale, contentHash } = __testing;
  it('is fresh when the current content still hashes to the pinned value', () => {
    const iss = proseIssue('same text');
    const snap = { status: 'complete', stageId: 'prose', sourceContentHash: contentHash('same text') };
    expect(isSnapshotStale(snap, iss)).toBe(false);
  });
  it('is stale when the draft changed since judging', () => {
    const iss = proseIssue('edited text');
    const snap = { status: 'complete', stageId: 'prose', sourceContentHash: contentHash('original text') };
    expect(isSnapshotStale(snap, iss)).toBe(true);
  });
  it('is stale when the draft was cleared after judging', () => {
    const snap = { status: 'complete', stageId: 'prose', sourceContentHash: contentHash('gone') };
    expect(isSnapshotStale(snap, { stages: {} })).toBe(true);
  });
  it('treats a legacy snapshot with no hash as not-stale', () => {
    const snap = { status: 'complete', stageId: 'prose' };
    expect(isSnapshotStale(snap, proseIssue('whatever'))).toBe(false);
  });
});

describe('judgeIssue — end to end', () => {
  it('persists a snapshot with qualityScore = overall − slopPenalty', async () => {
    const iss = proseIssue('Clean present-tense prose with varied rhythm and no tells.');
    issuesSvc.getIssue.mockResolvedValue(iss);
    stageRunner.runStagedLLM.mockResolvedValue({ content: validJudge(7), providerId: 'judge-x', model: 'jm-heavy', runId: 'run-1' });

    const snap = await judgeIssue('iss-abc');
    expect(snap.status).toBe('complete');
    expect(snap.overall).toBe(7);
    expect(snap.slopPenalty).toBe(computeSlopPenalty(iss.stages.prose.output));
    expect(snap.qualityScore).toBe(computeQualityScore(7, snap.slopPenalty));
    expect(snap.judgeProviderId).toBe('judge-x');
    expect(fileUtils.atomicWrite).toHaveBeenCalledOnce();
  });

  it('retries once when the first judge response rejects (malformed JSON)', async () => {
    issuesSvc.getIssue.mockResolvedValue(proseIssue());
    stageRunner.runStagedLLM
      .mockRejectedValueOnce(new Error('Invalid JSON in AI response'))
      .mockResolvedValueOnce({ content: validJudge(6), providerId: 'judge-x', model: 'jm', runId: 'run-2' });

    const snap = await judgeIssue('iss-abc');
    expect(stageRunner.runStagedLLM).toHaveBeenCalledTimes(2);
    expect(snap.overall).toBe(6);
  });

  it('retries once when the first response parses but omits the rubric', async () => {
    issuesSvc.getIssue.mockResolvedValue(proseIssue());
    stageRunner.runStagedLLM
      .mockResolvedValueOnce({ content: { overall: 8 }, providerId: 'judge-x', runId: 'r' })
      .mockResolvedValueOnce({ content: validJudge(5), providerId: 'judge-x', runId: 'run-3' });

    const snap = await judgeIssue('iss-abc');
    expect(stageRunner.runStagedLLM).toHaveBeenCalledTimes(2);
    expect(snap.overall).toBe(5);
  });

  it('throws after two malformed attempts', async () => {
    issuesSvc.getIssue.mockResolvedValue(proseIssue());
    stageRunner.runStagedLLM.mockResolvedValue({ content: { no: 'rubric' }, providerId: 'p', runId: 'r' });
    await expect(judgeIssue('iss-abc')).rejects.toThrow(/dimensions/);
    expect(stageRunner.runStagedLLM).toHaveBeenCalledTimes(2);
  });

  it('returns a no-content marker when the issue has no drafted stages', async () => {
    issuesSvc.getIssue.mockResolvedValue({ id: 'iss-abc', seriesId: 'ser-1', stages: {} });
    const out = await judgeIssue('iss-abc');
    expect(out.status).toBe('no-content');
    expect(stageRunner.runStagedLLM).not.toHaveBeenCalled();
  });

  it('returns the cached snapshot when content is unchanged and !force', async () => {
    const iss = proseIssue('stable');
    issuesSvc.getIssue.mockResolvedValue(iss);
    fileUtils.tryReadFile.mockResolvedValue(JSON.stringify({
      issueId: 'iss-abc', status: 'complete', stageId: 'prose',
      sourceContentHash: __testing.contentHash('stable'), overall: 6, qualityScore: 6,
    }));
    const out = await judgeIssue('iss-abc');
    expect(out.cached).toBe(true);
    expect(stageRunner.runStagedLLM).not.toHaveBeenCalled();
  });

  it('rejects a path-traversal-shaped issue id', async () => {
    await expect(judgeIssue('../etc/passwd')).rejects.toThrow(/Invalid issue id/);
  });
});

describe('getSeriesJudge — weakest-first ranking', () => {
  it('sorts judged issues ascending by qualityScore and reports coverage', async () => {
    const issues = [
      { id: 'iss-1', number: 1, title: 'One', stages: { prose: { output: 'p1' } } },
      { id: 'iss-2', number: 2, title: 'Two', stages: { prose: { output: 'p2' } } },
      { id: 'iss-3', number: 3, title: 'Three', stages: {} },
    ];
    const h = __testing.contentHash;
    const snapById = {
      'iss-1': { status: 'complete', stageId: 'prose', qualityScore: 8, overall: 8, sourceContentHash: h('p1') },
      'iss-2': { status: 'complete', stageId: 'prose', qualityScore: 3, overall: 4, sourceContentHash: h('p2') },
      'iss-3': null,
    };
    issuesSvc.getIssue.mockImplementation(async (id) => issues.find((i) => i.id === id));
    fileUtils.tryReadFile.mockImplementation(async (p) => {
      const id = Object.keys(snapById).find((k) => p.includes(k));
      return snapById[id] ? JSON.stringify(snapById[id]) : null;
    });

    const out = await getSeriesJudge('ser-1', { issues });
    expect(out.coverage).toEqual({ judged: 2, total: 3, stale: 0 });
    expect(out.weakest.map((w) => w.issueId)).toEqual(['iss-2', 'iss-1']);
  });
});

describe('getIssueJudge', () => {
  it('returns null when the issue was never judged', async () => {
    fileUtils.tryReadFile.mockResolvedValue(null);
    expect(await getIssueJudge('iss-abc')).toBeNull();
  });
  it('stamps a stale flag when the draft changed', async () => {
    issuesSvc.getIssue.mockResolvedValue(proseIssue('new draft'));
    fileUtils.tryReadFile.mockResolvedValue(JSON.stringify({
      issueId: 'iss-abc', status: 'complete', stageId: 'prose',
      sourceContentHash: __testing.contentHash('old draft'), overall: 6, qualityScore: 6,
    }));
    const out = await getIssueJudge('iss-abc');
    expect(out.stale).toBe(true);
  });
});
