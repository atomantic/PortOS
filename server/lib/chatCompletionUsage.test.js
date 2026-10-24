import { describe, expect, it } from 'vitest';
import { normalizeChatCompletionUsage } from './chatCompletionUsage.js';

const xaiExample = {
  prompt_tokens: 32,
  completion_tokens: 9,
  total_tokens: 135,
  prompt_tokens_details: { cached_tokens: 6 },
  completion_tokens_details: { reasoning_tokens: 94 },
};

describe('normalizeChatCompletionUsage', () => {
  it('splits xAI cached input out of the prompt and adds reasoning on top of completion', () => {
    const usage = normalizeChatCompletionUsage(xaiExample, {
      model: 'grok-4.7', endpoint: 'https://api.x.ai/v1',
    });
    expect(usage).toMatchObject({
      inputTokens: 26,
      cacheReadTokens: 6,
      outputTokens: 103,
      longContext: false,
      source: 'measured',
    });
  });

  it('keeps the published 32 + 9 + 94 = 135 total when nothing was cached', () => {
    const usage = normalizeChatCompletionUsage({
      prompt_tokens: 32, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 94 },
    }, { endpoint: 'https://us.api.x.ai/v1' });
    expect(usage.inputTokens + usage.cacheReadTokens + usage.outputTokens).toBe(135);
    expect(usage.outputTokens).toBe(103);
  });

  it('does not add reasoning for a non-xAI host, even when the model id says grok', () => {
    const usage = normalizeChatCompletionUsage(xaiExample, {
      model: 'grok-4.7', endpoint: 'https://api.example.com/v1',
    });
    expect(usage.outputTokens).toBe(9);
    expect(usage.inputTokens).toBe(26);
    expect(usage.longContext).toBe(false);
  });

  it('sets the long-context subset only for an xAI prompt of at least 200k tokens', () => {
    const body = { prompt_tokens: 200_000, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 } };
    expect(normalizeChatCompletionUsage(body, { model: 'grok-4.7' }).longContext).toBe(true);
    expect(normalizeChatCompletionUsage(body, { endpoint: 'https://api.openai.com/v1', model: 'gpt-5.4' }).longContext).toBe(false);
    expect(normalizeChatCompletionUsage(
      { prompt_tokens: 199_999, completion_tokens: 1 },
      { endpoint: 'https://api.x.ai/v1' },
    ).longContext).toBe(false);
  });

  it('returns null when the body has no finite counts', () => {
    expect(normalizeChatCompletionUsage(null, {})).toBeNull();
    expect(normalizeChatCompletionUsage({}, { model: 'grok-4.7' })).toBeNull();
  });
});
