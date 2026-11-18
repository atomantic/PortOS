// Backend and provider identities shared by the local LLM capability endpoints and their consumers.

export const LOCAL_LLM_PROVIDER_ID_BY_BACKEND = Object.freeze({
  ollama: 'ollama',
  lmstudio: 'lmstudio',
});

export const LOCAL_LLM_PROVIDER_IDS = Object.freeze(Object.values(LOCAL_LLM_PROVIDER_ID_BY_BACKEND));

// These local API backends report vision capability per model. CLI rows represent
// a provider-level capability, so they cannot inform local model selection.
export const LOCAL_VISION_BACKENDS = new Set(Object.keys(LOCAL_LLM_PROVIDER_ID_BY_BACKEND));
