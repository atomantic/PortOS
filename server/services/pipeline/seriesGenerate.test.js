import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the three dependencies generateSeriesConcept reaches out to: the universe
// store, the series list, and the LLM runner. We control `runPromptRefineRaw`'s
// returned `content` so we can assert the post-processing (clamps, shape
// validation, name gate) without a real DB or provider.
vi.mock('../universeBuilder.js', () => ({
  getUniverse: vi.fn(),
  joinInfluenceList: (a) => (Array.isArray(a) ? a.filter(Boolean).join(', ') : ''),
  ERR_NOT_FOUND: 'NOT_FOUND',
}));
vi.mock('./series.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, listSeries: vi.fn(async () => []) };
});
vi.mock('./refineHelpers.js', () => ({ runPromptRefineRaw: vi.fn() }));

import { generateSeriesConcept } from './seriesGenerate.js';
import { getUniverse } from '../universeBuilder.js';
import { listSeries } from './series.js';
import { runPromptRefineRaw } from './refineHelpers.js';
import { NAME_MAX, LOGLINE_MAX, PREMISE_MAX } from './series.js';

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

function mockLLM(content, meta = {}) {
  runPromptRefineRaw.mockResolvedValue({
    content,
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
});

describe('generateSeriesConcept', () => {
  it('returns a clean concept with a valid shape', async () => {
    mockLLM({ name: 'Salt Run', logline: 'A child survives.', premise: 'p', shape: 'man-in-hole' });
    const out = await generateSeriesConcept('uni-1');
    expect(out).toMatchObject({
      name: 'Salt Run',
      logline: 'A child survives.',
      premise: 'p',
      shape: 'man-in-hole',
      rationale: 'fits the world',
      providerId: 'p1',
      model: 'm1',
    });
  });

  it('drops an unrecognized story shape to null', async () => {
    mockLLM({ name: 'X', logline: 'l', premise: 'p', shape: 'not-a-real-shape' });
    const out = await generateSeriesConcept('uni-1');
    expect(out.shape).toBeNull();
  });

  it('clamps overlong fields to their series caps', async () => {
    mockLLM({
      name: 'N'.repeat(NAME_MAX + 50),
      logline: 'L'.repeat(LOGLINE_MAX + 50),
      premise: 'P'.repeat(PREMISE_MAX + 50),
      shape: 'tragedy',
    });
    const out = await generateSeriesConcept('uni-1');
    expect(out.name).toHaveLength(NAME_MAX);
    expect(out.logline).toHaveLength(LOGLINE_MAX);
    expect(out.premise).toHaveLength(PREMISE_MAX);
  });

  it('coerces non-string logline/premise to empty strings', async () => {
    mockLLM({ name: 'OK', logline: 42, premise: { a: 1 }, shape: null });
    const out = await generateSeriesConcept('uni-1');
    expect(out.logline).toBe('');
    expect(out.premise).toBe('');
    expect(out.shape).toBeNull();
  });

  it('throws PIPELINE_SERIES_CONCEPT_EMPTY when the name is missing', async () => {
    // The empty-name gate runs inside the validateContent hook we pass to
    // runPromptRefineRaw — invoke it the way the real runner would.
    runPromptRefineRaw.mockImplementation(async ({ validateContent }) => {
      validateContent({ logline: 'l', premise: 'p' });
      return { content: { logline: 'l', premise: 'p' }, rationale: '', runId: 'r', providerId: 'p', model: 'm' };
    });
    await expect(generateSeriesConcept('uni-1')).rejects.toMatchObject({
      code: 'PIPELINE_SERIES_CONCEPT_EMPTY',
    });
  });

  it('renders slugline-only places (no name) into the canon context', async () => {
    getUniverse.mockResolvedValue({
      ...baseUniverse,
      places: [{ slugline: 'INT. FOUNDRY — NIGHT' }, { name: 'The Docks', role: 'port' }],
    });
    mockLLM({ name: 'X', logline: 'l', premise: 'p', shape: 'tragedy' });
    await generateSeriesConcept('uni-1');
    const call = runPromptRefineRaw.mock.calls[0][0];
    expect(call.variables.places).toContain('INT. FOUNDRY — NIGHT');
    expect(call.variables.places).toContain('The Docks — port');
  });

  it('maps a missing universe to a 404 (not a 500)', async () => {
    getUniverse.mockRejectedValue(Object.assign(new Error('Universe not found: uni-x'), { code: 'NOT_FOUND' }));
    await expect(generateSeriesConcept('uni-x')).rejects.toMatchObject({
      status: 404,
      code: 'PIPELINE_SERIES_CONCEPT_UNIVERSE_NOT_FOUND',
    });
    // The LLM must never be invoked when the seed universe is missing.
    expect(runPromptRefineRaw).not.toHaveBeenCalled();
  });

  it('propagates a listSeries storage failure instead of swallowing it', async () => {
    listSeries.mockRejectedValue(new Error('db unavailable'));
    await expect(generateSeriesConcept('uni-1')).rejects.toThrow('db unavailable');
    // No generation off an incomplete duplicate-avoidance brief.
    expect(runPromptRefineRaw).not.toHaveBeenCalled();
  });

  it('passes the universe and existing-series context into the prompt', async () => {
    listSeries.mockResolvedValue([
      { id: 'ser-a', universeId: 'uni-1', name: 'First Tale', logline: 'an old story' },
      { id: 'ser-b', universeId: 'uni-other', name: 'Elsewhere', logline: 'different world' },
    ]);
    mockLLM({ name: 'Fresh', logline: 'l', premise: 'p', shape: 'icarus' });
    await generateSeriesConcept('uni-1');
    const call = runPromptRefineRaw.mock.calls[0][0];
    expect(call.templateName).toBe('pipeline-series-generate');
    expect(call.variables.universe.name).toBe('Saltworks');
    expect(call.variables.characters).toContain('Ash — survivor');
    expect(call.variables.places).toContain('The Foundry');
    // Only the same-universe series is listed; the other-universe one is excluded.
    expect(call.variables.existingSeries).toContain('First Tale');
    expect(call.variables.existingSeries).not.toContain('Elsewhere');
  });
});
