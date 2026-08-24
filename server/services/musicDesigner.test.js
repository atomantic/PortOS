import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the AI runner so both designer steps run end to end against a canned
// response — no provider spawn. `resolve` lets a case return "no provider" so
// the NO_PROVIDER guard is exercised against the REAL assertProvider.
const ai = vi.hoisted(() => ({
  provider: { id: 'fake-provider', type: 'api' },
  selectedModel: 'fake-model',
  runPromptThroughProvider: vi.fn(),
}));
vi.mock('./promptRunner.js', async () => ({
  ...(await vi.importActual('./promptRunner.js')),
  resolveProviderAndModel: vi.fn(async () => ({ provider: ai.provider, selectedModel: ai.selectedModel })),
  runPromptThroughProvider: ai.runPromptThroughProvider,
}));

import { resolveProviderAndModel } from './promptRunner.js';
import {
  DEFAULT_DESCRIBE_TEMPLATE, DEFAULT_LYRICS_TEMPLATE,
  buildDescribePrompt, buildLyricsPrompt, describeMusic, writeLyrics,
} from './musicDesigner.js';

const lastRunArgs = () => ai.runPromptThroughProvider.mock.calls.at(-1)[0];

beforeEach(() => {
  ai.provider = { id: 'fake-provider', type: 'api' };
  ai.selectedModel = 'fake-model';
  ai.runPromptThroughProvider.mockReset().mockResolvedValue({ text: 'canned output', model: 'ran-model', runId: 'run-1' });
  resolveProviderAndModel.mockClear();
});

describe('prompt builders', () => {
  it('uses the shipped default when no template is given', () => {
    expect(buildDescribePrompt({ concept: 'a rainy downtempo loop' })).toContain(DEFAULT_DESCRIBE_TEMPLATE);
    expect(buildLyricsPrompt({ description: 'warm rhodes soul' })).toContain(DEFAULT_LYRICS_TEMPLATE);
  });

  it('uses an override template instead of the default', () => {
    const prompt = buildDescribePrompt({ concept: 'a rainy downtempo loop', template: 'Be terse.' });
    expect(prompt).toContain('Be terse.');
    expect(prompt).not.toContain(DEFAULT_DESCRIBE_TEMPLATE);
  });

  it('falls back to the default for a blank/whitespace override', () => {
    expect(buildDescribePrompt({ concept: 'x', template: '   ' })).toContain(DEFAULT_DESCRIBE_TEMPLATE);
    expect(buildLyricsPrompt({ description: 'x', template: '\n\t ' })).toContain(DEFAULT_LYRICS_TEMPLATE);
  });

  it('includes the user guidance section only when guidance is given', () => {
    expect(buildDescribePrompt({ concept: 'x', guidance: 'under 100 BPM' })).toContain('under 100 BPM');
    expect(buildDescribePrompt({ concept: 'x' })).not.toContain('ADDITIONAL GUIDANCE');
  });

  it('requests the MiniMax structured-caption contract with deliberate timing detail', () => {
    const prompt = buildDescribePrompt({ concept: 'an instrumental night drive in 6/8' });
    const globalIndex = prompt.indexOf('Global Metadata');
    const vocalIndex = prompt.indexOf('Vocal Details');
    const arrangementIndex = prompt.indexOf('Arrangement');

    expect(prompt).toMatch(/meter or time signature/i);
    expect(prompt).toMatch(/250–450 English words/i);
    expect(prompt).toMatch(/instrumental.*lead melodic/i);
    expect(globalIndex).toBeGreaterThan(-1);
    expect(vocalIndex).toBeGreaterThan(globalIndex);
    expect(arrangementIndex).toBeGreaterThan(vocalIndex);
  });

  it('keeps music controls in the caption and requires standalone lyric tags', () => {
    const prompt = buildLyricsPrompt({ description: 'slow compound-meter soul' });
    expect(prompt).toMatch(/every tag must sit alone on its own line/i);
    expect(prompt).toContain('[instrumental]');
    expect(prompt).toContain('[solo]');
    expect(prompt).toMatch(/tempo, meter, key, arrangement, and production instructions in the musical description/i);
  });

  it('keeps the output-format instruction outside the overridable template', () => {
    // An override tunes the creative brief, not the wire format — a fenced or
    // preambled response would land verbatim in the user's textarea.
    expect(buildLyricsPrompt({ description: 'x', template: 'Whatever.' })).toContain('no markdown fence');
    expect(buildDescribePrompt({ concept: 'x', template: 'Whatever.' })).toContain('Global Metadata');
  });
});

