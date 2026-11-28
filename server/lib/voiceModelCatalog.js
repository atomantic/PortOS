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

// The fastest capable local Voice brain measured with the real Voice persona and
// tools: a mixture-of-experts model (4B active parameters per token). Over two
// runs of 12 tool and chat cases it got 24/24 right and reached the first word
// in 0.4-0.8 s on turns that miss the prompt cache, ahead of qwen3.6:35b (22/24,
// 0.7-1.6 s) and dense ~30B models (3-7 s) on the same Apple Silicon host.
export const RECOMMENDED_FAST_VOICE_MODEL = Object.freeze({
  id: 'gemma4:26b',
  name: 'Gemma 4 26B',
  providerId: 'ollama',
  downloadLabel: '18 GB',
});
