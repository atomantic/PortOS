import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies the generator reaches out to: the universe store, the
// series list, the refine runner, and (for judge-pick) the stage runner +
// prompt service. We control the LLM content so we can assert post-processing
// (candidate normalization, banlist merge, judge pick + fallback) without a real
// DB or provider.
vi.mock('../universeBuilder.js', () => ({
  getUniverse: vi.fn(),
  joinInfluenceList: (a) => (Array.isArray(a) ? a.filter((t) => typeof t === 'string' && t.trim()).join(', ') : ''),
  ERR_NOT_FOUND: 'NOT_FOUND',
}));
vi.mock('./series.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listSeries: vi.fn(async () => []) };
});
vi.mock('./refineHelpers.js', () => ({ runPromptRefineRaw: vi.fn() }));
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  resolveJudgeForStage: vi.fn(),
}));
vi.mock('../promptService.js', () => ({ getStage: vi.fn(() => ({ judgeProvider: null })) }));

import {
  generateSeriesConcept,
  generateSeriesConcepts,
  judgePickConcept,
  parseConceptPick,
  mergeAntiGenericBanlist,
  clampCandidateCount,
  ANTI_GENERIC_BANLIST,
  CANDIDATE_COUNT_DEFAULT,
  CANDIDATE_COUNT_MAX,
  CANDIDATE_COUNT_MIN,
} from './seriesGenerate.js';
import { getUniverse } from '../universeBuilder.js';
import { listSeries, NAME_MAX, LOGLINE_MAX, PREMISE_MAX } from './series.js';
import { runPromptRefineRaw } from './refineHelpers.js';
import { runStagedLLM, resolveJudgeForStage } from '../../lib/stageRunner.js';

const baseUniverse = {
  id: 'uni-1',
  name: 'Saltworks',
  premise: 'A foundry world.',
  logline: 'Metal and salt.',
  styleNotes: 'gritty',
  influences: { embrace: ['noir'], avoid: ['camp'] },
  characters: [{ name: 'Ash', role: 'survivor' }],
  places: [{ name: 'The Foundry' }],
  objects: [],
};

const candidate = (over = {}) => ({
  name: 'Salt Run', logline: 'A child survives.', premise: 'p', shape: 'man-in-hole',
  hook: 'a hook', world: 'new world', conflictEngine: 'ongoing pressure',
  cost: 'a price', tension: 'personal vs cosmic', theme: 'survival', ...over,
});

