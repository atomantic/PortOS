// Curated conversational speech-agent LLMs that a compatible API provider can serve.

export const CONVERSATIONAL_GEMMA = Object.freeze({
  id: 'Trelis/gemma-4-31B-it-conversational',
  name: 'Conversational Gemma 4 31B',
  url: 'https://huggingface.co/Trelis/gemma-4-31B-it-conversational',
  license: 'PolyForm Small Business 1.0.0',
  localGgufPath: '~/.portos/models/Conversational-Gemma-4-31B-Q8_0.gguf',
});

export const isConversationalGemma = id => typeof id === 'string' && id.toLowerCase() === CONVERSATIONAL_GEMMA.id.toLowerCase();
