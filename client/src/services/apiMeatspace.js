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
export const updateGenomeMarkerNotes = (id, notes) => request(`/meatspace/genome/markers/${id}/notes`, {
  method: 'PUT',
  body: JSON.stringify({ notes })
});
export const deleteGenomeMarker = (id) => request(`/meatspace/genome/markers/${id}`, { method: 'DELETE' });
export const deleteGenomeData = () => request('/meatspace/genome', { method: 'DELETE' });

// MeatSpace - Genome ClinVar
export const getClinvarStatus = () => request('/meatspace/genome/clinvar/status');
export const syncClinvar = () => request('/meatspace/genome/clinvar/sync', { method: 'POST' });
export const scanClinvar = () => request('/meatspace/genome/clinvar/scan', { method: 'POST' });
export const deleteClinvar = () => request('/meatspace/genome/clinvar', { method: 'DELETE' });

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
export const updateMeatspaceLifestyle = (data) => request('/meatspace/lifestyle', {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const getMeatspaceBirthDate = () => request('/meatspace/birth-date');
export const setMeatspaceBirthDate = (birthDate) => request('/meatspace/birth-date', {
  method: 'PUT',
  body: JSON.stringify({ birthDate })
});
export const getDeathClock = () => request('/meatspace/death-clock');
export const getLEV = () => request('/meatspace/lev');
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
export const addCustomDrink = (data) => request('/meatspace/alcohol/custom-drinks', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateCustomDrink = (index, data) => request(`/meatspace/alcohol/custom-drinks/${index}`, {
  method: 'PUT',
  body: JSON.stringify(data)
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
export const addCustomNicotineProduct = (data) => request('/meatspace/nicotine/custom-products', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateCustomNicotineProduct = (index, data) => request(`/meatspace/nicotine/custom-products/${index}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const removeCustomNicotineProduct = (index) => request(`/meatspace/nicotine/custom-products/${index}`, {
  method: 'DELETE'
});
export const getBloodTests = () => request('/meatspace/blood');
export const addBloodTest = (data) => request('/meatspace/blood', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getBodyHistory = () => request('/meatspace/body');
export const addBodyEntry = (data) => request('/meatspace/body', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getBloodPressure = () => request('/meatspace/blood-pressure');
export const addBloodPressure = (data) => request('/meatspace/blood-pressure', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getEpigeneticTests = () => request('/meatspace/epigenetic');
export const addEpigeneticTest = (data) => request('/meatspace/epigenetic', {
  method: 'POST',
  body: JSON.stringify(data)
});
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
export const updatePostConfig = (data) => request('/meatspace/post/config', {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const getPostSessions = (from, to) => {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return request(`/meatspace/post/sessions?${params}`);
};
export const getPostSession = (id) => request(`/meatspace/post/sessions/${id}`);
export const submitPostSession = (data) => request('/meatspace/post/sessions', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getPostStats = (days) => request(`/meatspace/post/stats${days != null ? `?days=${days}` : ''}`);
export const generatePostDrill = (type, config = {}, providerId, model) => request('/meatspace/post/drill', {
  method: 'POST',
  body: JSON.stringify({ type, config, ...(providerId && { providerId }), ...(model && { model }) })
});
export const scorePostLlmDrill = (type, drillData, responses, timeLimitMs, providerId, model) =>
  request('/meatspace/post/score-llm', {
    method: 'POST',
    body: JSON.stringify({ type, drillData, responses, timeLimitMs, ...(providerId && { providerId }), ...(model && { model }) })
  });

// MeatSpace - POST Memory Builder
export const getMemoryItems = () => request('/meatspace/post/memory-items');
export const getMemoryItem = (id) => request(`/meatspace/post/memory-items/${id}`);
export const createMemoryItem = (data) => request('/meatspace/post/memory-items', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateMemoryItem = (id, data) => request(`/meatspace/post/memory-items/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteMemoryItem = (id) => request(`/meatspace/post/memory-items/${id}`, {
  method: 'DELETE'
});
export const submitMemoryPractice = (id, data) => request(`/meatspace/post/memory-items/${id}/practice`, {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getMemoryMastery = (id) => request(`/meatspace/post/memory-items/${id}/mastery`);
export const getChunkMastery = (id) => request(`/meatspace/post/memory-items/${id}/chunk-mastery`);
export const generateMemoryDrill = (data) => request('/meatspace/post/memory-drill', {
  method: 'POST',
  body: JSON.stringify(data)
});

// MeatSpace - POST Training Log
export const submitTrainingEntry = (data) => request('/meatspace/post/training', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getTrainingStats = (days) => request(`/meatspace/post/training/stats${days != null ? `?days=${days}` : ''}`);
export const getTrainingEntries = (limit) => request(`/meatspace/post/training/entries${limit ? `?limit=${limit}` : ''}`);

// Life Calendar
export const getLifeCalendar = () => request('/meatspace/calendar');
export const getActivities = () => request('/meatspace/activities');
export const addActivity = (data) => request('/meatspace/activities', {
  method: 'POST', body: JSON.stringify(data)
});
export const updateActivity = (index, data) => request(`/meatspace/activities/${index}`, {
  method: 'PUT', body: JSON.stringify(data)
});
export const removeActivity = (index) => request(`/meatspace/activities/${index}`, { method: 'DELETE' });

// Life Events
export const getLifeEvents = () => request('/meatspace/life-events');
export const addLifeEvent = (data) => request('/meatspace/life-events', {
  method: 'POST', body: JSON.stringify(data)
});
export const updateLifeEvent = (id, data) => request(`/meatspace/life-events/${id}`, {
  method: 'PUT', body: JSON.stringify(data)
});
export const removeLifeEvent = (id) => request(`/meatspace/life-events/${id}`, { method: 'DELETE' });
