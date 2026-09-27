import api from './apiCore';

// `options` lets callers pass `{ silent: true }` so apiCore's default toast
// doesn't fire when the caller owns its own error UI (custom catch /
// useAsyncAction).
export const getVoiceStatus = (options) => api.get('/voice/status', options);
export const getVoiceConfig = (options) => api.get('/voice/config', options);
export const updateVoiceConfig = (patch, options) => api.put('/voice/config', patch, options);
export const listVoices = (engine, options) => api.get(`/voice/voices${engine ? `?engine=${engine}` : ''}`, options);
export const fetchPiperVoice = (voice, options) => api.post('/voice/piper/fetch', { voice }, options);

export const listVoiceProfiles = ({ universeId, characterId } = {}, options) => {
  const params = new URLSearchParams();
  if (universeId) params.set('universeId', universeId);
  if (characterId) params.set('characterId', characterId);
  const query = params.toString();
  return api.get(`/voice/profiles${query ? `?${query}` : ''}`, options);
};

export const listVoiceEngines = (options) => api.get('/voice/engines', options);
export const promoteVoicePreset = (payload, options) => api.post('/voice/profiles/preset', payload, options);
export const createVoiceDesignCandidate = (payload, options) => api.post('/voice/profiles/design', payload, options);
export const createClonedVoiceCandidate = (payload, options) => api.post('/voice/profiles/clone', payload, options);
export const promoteVoiceProfile = (profileId, payload = {}, options) => api.post(
  `/voice/profiles/${encodeURIComponent(profileId)}/promote`, payload, options,
);
export const renderVoiceProfileBenchmark = (profileId, options) => api.post(
  `/voice/profiles/${encodeURIComponent(profileId)}/benchmark`, {}, options,
);
export const benchmarkProfileInteractive = (profileId, payload = {}, options) => api.post(
  `/voice/profiles/${encodeURIComponent(profileId)}/benchmark-interactive`, payload, options,
);

export const completeVoiceProfileInteractiveBenchmark = (profileId, payload, options) => api.post(
  `/voice/profiles/${encodeURIComponent(profileId)}/benchmark-interactive/complete`, payload, options,
);

// Fine-tuning
export const startFineTuningJob = (profileId, payload = {}, options) => api.post(
  `/voice/profiles/${encodeURIComponent(profileId)}/fine-tune/start`, payload, options,
);

// Returns the raw WAV bytes of the test utterance.
export const testTts = (text, voice, engine) => {
  const body = { text };
  if (voice) body.voice = voice;
  if (engine) body.engine = engine;
  return api.post('/voice/test', body, { responseType: 'arraybuffer', silent: true });
};

// Memory-management
export const getTtsStatus = (options) => api.get('/voice/tts/status', options);
export const unloadKokoroTts = (options) => api.post('/voice/tts/unload', {}, options);
export const controlWhisper = (action, options) => api.post('/voice/whisper', { action }, options);
export const getFaceTimeStatus = (options) => api.get('/voice/facetime/status', options);
export const controlFaceTime = (action, options) => api.post(`/voice/facetime/${action}`, {}, options);

// Voice Studio: local reusable character voices and explicit runtime setup.
export const getVoiceStudioStatus = options => api.get('/voice/studio/status', options);
export const setupVoiceStudio = options => api.post('/voice/studio/setup', {}, options);
export const unloadVoiceStudio = options => api.post('/voice/studio/unload', {}, options);
export const designStudioVoice = (payload, options) => api.post('/voice/studio/design', payload, options);
export const assignStudioVoice = (id, payload, options) => api.post(
  `/voice/profiles/${encodeURIComponent(id)}/assign`, payload, options,
);

export const listStudioVoices = ({ cursor, limit = 30 } = {}, options) => {
  const params = new URLSearchParams({ limit });
  if (cursor) params.set('cursor', cursor);
  return api.get(`/voice/studio/profiles?${params}`, options);
};
export const getStudioVoice = (id, options) => api.get(`/voice/profiles/${encodeURIComponent(id)}`, options);