// runPromptRefineRaw returns the concept-generation content. `candidates` is the
// array the multi-concept prompt emits.
function mockGen(candidates, meta = {}) {
  runPromptRefineRaw.mockResolvedValue({
    content: { candidates },
    rationale: meta.rationale || 'fits the world',
    runId: 'run-1',
    providerId: 'p1',
    model: 'm1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUniverse.mockResolvedValue(baseUniverse);
  listSeries.mockResolvedValue([]);
  // Default judge: resolves to a provider and forced-picks concept #1.
  resolveJudgeForStage.mockResolvedValue({ provider: { id: 'jp' }, model: 'jm' });
  runStagedLLM.mockResolvedValue({ content: { pick: 1, ranking: [1], rationale: 'winner' } });
});

describe('clampCandidateCount', () => {
  it('defaults when absent or non-numeric', () => {
    expect(clampCandidateCount(undefined)).toBe(CANDIDATE_COUNT_DEFAULT);
    expect(clampCandidateCount(null)).toBe(CANDIDATE_COUNT_DEFAULT);
    expect(clampCandidateCount('nope')).toBe(CANDIDATE_COUNT_DEFAULT);
  });
  it('clamps into [MIN, MAX]', () => {
    expect(clampCandidateCount(1)).toBe(CANDIDATE_COUNT_MIN);
    expect(clampCandidateCount(999)).toBe(CANDIDATE_COUNT_MAX);
    expect(clampCandidateCount(4)).toBe(4);
  });
});

describe('mergeAntiGenericBanlist', () => {
  it('merges the shipped default list with the universe avoid-influences', () => {
    const merged = mergeAntiGenericBanlist({ influences: { avoid: ['camp', 'grimdark'] } });
    expect(merged).toEqual(expect.arrayContaining(ANTI_GENERIC_BANLIST));
    expect(merged).toContain('camp');
    expect(merged).toContain('grimdark');
    expect(merged.length).toBe(ANTI_GENERIC_BANLIST.length + 2);
  });
  it('dedupes case-insensitively and tolerates a missing avoid list', () => {
    const dupe = ANTI_GENERIC_BANLIST[0].toUpperCase();
    const merged = mergeAntiGenericBanlist({ influences: { avoid: [dupe, '  ', 42] } });
    // The duplicate (case-folded) + the blank + the non-string are all dropped.
    expect(merged.length).toBe(ANTI_GENERIC_BANLIST.length);
    expect(mergeAntiGenericBanlist(null)).toEqual([...ANTI_GENERIC_BANLIST]);
    expect(mergeAntiGenericBanlist({})).toEqual([...ANTI_GENERIC_BANLIST]);
  });
});

describe('parseConceptPick', () => {
  it('maps a 1-based pick to a 0-based index and completes the ranking', () => {
    const out = parseConceptPick({ pick: 2, ranking: [2, 3], rationale: 'r' }, 3);
    expect(out.index).toBe(1);
    // winner leads; every candidate index appears once.
    expect(out.ranking).toEqual([1, 2, 0]);
    expect(out.rationale).toBe('r');
  });
  it('returns null for a missing / out-of-range pick (fallback signal)', () => {
    expect(parseConceptPick({ ranking: [1] }, 3)).toBeNull();
    expect(parseConceptPick({ pick: 0 }, 3)).toBeNull();
    expect(parseConceptPick({ pick: 4 }, 3)).toBeNull();
    expect(parseConceptPick(null, 3)).toBeNull();
    expect(parseConceptPick('nope', 3)).toBeNull();
  });
});

describe('generateSeriesConcepts (interactive / user pick)', () => {
  it('returns all normalized candidates + the merged banlist', async () => {
    mockGen([candidate({ name: 'A' }), candidate({ name: 'B', shape: 'tragedy' })]);
    const out = await generateSeriesConcepts('uni-1');
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0]).toMatchObject({ name: 'A', shape: 'man-in-hole', hook: 'a hook' });
    expect(out.candidates[1].shape).toBe('tragedy');
    expect(out.banlist).toEqual(expect.arrayContaining(ANTI_GENERIC_BANLIST));
    // The universe avoid-influence is merged into the banlist.
    expect(out.banlist).toContain('camp');
    expect(out.providerId).toBe('p1');
  });

  it('passes count + rendered banlist into the prompt variables', async () => {
    mockGen([candidate()]);
    await generateSeriesConcepts('uni-1', { count: 3 });
    const call = runPromptRefineRaw.mock.calls[0][0];
    expect(call.templateName).toBe('pipeline-series-generate');
    expect(call.variables.count).toBe(3);
    expect(call.variables.banlist).toContain('chosen one');
    expect(call.variables.banlist).toContain('camp');
    expect(call.variables.universe.name).toBe('Saltworks');
    expect(call.variables.characters).toContain('Ash — survivor');
  });

  it('drops candidates with no name and clamps overlong fields', async () => {
    mockGen([
      { logline: 'no name here' },
      candidate({
        name: 'N'.repeat(NAME_MAX + 50),
        logline: 'L'.repeat(LOGLINE_MAX + 50),
        premise: 'P'.repeat(PREMISE_MAX + 50),
      }),
    ]);
    const out = await generateSeriesConcepts('uni-1');
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].name).toHaveLength(NAME_MAX);
    expect(out.candidates[0].logline).toHaveLength(LOGLINE_MAX);
    expect(out.candidates[0].premise).toHaveLength(PREMISE_MAX);
  });

  it('drops an unrecognized story shape to null', async () => {
    mockGen([candidate({ shape: 'not-a-real-shape' })]);
    const out = await generateSeriesConcepts('uni-1');
    expect(out.candidates[0].shape).toBeNull();
  });

  it('throws PIPELINE_SERIES_CONCEPT_EMPTY when no candidates array is present', async () => {
    runPromptRefineRaw.mockImplementation(async ({ validateContent }) => {
      validateContent({ notCandidates: true });
      return { content: {}, rationale: '', runId: 'r', providerId: 'p', model: 'm' };
    });
    await expect(generateSeriesConcepts('uni-1')).rejects.toMatchObject({
      code: 'PIPELINE_SERIES_CONCEPT_EMPTY',
    });
  });

  it('throws PIPELINE_SERIES_CONCEPT_EMPTY when every candidate is unusable', async () => {
    mockGen([{ logline: 'no name' }, { name: '' }]);
    await expect(generateSeriesConcepts('uni-1')).rejects.toMatchObject({
      code: 'PIPELINE_SERIES_CONCEPT_EMPTY',
    });
  });

  it('maps a missing universe to a 404 (not a 500) without calling the LLM', async () => {
    getUniverse.mockRejectedValue(Object.assign(new Error('nope'), { code: 'NOT_FOUND' }));
    await expect(generateSeriesConcepts('uni-x')).rejects.toMatchObject({
      status: 404, code: 'PIPELINE_SERIES_CONCEPT_UNIVERSE_NOT_FOUND',
    });
    expect(runPromptRefineRaw).not.toHaveBeenCalled();
  });

  it('propagates a listSeries storage failure instead of swallowing it', async () => {
    listSeries.mockRejectedValue(new Error('db unavailable'));
    await expect(generateSeriesConcepts('uni-1')).rejects.toThrow('db unavailable');
    expect(runPromptRefineRaw).not.toHaveBeenCalled();
  });
});

