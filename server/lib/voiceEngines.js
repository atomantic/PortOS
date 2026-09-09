// Shared TTS engine metadata. The registry is returned by /api/voice/engines so
// clients can render and update engines without copying IDs or config keys.
export const TTS_ENGINE_REGISTRY = Object.freeze({
  kokoro: Object.freeze({
    configKey: 'kokoro',
    label: 'Kokoro',
    description: 'In-process, high quality',
    voiceHint: 'Grade letter = Kokoro author\'s quality rating. ❤️ 🔥 🎧 mark the best-sounding voices. Click ▶ to preview without saving.',
    capabilities: {
      preset: true, voiceDesign: false, instantClone: false, fineTune: false,
      streaming: false, instructionControl: false, emotionControl: false,
      seed: false, wordTimings: false, rate: true, pitch: false, formant: false,
    },
  }),
  piper: Object.freeze({
    configKey: 'piper',
    label: 'Piper',
    description: 'CLI binary, lightweight',
    voiceHint: 'Curated Piper catalog — selecting a ⬇ voice fetches it immediately so you can preview. Click ▶ to audition.',
    capabilities: {
      preset: true, voiceDesign: false, instantClone: false, fineTune: false,
      streaming: false, instructionControl: false, emotionControl: false,
      seed: false, wordTimings: false, rate: true, pitch: false, formant: false,
    },
  }),
  'qwen3-tts': Object.freeze({
    configKey: 'qwen3',
    label: 'Qwen3-TTS',
    description: 'Voice design, cloning, and streaming',
    voiceHint: 'Designed Qwen3 voice presets with language and gender metadata. Click ▶ to preview without saving.',
    aliases: Object.freeze(['qwen3']),
    capabilities: {
      preset: true, voiceDesign: true, instantClone: true, fineTune: true,
      streaming: true, instructionControl: true, emotionControl: true,
      seed: true, wordTimings: true, rate: true, pitch: false, formant: false,
    },
  }),
});

export const TTS_ENGINE_CONFIG_KEYS = Object.freeze(Object.fromEntries(
  Object.entries(TTS_ENGINE_REGISTRY).map(([id, engine]) => [id, engine.configKey]),
));

export const TTS_ENGINE_IDS = Object.freeze(Object.keys(TTS_ENGINE_REGISTRY));
export const VALID_ENGINES = new Set(TTS_ENGINE_IDS);
