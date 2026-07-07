import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the three dependencies discoverSeriesVoice reaches: the series store, the
// universe store, and the LLM runner. We control `runPromptRefineRaw`'s returned
// `content` so we can assert the register normalization / dedupe / ordering
// without a real DB or provider.
vi.mock('./series.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getSeries: vi.fn() };
});
vi.mock('../universeBuilder.js', () => ({
  getUniverse: vi.fn(),
  joinInfluenceList: (a) => (Array.isArray(a) ? a.filter(Boolean).join(', ') : ''),
}));
vi.mock('./refineHelpers.js', () => ({ runPromptRefineRaw: vi.fn() }));

import { discoverSeriesVoice } from './seriesVoiceDiscover.js';
import { getSeries } from './series.js';
import { getUniverse } from '../universeBuilder.js';
import { runPromptRefineRaw } from './refineHelpers.js';
import { VOICE_REGISTER_IDS, STYLE_GUIDE_LIMITS } from '../../lib/styleGuide.js';

const baseSeries = {
  id: 'ser-1',
  name: 'Salt Run',
  logline: 'A child survives the foundry.',
  premise: 'A gritty foundry world.',
  styleNotes: 'noir, sepia',
  universeId: 'uni-1',
  styleGuide: { tense: 'past', tone: ['bleak'] },
};

function mockLLM(candidates, meta = {}) {
  runPromptRefineRaw.mockResolvedValue({
    content: { candidates, rationale: meta.rationale || '' },
    rationale: meta.rationale || 'lean toward spare',
    runId: 'run-1',
    providerId: 'p1',
    model: 'm1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSeries.mockResolvedValue(baseSeries);
  getUniverse.mockResolvedValue({ id: 'uni-1', name: 'Saltworks', premise: 'foundry world', influences: { embrace: ['noir'], avoid: ['camp'] } });
});

describe('discoverSeriesVoice', () => {
  it('returns normalized candidates in canonical register order', async () => {
    // Emit out of canonical order — the service must re-sort to VOICE_REGISTER_IDS.
    mockLLM([
      { register: 'wry', passage: 'A dry line.', note: 'ironic' },
      { register: 'spare', passage: 'Short. Flat.', note: 'lean' },
    ]);
    const out = await discoverSeriesVoice('ser-1');
    expect(out.candidates.map((c) => c.register)).toEqual(['spare', 'wry']);
    expect(out.candidates[0]).toMatchObject({ register: 'spare', label: 'Spare', passage: 'Short. Flat.', note: 'lean' });
    expect(out).toMatchObject({ providerId: 'p1', model: 'm1', rationale: 'lean toward spare' });
  });

  it('drops candidates with an unknown register id', async () => {
    mockLLM([
      { register: 'made-up', passage: 'nope' },
      { register: 'lyric', passage: 'A song of salt.' },
    ]);
    const out = await discoverSeriesVoice('ser-1');
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].register).toBe('lyric');
  });

  it('drops candidates with an empty or non-string passage', async () => {
    mockLLM([
      { register: 'spare', passage: '   ' },
      { register: 'lyric', passage: 42 },
      { register: 'wry', passage: 'Real prose.' },
    ]);
    const out = await discoverSeriesVoice('ser-1');
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].register).toBe('wry');
  });

  it('dedupes a repeated register, keeping the first', async () => {
    mockLLM([
      { register: 'spare', passage: 'First spare.' },
      { register: 'spare', passage: 'Second spare.' },
    ]);
    const out = await discoverSeriesVoice('ser-1');
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].passage).toBe('First spare.');
  });

  it('clamps an overlong passage to the exemplar char cap', async () => {
    mockLLM([{ register: 'spare', passage: 'x'.repeat(STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX + 500) }]);
    const out = await discoverSeriesVoice('ser-1');
    expect(out.candidates[0].passage).toHaveLength(STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX);
  });

  it('omits the note when the LLM gives none', async () => {
    mockLLM([{ register: 'spare', passage: 'No note here.' }]);
    const out = await discoverSeriesVoice('ser-1');
    expect(out.candidates[0]).not.toHaveProperty('note');
  });

  it('throws PIPELINE_VOICE_DISCOVER_EMPTY when candidates is not an array', async () => {
    // The array gate runs inside the validateContent hook we pass to the runner.
    runPromptRefineRaw.mockImplementation(async ({ validateContent }) => {
      validateContent({ candidates: 'nope' });
      return { content: { candidates: 'nope' }, rationale: '', runId: 'r', providerId: 'p', model: 'm' };
    });
    await expect(discoverSeriesVoice('ser-1')).rejects.toMatchObject({
      code: 'PIPELINE_VOICE_DISCOVER_EMPTY',
    });
  });

  it('throws PIPELINE_VOICE_DISCOVER_EMPTY when every candidate is unusable', async () => {
    mockLLM([{ register: 'bogus', passage: 'x' }, { register: 'spare', passage: '' }]);
    await expect(discoverSeriesVoice('ser-1')).rejects.toMatchObject({
      code: 'PIPELINE_VOICE_DISCOVER_EMPTY',
    });
  });

  it('passes the series + universe context and the register menu into the prompt', async () => {
    mockLLM([{ register: 'spare', passage: 'ok' }]);
    await discoverSeriesVoice('ser-1');
    const call = runPromptRefineRaw.mock.calls[0][0];
    expect(call.templateName).toBe('pipeline-series-voice-discover');
    expect(call.variables.series.name).toBe('Salt Run');
    expect(call.variables.hasUniverse).toBe(true);
    expect(call.variables.universe.name).toBe('Saltworks');
    // Every register id must appear in the rendered menu so the model writes one each.
    for (const id of VOICE_REGISTER_IDS) expect(call.variables.registers).toContain(id);
    expect(call.variables.passageMaxChars).toBe(STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX);
    // The composed style context (tone/tense) seeds the prompt so registers vary WITHIN the tone.
    expect(call.variables.series.styleContext).toContain('past tense');
  });

  it('does NOT leak existing voice exemplars into the discovery prompt (would homogenize a re-run)', async () => {
    getSeries.mockResolvedValue({
      ...baseSeries,
      styleGuide: {
        tense: 'past',
        voiceExemplars: [{ passage: 'ALREADY_PICKED_EXEMPLAR_PROSE', note: 'spare' }],
        voiceAntiExemplars: [{ passage: 'THE_WRONG_REGISTER_PROSE', note: 'ornate' }],
      },
    });
    mockLLM([{ register: 'spare', passage: 'ok' }]);
    await discoverSeriesVoice('ser-1');
    const call = runPromptRefineRaw.mock.calls[0][0];
    // The tone/tense still seeds the prompt...
    expect(call.variables.series.styleContext).toContain('past tense');
    // ...but the already-picked exemplar prose must not, or a re-run just echoes it back.
    expect(call.variables.series.styleContext).not.toContain('ALREADY_PICKED_EXEMPLAR_PROSE');
    expect(call.variables.series.styleContext).not.toContain('THE_WRONG_REGISTER_PROSE');
  });

  it('tolerates a series with no linked universe', async () => {
    getSeries.mockResolvedValue({ ...baseSeries, universeId: null });
    mockLLM([{ register: 'spare', passage: 'ok' }]);
    const out = await discoverSeriesVoice('ser-1');
    expect(getUniverse).not.toHaveBeenCalled();
    expect(out.candidates).toHaveLength(1);
    const call = runPromptRefineRaw.mock.calls[0][0];
    expect(call.variables.hasUniverse).toBe(false);
  });
});
