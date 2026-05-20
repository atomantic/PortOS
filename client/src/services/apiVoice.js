import api from './apiCore';

export const getVoiceStatus = () => api.get('/voice/status');
export const getVoiceConfig = () => api.get('/voice/config');
export const updateVoiceConfig = (patch) => api.put('/voice/config', patch);
export const listVoices = (engine) => api.get(`/voice/voices${engine ? `?engine=${engine}` : ''}`);
export const fetchPiperVoice = (voice) => api.post('/voice/piper/fetch', { voice });

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
