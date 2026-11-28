// Curated conversational speech-agent LLMs that a compatible API provider can serve.

export const CONVERSATIONAL_GEMMA = Object.freeze({
  id: 'Trelis/gemma-4-31B-it-conversational',
  name: 'Conversational Gemma 4 31B',
  url: 'https://huggingface.co/Trelis/gemma-4-31B-it-conversational',
  revision: '29055ace878329e2f8b216ecd7edcaefccb27969',
  license: 'PolyForm Small Business 1.0.0',
  localGgufPath: '~/.portos/models/Conversational-Gemma-4-31B-Q8_0.gguf',
  llamaProviderId: 'llama-server',
});

export const isConversationalGemma = id => typeof id === 'string' && id.toLowerCase() === CONVERSATIONAL_GEMMA.id.toLowerCase();

/** A model id as voice pickers show it: the curated name for a catalog model, else the raw id. */
export const voiceModelDisplayName = id => (isConversationalGemma(id) ? CONVERSATIONAL_GEMMA.name : id);

// The fastest local Voice brain measured with the real Voice persona and tools:
// a mixture-of-experts model, so only a few billion parameters run per token.
// It reached the first word in about 1 s on turns that miss the prompt cache,
// where dense ~30B models took 3 to 7 s on the same Apple Silicon host.
export const RECOMMENDED_FAST_VOICE_MODEL = Object.freeze({
  id: 'qwen3.6:35b',
  name: 'Qwen3.6 35B',
  providerId: 'ollama',
  downloadLabel: '23 GB',
});
