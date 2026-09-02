import { request } from './apiCore.js';

// MeatSpace - Genome
export const getGenomeSummary = () => request('/meatspace/genome');
export const uploadGenomeFile = (content, filename) => request('/meatspace/genome/upload', {
  method: 'POST',
  body: JSON.stringify({ content, filename })
});
export const scanGenomeMarkers = () => request('/meatspace/genome/scan', { method: 'POST' });
export const searchGenomeSNP = (rsid) => request('/meatspace/genome/search', {
  method: 'POST',
  body: JSON.stringify({ rsid })
});
export const saveGenomeMarker = (data) => request('/meatspace/genome/markers', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateGenomeMarkerNotes = (id, notes, options = {}) => request(`/meatspace/genome/markers/${id}/notes`, {
  method: 'PUT',
  body: JSON.stringify({ notes }),
  ...options
});
export const deleteGenomeMarker = (id) => request(`/meatspace/genome/markers/${id}`, { method: 'DELETE' });
export const deleteGenomeData = () => request('/meatspace/genome', { method: 'DELETE' });

// MeatSpace - Genome ClinVar
export const getClinvarStatus = () => request('/meatspace/genome/clinvar/status');
export const syncClinvar = () => request('/meatspace/genome/clinvar/sync', { method: 'POST' });
export const scanClinvar = () => request('/meatspace/genome/clinvar/scan', { method: 'POST' });

// MeatSpace - Epigenetic Lifestyle Tracking
export const getEpigeneticInterventions = () => request('/meatspace/genome/epigenetic');
export const getEpigeneticRecommendations = (categories = []) =>
  request(`/meatspace/genome/epigenetic/recommendations${categories.length ? `?categories=${categories.join(',')}` : ''}`);
export const getEpigeneticCompliance = (days = 30) =>
  request(`/meatspace/genome/epigenetic/compliance?days=${days}`);
export const addEpigeneticIntervention = (data) => request('/meatspace/genome/epigenetic', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const logEpigeneticEntry = (id, entry) => request(`/meatspace/genome/epigenetic/${id}/log`, {
  method: 'POST',
  body: JSON.stringify(entry)
});
export const updateEpigeneticIntervention = (id, updates) => request(`/meatspace/genome/epigenetic/${id}`, {
  method: 'PUT',
  body: JSON.stringify(updates)
});
export const deleteEpigeneticIntervention = (id) => request(`/meatspace/genome/epigenetic/${id}`, {
  method: 'DELETE'
});

// MeatSpace - Health Tracker
export const getMeatspaceOverview = () => request('/meatspace');
export const getMeatspaceConfig = () => request('/meatspace/config');
export const updateMeatspaceConfig = (data) => request('/meatspace/config', {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const getMeatspaceBirthDate = () => request('/meatspace/birth-date');
export const setMeatspaceBirthDate = (birthDate) => request('/meatspace/birth-date', {
  method: 'PUT',
  body: JSON.stringify({ birthDate })
});
export const getDeathClock = () => request('/meatspace/death-clock');
export const getMeatspaceLoggingStats = (options = {}) => request('/meatspace/logging-stats', options);
export const getAlcoholSummary = () => request('/meatspace/alcohol');
export const getDailyAlcohol = (from, to) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/meatspace/alcohol/daily?${params}`);
};
export const logAlcoholDrink = (data) => request('/meatspace/alcohol/log', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateAlcoholDrink = (date, index, data) => request(`/meatspace/alcohol/log/${date}/${index}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const removeAlcoholDrink = (date, index) => request(`/meatspace/alcohol/log/${date}/${index}`, {
  method: 'DELETE'
});
export const getCustomDrinks = () => request('/meatspace/alcohol/custom-drinks');
export const addCustomDrink = (data, options = {}) => request('/meatspace/alcohol/custom-drinks', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateCustomDrink = (index, data, options = {}) => request(`/meatspace/alcohol/custom-drinks/${index}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const removeCustomDrink = (index) => request(`/meatspace/alcohol/custom-drinks/${index}`, {
  method: 'DELETE'
});
export const getNicotineSummary = () => request('/meatspace/nicotine');
export const getDailyNicotine = (from, to) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/meatspace/nicotine/daily?${params}`);
};
export const logNicotine = (data) => request('/meatspace/nicotine/log', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateNicotineEntry = (date, index, data) => request(`/meatspace/nicotine/log/${date}/${index}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const removeNicotineEntry = (date, index) => request(`/meatspace/nicotine/log/${date}/${index}`, {
  method: 'DELETE'
});
export const getCustomNicotineProducts = () => request('/meatspace/nicotine/custom-products');
export const addCustomNicotineProduct = (data, options = {}) => request('/meatspace/nicotine/custom-products', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateCustomNicotineProduct = (index, data, options = {}) => request(`/meatspace/nicotine/custom-products/${index}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const removeCustomNicotineProduct = (index) => request(`/meatspace/nicotine/custom-products/${index}`, {
  method: 'DELETE'
});
export const getBloodTests = () => request('/meatspace/blood');
export const getBodyHistory = () => request('/meatspace/body');
export const getBloodPressure = () => request('/meatspace/blood-pressure');
export const addBloodPressure = (data) => request('/meatspace/blood-pressure', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getWorkouts = () => request('/meatspace/workouts');
export const getEpigeneticTests = () => request('/meatspace/epigenetic');
export const getEyeExams = () => request('/meatspace/eyes');
export const addEyeExam = (data) => request('/meatspace/eyes', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateEyeExam = (index, data) => request(`/meatspace/eyes/${index}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const removeEyeExam = (index) => request(`/meatspace/eyes/${index}`, {
  method: 'DELETE'
});

// MeatSpace - POST (Power On Self Test)
export const getPostConfig = () => request('/meatspace/post/config');
export const getPostBenchmarkProtocol = (options = {}) => request('/meatspace/post/benchmark/protocol', options);
// `options` lets a caller that owns its own error UI pass `{ silent: true }` so
// the failure only toasts once (see AGENTS.md's silent-vs-toasting convention).
export const updatePostConfig = (data, options = {}) => request('/meatspace/post/config', {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const getPostSessions = (from, to) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/meatspace/post/sessions?${params}`);
};
export const getPostSession = (id, options = {}) => request(`/meatspace/post/sessions/${id}`, options);
export const submitPostSession = (data, options = {}) => request('/meatspace/post/sessions', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const getPostStats = (days) => request(`/meatspace/post/stats${days != null ? `?days=${days}` : ''}`);
export const getPostProgress = (days, options = {}) => request(
  `/meatspace/post/progress${days != null ? `?days=${days}` : ''}`,
  options
);
export const getPostAdaptivePreview = () => request('/meatspace/post/adaptive-preview');
// Mastered-but-inactive skills due for a maintenance review (issue #2096). The
// launcher mixes these into a Quick session as labeled review reps. Silent — the
// caller degrades to a normal Quick session if this fails.
export const getPostReviewReps = (limit, options = {}) => request(
  `/meatspace/post/review/reps${limit != null ? `?limit=${limit}` : ''}`,
  { silent: true, ...options }
);
// Ordered "what to practice next" recommendations (issue #2100). Silent — the
// launcher/widget degrade gracefully (hide the panel) if this fails.
export const getPostRecommendations = (limit, options = {}) => request(
  `/meatspace/post/recommendations${limit != null ? `?limit=${limit}` : ''}`,
  { silent: true, ...options }
);
export const getPostMultiplicationProgress = () => request('/meatspace/post/multiplication-progress');
export const getPostPowersProgress = () => request('/meatspace/post/powers-progress');
// `options` so a caller with its own catch can pass `{ silent: true }` and not
// double-report — both current callers fetch this in the background.
export const getPostCognitiveProgress = (options) => request('/meatspace/post/cognitive-progress', options);
export const generatePostDrill = (type, config = {}, providerId, model, options = {}) => request('/meatspace/post/drill', {
  method: 'POST',
  body: JSON.stringify({ type, config, ...(providerId && { providerId }), ...(model && { model }) }),
  ...options
});
export const scorePostLlmDrill = (type, drillData, responses, timeLimitMs, providerId, model, options = {}) =>
  request('/meatspace/post/score-llm', {
    method: 'POST',
    body: JSON.stringify({ type, drillData, responses, timeLimitMs, ...(providerId && { providerId }), ...(model && { model }) }),
    ...options
  });
// Standalone rhetoric attempts are evaluated one at a time in the trainer's
// background queue. Callers own the inline failure state, so they should pass
// `{ silent: true }` here rather than making a provider hiccup interrupt the
// next prompt.
export const evaluateRhetoricAttempt = (data, options = {}) => request('/meatspace/post/rhetoric/evaluate', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const getPostDrillCacheStatus = () => request('/meatspace/post/drill-cache/status');
export const fillPostDrillCache = (types, providerId, model) => request('/meatspace/post/drill-cache/fill', {
  method: 'POST',
  body: JSON.stringify({ ...(types && { types }), ...(providerId && { providerId }), ...(model && { model }) })
});

// MeatSpace - POST Memory Builder
export const getMemoryItems = (options = {}) => request('/meatspace/post/memory-items', options);
export const getMemoryItem = (id) => request(`/meatspace/post/memory-items/${id}`);
export const createMemoryItem = (data) => request('/meatspace/post/memory-items', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const deleteMemoryItem = (id) => request(`/meatspace/post/memory-items/${id}`, {
  method: 'DELETE'
});
export const submitMemoryPractice = (id, data) => request(`/meatspace/post/memory-items/${id}/practice`, {
  method: 'POST',
  body: JSON.stringify(data)
});
export const attestMemoryMastery = (id, options = {}) => request(`/meatspace/post/memory-items/${id}/attest-mastery`, {
  method: 'POST',
  body: JSON.stringify({ acknowledged: true }),
  ...options
});
export const getMemoryMastery = (id) => request(`/meatspace/post/memory-items/${id}/mastery`);
export const getChunkMastery = (id) => request(`/meatspace/post/memory-items/${id}/chunk-mastery`);

// MeatSpace - POST Training Log
export const submitTrainingEntry = (data, options = {}) => request('/meatspace/post/training', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const submitTrainingRun = (data, options = {}) => request('/meatspace/post/training/runs', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const getTrainingStats = (days) => request(`/meatspace/post/training/stats${days != null ? `?days=${days}` : ''}`);

// MeatSpace - POST Morse Trainer progress (server-side Koch level, round history,
// accuracy/WPM trends, per-character confusion matrix). Callers own their error
// UI (fire-and-forget from the trainer), so pass { silent: true }.
export const submitMorseRound = (data, options = {}) => request('/meatspace/post/morse/rounds', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const getMorseProgress = (days, options = {}) => request(
  `/meatspace/post/morse/progress${days != null ? `?days=${days}` : ''}`,
  options
);
export const updateMorseLevel = (data, options = {}) => request('/meatspace/post/morse/level', {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});

// Life Calendar
export const getLifeCalendar = () => request('/meatspace/calendar');
export const getActivities = () => request('/meatspace/activities');
export const addActivity = (data) => request('/meatspace/activities', {
  method: 'POST', body: JSON.stringify(data)
});
export const removeActivity = (index) => request(`/meatspace/activities/${index}`, { method: 'DELETE' });
export const addLifeEvent = (data) => request('/meatspace/life-events', {
  method: 'POST', body: JSON.stringify(data)
});
export const updateLifeEvent = (id, data) => request(`/meatspace/life-events/${id}`, {
  method: 'PUT', body: JSON.stringify(data)
});
export const removeLifeEvent = (id) => request(`/meatspace/life-events/${id}`, { method: 'DELETE' });
