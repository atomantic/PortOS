import api from './apiCore';

export const getVoiceStatus = () => api.get('/voice/status');
export const getVoiceConfig = () => api.get('/voice/config');
export const updateVoiceConfig = (patch) => api.put('/voice/config', patch);
export const listVoices = () => api.get('/voice/voices');

// Returns the raw WAV bytes of the test utterance. Optional `voice` overrides
// the currently-saved voice for this call (used by the voice-picker preview
// so users can audition voices before saving).
export const testTts = async (text, voice) => {
  const res = await fetch('/api/voice/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(voice ? { text, voice } : { text }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || 'TTS test failed');
  }
  return res.arrayBuffer();
};