describe('judgePickConcept (autonomous / forced rank)', () => {
  it('skips the judge for a single candidate', async () => {
    const out = await judgePickConcept([candidate()], { universe: baseUniverse });
    expect(out).toMatchObject({ index: 0, judged: false });
    expect(resolveJudgeForStage).not.toHaveBeenCalled();
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('picks the judge-selected concept', async () => {
    runStagedLLM.mockResolvedValue({ content: { pick: 2, ranking: [2, 1], rationale: 'B wins' } });
    const out = await judgePickConcept([candidate({ name: 'A' }), candidate({ name: 'B' })], { universe: baseUniverse });
    expect(out).toMatchObject({ index: 1, judged: true, rationale: 'B wins' });
  });

  it('falls back to the first candidate when no judge resolves', async () => {
    resolveJudgeForStage.mockRejectedValue(new Error('no judge provider'));
    const out = await judgePickConcept([candidate({ name: 'A' }), candidate({ name: 'B' })], { universe: baseUniverse });
    expect(out).toMatchObject({ index: 0, judged: false });
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('falls back to the first candidate when the judge call fails', async () => {
    runStagedLLM.mockRejectedValue(new Error('provider down'));
    const out = await judgePickConcept([candidate({ name: 'A' }), candidate({ name: 'B' })], { universe: baseUniverse });
    expect(out).toMatchObject({ index: 0, judged: false });
  });

  it('falls back to the first candidate when the judge pick is unparseable', async () => {
    runStagedLLM.mockResolvedValue({ content: { pick: 'tie' } });
    const out = await judgePickConcept([candidate({ name: 'A' }), candidate({ name: 'B' })], { universe: baseUniverse });
    expect(out).toMatchObject({ index: 0, judged: false });
  });
});

describe('generateSeriesConcept (backward-compatible single concept)', () => {
  it('returns the judge-picked concept in the legacy shape + rejected candidates', async () => {
    mockGen([candidate({ name: 'A' }), candidate({ name: 'B' })]);
    runStagedLLM.mockResolvedValue({ content: { pick: 2, ranking: [2, 1], rationale: 'B wins' } });
    const out = await generateSeriesConcept('uni-1');
    // Legacy fields point at the judge-picked winner (concept #2 = 'B').
    expect(out).toMatchObject({ name: 'B', logline: 'A child survives.', shape: 'man-in-hole' });
    expect(out.rationale).toBe('B wins');
    expect(out.pickIndex).toBe(1);
    expect(out.judged).toBe(true);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].name).toBe('A');
    expect(out.candidates).toHaveLength(2);
  });

  it('returns the only candidate (judge skipped) for a single-concept response', async () => {
    mockGen([candidate({ name: 'Solo' })]);
    const out = await generateSeriesConcept('uni-1');
    expect(out).toMatchObject({ name: 'Solo', shape: 'man-in-hole', judged: false, pickIndex: 0 });
    expect(out.rejected).toHaveLength(0);
    expect(runStagedLLM).not.toHaveBeenCalled();
  });

  it('falls back to the first candidate when the judge fails, keeping the generator rationale', async () => {
    mockGen([candidate({ name: 'First' }), candidate({ name: 'Second' })], { rationale: 'gen rationale' });
    runStagedLLM.mockRejectedValue(new Error('provider down'));
    const out = await generateSeriesConcept('uni-1');
    expect(out).toMatchObject({ name: 'First', pickIndex: 0, judged: false });
    expect(out.rationale).toBe('gen rationale');
  });
});
