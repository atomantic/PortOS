import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks — declared before importing the module under test. We mock only the
// LLM/provider/document deps; safeJSONParse (from fileUtils) runs for real so
// parseStyleComparison is exercised end-to-end.
vi.mock('./providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('./promptService.js', () => ({ buildPrompt: vi.fn() }));
vi.mock('./digital-twin-helpers.js', () => ({ callProviderAI: vi.fn() }));
vi.mock('./digital-twin-analysis.js', () => ({ getAllTwinContent: vi.fn() }));

import { compareSpokenWrittenStyle, parseStyleComparison } from './digital-twin-style-comparison.js';
import { getProviderById } from './providers.js';
import { buildPrompt } from './promptService.js';
import { callProviderAI } from './digital-twin-helpers.js';
import { getAllTwinContent } from './digital-twin-analysis.js';

const LONG_TRANSCRIPT = 'So, um, I was thinking about this, you know, the whole thing kind of just, like, came together. '.repeat(3);

const VALID_JSON = JSON.stringify({
  spokenProfile: { formality: 3, verbosity: 7, avgSentenceLength: 12, directness: 6, fillerWords: 'frequent um/like', distinctiveMarkers: ['you know'] },
  writtenProfile: { formality: 7, verbosity: 5, avgSentenceLength: 18, directness: 8, fillerWords: 'rare', distinctiveMarkers: ['—'] },
  differences: [{ dimension: 'formality', spoken: '3', written: '7', note: 'speech is looser' }],
  summary: 'You speak more casually than you write.',
  suggestedCommunicationProfile: { formality: 4, verbosity: 6, emojiUsage: 'rare', preferredTone: 'warm and direct' }
});

describe('parseStyleComparison', () => {
  it('parses a raw JSON object', () => {
    const r = parseStyleComparison(VALID_JSON);
    expect(r.error).toBeUndefined();
    expect(r.spokenProfile.formality).toBe(3);
    expect(r.writtenProfile.formality).toBe(7);
    expect(r.differences).toHaveLength(1);
    expect(r.summary).toContain('casually');
    expect(r.suggestedCommunicationProfile.preferredTone).toBe('warm and direct');
  });

  it('parses a ```json fenced block', () => {
    const r = parseStyleComparison('Here you go:\n```json\n' + VALID_JSON + '\n```\nDone.');
    expect(r.error).toBeUndefined();
    expect(r.spokenProfile.verbosity).toBe(7);
  });

  it('defaults arrays/objects so absent is distinguishable from empty', () => {
    const r = parseStyleComparison('{"summary":"only a summary"}');
    expect(r.error).toBeUndefined();
    expect(r.differences).toEqual([]);
    expect(r.spokenProfile).toBeNull();
    expect(r.suggestedCommunicationProfile).toBeNull();
    expect(r.summary).toBe('only a summary');
  });

  it('returns an error with rawResponse when no JSON is present', () => {
    const r = parseStyleComparison('I could not analyze that.');
    expect(r.error).toMatch(/no JSON found/);
    expect(r.rawResponse).toBe('I could not analyze that.');
  });

  it('returns an error with rawResponse on invalid JSON', () => {
    const r = parseStyleComparison('{ not valid json ');
    expect(r.error).toMatch(/invalid JSON|no JSON found/);
  });
});

describe('compareSpokenWrittenStyle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderById.mockResolvedValue({ id: 'p1', enabled: true });
    buildPrompt.mockResolvedValue('PROMPT');
    callProviderAI.mockResolvedValue({ text: VALID_JSON });
    getAllTwinContent.mockResolvedValue('A long body of the user written documents. '.repeat(5));
  });

  it('rejects a too-short transcript before calling the model', async () => {
    const r = await compareSpokenWrittenStyle({ spokenTranscript: 'too short', providerId: 'p1', model: 'm' });
    expect(r.error).toMatch(/at least 100/);
    expect(callProviderAI).not.toHaveBeenCalled();
  });

  it('uses provided written samples and reports writtenSource=provided', async () => {
    const r = await compareSpokenWrittenStyle({
      spokenTranscript: LONG_TRANSCRIPT,
      writtenSamples: ['Here is a sufficiently long written sample for the comparison.'],
      providerId: 'p1',
      model: 'm'
    });
    expect(r.writtenSource).toBe('provided');
    expect(getAllTwinContent).not.toHaveBeenCalled();
    expect(r.summary).toContain('casually');
  });

  it('falls back to twin documents when no written samples are provided', async () => {
    const r = await compareSpokenWrittenStyle({ spokenTranscript: LONG_TRANSCRIPT, providerId: 'p1', model: 'm' });
    expect(getAllTwinContent).toHaveBeenCalled();
    expect(r.writtenSource).toBe('documents');
  });

  it('errors when no written samples and document content is too thin', async () => {
    getAllTwinContent.mockResolvedValue('tiny');
    const r = await compareSpokenWrittenStyle({ spokenTranscript: LONG_TRANSCRIPT, providerId: 'p1', model: 'm' });
    expect(r.error).toMatch(/not enough twin document content/);
    expect(callProviderAI).not.toHaveBeenCalled();
  });

  it('errors when the prompt template is missing', async () => {
    buildPrompt.mockRejectedValue(new Error('Stage not found'));
    const r = await compareSpokenWrittenStyle({
      spokenTranscript: LONG_TRANSCRIPT,
      writtenSamples: ['A sufficiently long written sample to compare.'],
      providerId: 'p1',
      model: 'm'
    });
    expect(r.error).toMatch(/prompt template not found/);
  });

  it('errors when the provider is missing or disabled', async () => {
    getProviderById.mockResolvedValue(null);
    const r = await compareSpokenWrittenStyle({
      spokenTranscript: LONG_TRANSCRIPT,
      writtenSamples: ['A sufficiently long written sample to compare.'],
      providerId: 'p1',
      model: 'm'
    });
    expect(r.error).toMatch(/Provider not found/);
  });

  it('surfaces the provider error when the model call fails', async () => {
    callProviderAI.mockResolvedValue({ error: 'rate limited' });
    const r = await compareSpokenWrittenStyle({
      spokenTranscript: LONG_TRANSCRIPT,
      writtenSamples: ['A sufficiently long written sample to compare.'],
      providerId: 'p1',
      model: 'm'
    });
    expect(r.error).toBe('rate limited');
  });
});