describe('describeMusic', () => {
  it('runs the prompt through the resolved provider and returns text + attribution', async () => {
    ai.runPromptThroughProvider.mockResolvedValue({ text: '  Lush analog pads over a broken beat.  ', model: 'ran-model' });

    const result = await describeMusic({ concept: 'a rainy downtempo loop', providerId: 'fake-provider', model: 'fake-model' });

    expect(result).toEqual({
      description: 'Lush analog pads over a broken beat.',
      llm: { provider: 'fake-provider', model: 'ran-model' },
    });
    expect(resolveProviderAndModel).toHaveBeenCalledWith({ providerId: 'fake-provider', model: 'fake-model' });
    expect(lastRunArgs()).toMatchObject({ provider: ai.provider, model: 'fake-model', source: 'music-describe' });
  });

  it('passes effort through to the runner', async () => {
    await describeMusic({ concept: 'x', effort: 'high' });
    expect(lastRunArgs().effort).toBe('high');
  });

  it('unwraps a fully fenced response', async () => {
    ai.runPromptThroughProvider.mockResolvedValue({ text: '```\nA slow, dusty boom-bap groove.\n```', model: null });
    const { description } = await describeMusic({ concept: 'x' });
    expect(description).toBe('A slow, dusty boom-bap groove.');
  });

  it('throws NO_PROVIDER when nothing resolves', async () => {
    ai.provider = null;
    ai.selectedModel = null;
    await expect(describeMusic({ concept: 'x' })).rejects.toMatchObject({ code: 'NO_PROVIDER', status: 503 });
    expect(ai.runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('throws LLM_EMPTY on a blank response instead of returning an empty description', async () => {
    ai.runPromptThroughProvider.mockResolvedValue({ text: '   ', model: null });
    await expect(describeMusic({ concept: 'x' })).rejects.toMatchObject({ code: 'LLM_EMPTY', status: 502 });
  });
});

describe('writeLyrics', () => {
  it('returns lyrics + attribution and tags the run source', async () => {
    ai.runPromptThroughProvider.mockResolvedValue({ text: '[verse]\nrain on the window\n', model: 'ran-model' });

    const result = await writeLyrics({ description: 'warm rhodes soul', guidance: 'about leaving at dawn' });

    expect(result).toEqual({
      lyrics: '[verse]\nrain on the window',
      llm: { provider: 'fake-provider', model: 'ran-model' },
    });
    expect(lastRunArgs()).toMatchObject({ source: 'music-lyrics' });
    expect(lastRunArgs().prompt).toContain('about leaving at dawn');
  });

  it('passes effort through to the runner', async () => {
    await writeLyrics({ description: 'x', effort: 'low' });
    expect(lastRunArgs().effort).toBe('low');
  });

  it('throws NO_PROVIDER when nothing resolves', async () => {
    ai.provider = null;
    await expect(writeLyrics({ description: 'x' })).rejects.toMatchObject({ code: 'NO_PROVIDER', status: 503 });
  });

  it('throws LLM_EMPTY on a blank response', async () => {
    ai.runPromptThroughProvider.mockResolvedValue({ text: '', model: null });
    await expect(writeLyrics({ description: 'x' })).rejects.toMatchObject({ code: 'LLM_EMPTY', status: 502 });
  });
});
