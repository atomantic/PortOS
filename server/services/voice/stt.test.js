import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    stt: { endpoint: 'http://127.0.0.1:9', language: 'en', vocabularyPrompt: 'bias terms' },
  })),
}));

vi.mock('../../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { extractVerboseWords, transcribe } from './stt.js';

const ok = (data) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => data,
  text: async () => JSON.stringify(data),
});

describe('transcribe verbose word timings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the plain json path for voice turns', async () => {
    fetchWithTimeout.mockResolvedValue(ok({ text: ' hello ' }));
    await expect(transcribe(Buffer.from('x'))).resolves.toMatchObject({ text: 'hello' });
    const form = fetchWithTimeout.mock.calls[0][1].body;
    expect(form.get('response_format')).toBe('json');
    expect(form.get('split_on_word')).toBeNull();
    expect(form.get('prompt')).toBe('bias terms');
  });

  it('asks whisper for word-split verbose json and returns those words', async () => {
    fetchWithTimeout.mockResolvedValue(ok({
      text: " That's one",
      segments: [{
        words: [
          { word: ' That', start: 0.16, end: 0.31 },
          { word: "'s", start: 0.38, end: 0.49 },
          { word: ' one', start: 0.5, end: 0.8 },
        ],
      }],
    }));
    const result = await transcribe(Buffer.from('x'), { verbose: true, prompt: 'walking home' });
    expect(result.words).toEqual([
      { text: 'That', startSec: 0.16, endSec: 0.31 },
      { text: "'s", startSec: 0.38, endSec: 0.49 },
      { text: 'one', startSec: 0.5, endSec: 0.8 },
    ]);
    const form = fetchWithTimeout.mock.calls[0][1].body;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('split_on_word')).toBe('true');
    expect(form.get('token_timestamps')).toBe('true');
    expect(form.get('prompt')).toBe('walking home');
  });
});

describe('extractVerboseWords', () => {
  it('groups subword tokens on whisper word boundaries and drops special tokens', () => {
    expect(extractVerboseWords({
      segments: [{
        tokens: [
          { text: '[_BEG_]', timestamps: { from: '00:00:00,000', to: '00:00:00,000' } },
          { text: ' Hel', timestamps: { from: '00:00:01,000', to: '00:00:01,200' } },
          { text: 'lo', timestamps: { from: '00:00:01,200', to: '00:00:01,450' } },
          { text: ' there', timestamps: { from: '00:00:01,500', to: '00:00:01,900' } },
        ],
      }],
    })).toEqual([
      { text: 'Hello', startSec: 1, endSec: 1.45 },
      { text: 'there', startSec: 1.5, endSec: 1.9 },
    ]);
  });
});
