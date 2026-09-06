import { describe, it, expect } from 'vitest';
import { apiGenerationOptions } from './generationOptions.js';

// The request body PortOS attaches for a locally-backed API run. Which fields
// ride along is per-backend and silent when wrong: a field the daemon does not
// read is simply ignored, so the stored control looks honoured while nothing
// changes. Pin the two rules that are not obvious from the shape.
describe('apiGenerationOptions', () => {
  it('sends nothing at all for a cloud provider', () => {
    expect(apiGenerationOptions({ temperature: 0.7, thinking: true })).toEqual({});
  });

  it('routes the thinking toggle by backend — native on Ollama, chat template elsewhere', () => {
    expect(apiGenerationOptions({ ollamaBacked: true, thinking: false }))
      .toEqual({ temperature: 0.6, think: false });
    expect(apiGenerationOptions({ sglangBacked: true, temperature: 0.4, thinking: true }))
      .toEqual({ temperature: 0.4, chat_template_kwargs: { enable_thinking: true } });
  });

  it('forwards sampling to LM Studio but never a thinking field', () => {
    // LM Studio picks reasoning when the model INSTANCE is loaded; its
    // OpenAI-compatible endpoint documents no per-request field for it, so a
    // stored `thinking` must not be dressed up as one the daemon reads.
    expect(apiGenerationOptions({ lmstudioBacked: true, temperature: 0.4, topP: 0.9, thinking: true }))
      .toEqual({ temperature: 0.4, top_p: 0.9 });
    // ...and unlike Ollama it gets no seeded temperature default either.
    expect(apiGenerationOptions({ lmstudioBacked: true })).toEqual({});
  });
});
