import api from './apiCore';

// `options` lets callers pass `{ silent: true }` so apiCore's default toast
// doesn't fire when the caller owns its own error UI (custom catch /
// useAsyncAction). Without it the user sees a stacked toast for every
// failure — and the Memory Management panel polls every 5s.
export const getVoiceStatus = (options) => api.get('/voice/status', options);
export const getVoiceConfig = (options) => api.get('/voice/config', options);
export const updateVoiceConfig = (patch, options) => api.put('/voice/config', patch, options);
export const listVoices = (engine, options) => api.get(`/voice/voices${engine ? `?engine=${engine}` : ''}`, options);
export const fetchPiperVoice = (voice, options) => api.post('/voice/piper/fetch', { voice }, options);

// Returns the raw WAV bytes of the test utterance. Optional `voice` and
// `engine` overrides let the voice-picker preview audition a voice from a
// different engine than the saved one — without forcing a save first.
// Silent — VoiceTab callers own their own error toasts.
export const testTts = (text, voice, engine) => {
  const body = { text };
  if (voice) body.voice = voice;
  if (engine) body.engine = engine;
  return api.post('/voice/test', body, { responseType: 'arraybuffer', silent: true });
};

// Memory-management — Kokoro residency + unload, Whisper transient stop/start.
// See MemoryManagement.jsx for the only consumer; it owns its own toast,
// hence the `options` parameter / `silent: true` plumbing.
export const getTtsStatus = (options) => api.get('/voice/tts/status', options);
export const unloadKokoroTts = (options) => api.post('/voice/tts/unload', {}, options);
export const controlWhisper = (action, options) => api.post('/voice/whisper', { action }, options);
