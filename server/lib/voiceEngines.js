// Supported TTS engine IDs and their persisted configuration keys.
export const TTS_ENGINE_CONFIG_KEYS = Object.freeze({
  kokoro: 'kokoro',
  piper: 'piper',
  'qwen3-tts': 'qwen3',
});

export const TTS_ENGINE_IDS = Object.freeze(Object.keys(TTS_ENGINE_CONFIG_KEYS));
export const VALID_ENGINES = new Set(TTS_ENGINE_IDS);
