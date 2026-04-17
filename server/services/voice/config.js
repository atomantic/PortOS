// Voice config — defaults merged with data/settings.json#voice. Engine-dispatched:
// stt.<engine> / tts.<engine> hold backend-specific options. Stored paths use `~/`
// for portability and are expanded by `expandPath` at consumption time.

import { homedir } from 'os';
import { join } from 'path';
import { getSettings, updateSettings } from '../settings.js';

const VOICE_HOME = join(homedir(), '.portos', 'voice');

export const VOICE_DEFAULTS = Object.freeze({
  enabled: false,
  trigger: 'push-to-talk',
  hotkey: 'Space',

  stt: {
    // 'web-speech' (browser-native, zero-latency, no server process needed) is the
    // default. Falls back to 'whisper' (local whisper.cpp) for browsers without
    // SpeechRecognition support (Firefox, older Safari) or when the user wants
    // consistent offline STT across clients.
    engine: 'web-speech', // 'whisper' | 'web-speech'
    // 5562 keeps whisper inside PortOS's own 55xx port band. Avoid 8080 —
    // IPFS, Supabase Studio, Tomcat, etc. commonly squat on it.
    endpoint: 'http://127.0.0.1:5562',
    model: 'base.en',
    modelPath: '~/.portos/voice/models/ggml-base.en.bin',
    language: 'en',
    // CoreML (Apple Neural Engine) is NOT enabled by default because Homebrew's
    // whisper-cpp formula ships without WHISPER_COREML — the `.mlmodelc` encoder
    // companion is ignored even if downloaded. Turn on only if you've built
    // whisper.cpp from source with `cmake -DWHISPER_COREML=1`. Metal backend
    // (GPU) is always used and is fast enough for most utterances.
    coreml: false,
    // Whisper prompt bias — seeds the decoder with context so PortOS-specific
    // terms don't get mapped to common English homophones. Empty = defaults.
    vocabularyPrompt: '',
  },

  tts: {
    engine: 'kokoro', // 'kokoro' | 'piper'
    rate: 1.0,
    kokoro: {
      modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      dtype: 'q8', // 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'
      voice: 'af_heart',
    },
    piper: {
      voice: 'en_GB-jenny_dioco-medium',
      voicePath: '~/.portos/voice/voices/en_GB-jenny_dioco-medium.onnx',
      // Null = use the catalog default (set per-voice in piper-voices.js).
      // Override here when experimenting with other VCTK speaker indices.
      speakerId: null,
    },
  },

  llm: {
    provider: 'lmstudio',
    model: 'auto',
    // Legacy free-form system prompt. Overridden by `personality` + tool
    // descriptions when `usePersonality` is true (default).
    systemPrompt: 'You are the PortOS assistant. Your replies are spoken aloud — keep them short and use plain prose (no markdown or lists).',
    usePersonality: true,
    personality: {
      name: 'Alfred',
      role: 'Chief of Staff',
      traits: ['concise', 'warm', 'proactive'],
      speechStyle: 'casual and brief',
      customPrompt: '',
    },
    // Tool-calling is OFF by default — it adds 1–2 LLM roundtrips per turn
    // (slower) and needs a tool-use-trained model (Qwen2.5, Hermes-3, etc.)
    // to avoid producing JSON-like gibberish in the spoken reply.
    tools: {
      enabled: false,
      maxIterations: 3,
    },
  },

  vad: { endOfSpeechMs: 700, minUtteranceMs: 250 },
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

const deepMerge = (base, patch) => {
  if (!isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(base[k]) && isObj(v) ? deepMerge(base[k], v) : v;
  }
  return out;
};

export const expandPath = (p) => {
  if (typeof p !== 'string') return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
};

// Tiny in-memory cache so hot paths (per-turn enabled check in voice sockets)
// don't hit disk on every dispatch. Invalidated on updateVoiceConfig and
// manually via invalidateVoiceConfigCache() from the reconcile flow.
let cachedConfig = null;

export const getVoiceConfig = async () => {
  if (cachedConfig) return cachedConfig;
  const settings = await getSettings();
  cachedConfig = deepMerge(VOICE_DEFAULTS, settings.voice || {});
  return cachedConfig;
};

export const invalidateVoiceConfigCache = () => { cachedConfig = null; };

export const updateVoiceConfig = async (patch) => {
  const settings = await getSettings();
  const current = deepMerge(VOICE_DEFAULTS, settings.voice || {});
  const next = deepMerge(current, patch || {});
  await updateSettings({ voice: next });
  cachedConfig = next;
  return next;
};

export const voiceHome = () => VOICE_HOME;
export const piperVoiceTildePath = (id) => `~/.portos/voice/voices/${id}.onnx`;
