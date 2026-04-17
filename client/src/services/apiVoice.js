import api from './apiCore';

export const getVoiceStatus = () => api.get('/voice/status');
export const getVoiceConfig = () => api.get('/voice/config');
export const updateVoiceConfig = (patch) => api.put('/voice/config', patch);
export const listVoices = (engine) => api.get(`/voice/voices${engine ? `?engine=${engine}` : ''}`);
export const fetchPiperVoice = (voice) => api.post('/voice/piper/fetch', { voice });

// Returns the raw WAV bytes of the test utterance. Optional `voice` and
// `engine` overrides let the voice-picker preview audition a voice from a
// different engine than the saved one — without forcing a save first.
export const testTts = async (text, voice, engine) => {
  const body = { text };
  if (voice) body.voice = voice;
  if (engine) body.engine = engine;
  const res = await fetch('/api/voice/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || 'TTS test failed');
  }
  return res.arrayBuffer();
};
