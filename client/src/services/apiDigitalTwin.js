import { request } from './apiCore.js';

// Digital Twin - Status & Summary
export const getDigitalTwinStatus = () => request('/digital-twin');
export const getSoulStatus = getDigitalTwinStatus; // Alias for backwards compatibility

// Digital Twin - Documents
export const getDigitalTwinDocuments = () => request('/digital-twin/documents');
export const getSoulDocuments = getDigitalTwinDocuments;
export const getDigitalTwinDocument = (id) => request(`/digital-twin/documents/${id}`);
export const getSoulDocument = getDigitalTwinDocument;
export const createDigitalTwinDocument = (data) => request('/digital-twin/documents', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const createSoulDocument = createDigitalTwinDocument;
export const updateDigitalTwinDocument = (id, data) => request(`/digital-twin/documents/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const updateSoulDocument = updateDigitalTwinDocument;
export const deleteDigitalTwinDocument = (id) => request(`/digital-twin/documents/${id}`, { method: 'DELETE' });
export const deleteSoulDocument = deleteDigitalTwinDocument;

// Digital Twin - Testing
export const getDigitalTwinTests = () => request('/digital-twin/tests');
export const getSoulTests = getDigitalTwinTests;
export const runDigitalTwinTests = (providerId, model, testIds = null) => request('/digital-twin/tests/run', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, testIds })
});
export const runSoulTests = runDigitalTwinTests;
export const runDigitalTwinMultiTests = (providers, testIds = null) => request('/digital-twin/tests/run-multi', {
  method: 'POST',
  body: JSON.stringify({ providers, testIds })
});
export const runSoulMultiTests = runDigitalTwinMultiTests;
export const getDigitalTwinTestHistory = (limit = 10) => request(`/digital-twin/tests/history?limit=${limit}`);
export const getSoulTestHistory = getDigitalTwinTestHistory;

// Digital Twin - Enrichment
export const getDigitalTwinEnrichCategories = () => request('/digital-twin/enrich/categories');
export const getSoulEnrichCategories = getDigitalTwinEnrichCategories;
export const getDigitalTwinEnrichProgress = () => request('/digital-twin/enrich/progress');
export const getSoulEnrichProgress = getDigitalTwinEnrichProgress;
export const getDigitalTwinEnrichQuestion = (category, providerOverride, modelOverride, skipIndices) => request('/digital-twin/enrich/question', {
  method: 'POST',
  body: JSON.stringify({ category, providerOverride, modelOverride, ...(skipIndices?.length ? { skipIndices } : {}) })
});
export const getSoulEnrichQuestion = getDigitalTwinEnrichQuestion;
export const submitDigitalTwinEnrichAnswer = (data) => request('/digital-twin/enrich/answer', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const submitSoulEnrichAnswer = submitDigitalTwinEnrichAnswer;

// Digital Twin - Export
export const getDigitalTwinExportFormats = () => request('/digital-twin/export/formats');
export const getSoulExportFormats = getDigitalTwinExportFormats;
export const exportDigitalTwin = (format, documentIds = null, includeDisabled = false) => request('/digital-twin/export', {
  method: 'POST',
  body: JSON.stringify({ format, documentIds, includeDisabled })
});
export const exportSoul = exportDigitalTwin;

// Digital Twin - Settings
export const getDigitalTwinSettings = () => request('/digital-twin/settings');
export const getSoulSettings = getDigitalTwinSettings;
export const updateDigitalTwinSettings = (settings) => request('/digital-twin/settings', {
  method: 'PUT',
  body: JSON.stringify(settings)
});
export const updateSoulSettings = updateDigitalTwinSettings;

// Digital Twin - Validation & Analysis
export const getDigitalTwinCompleteness = () => request('/digital-twin/validate/completeness');
export const getSoulCompleteness = getDigitalTwinCompleteness;
export const detectDigitalTwinContradictions = (providerId, model) => request('/digital-twin/validate/contradictions', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const detectSoulContradictions = detectDigitalTwinContradictions;
export const generateDigitalTwinTests = (providerId, model) => request('/digital-twin/tests/generate', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const generateSoulTests = generateDigitalTwinTests;
export const analyzeWritingSamples = (samples, providerId, model) => request('/digital-twin/analyze-writing', {
  method: 'POST',
  body: JSON.stringify({ samples, providerId, model })
});

// Digital Twin - List-based Enrichment
export const analyzeEnrichmentList = (category, items, providerId, model) => request('/digital-twin/enrich/analyze-list', {
  method: 'POST',
  body: JSON.stringify({ category, items, providerId, model })
});
export const saveEnrichmentList = (category, content, items) => request('/digital-twin/enrich/save-list', {
  method: 'POST',
  body: JSON.stringify({ category, content, items })
});
export const getEnrichmentListItems = (category) => request(`/digital-twin/enrich/list-items/${category}`);

// Digital Twin Traits & Confidence
export const getDigitalTwinTraits = () => request('/digital-twin/traits');
export const analyzeDigitalTwinTraits = (providerId, model, forceReanalyze = false) => request('/digital-twin/traits/analyze', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, forceReanalyze })
});
export const updateDigitalTwinTraits = (updates) => request('/digital-twin/traits', {
  method: 'PUT',
  body: JSON.stringify(updates)
});
export const getDigitalTwinConfidence = () => request('/digital-twin/confidence');
export const calculateDigitalTwinConfidence = (providerId, model) => request('/digital-twin/confidence/calculate', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const getDigitalTwinGaps = () => request('/digital-twin/gaps');

// Digital Twin External Import
export const getDigitalTwinImportSources = () => request('/digital-twin/import/sources');
export const analyzeDigitalTwinImport = (source, data, providerId, model) => request('/digital-twin/import/analyze', {
  method: 'POST',
  body: JSON.stringify({ source, data, providerId, model })
});
export const saveDigitalTwinImport = (source, suggestedDoc) => request('/digital-twin/import/save', {
  method: 'POST',
  body: JSON.stringify({ source, suggestedDoc })
});

// Digital Twin - Behavioral Feedback Loop
export const submitBehavioralFeedback = (data) => request('/digital-twin/feedback', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const getBehavioralFeedbackStats = () => request('/digital-twin/feedback/stats');
export const recalculateFeedbackWeights = () => request('/digital-twin/feedback/recalculate', {
  method: 'POST'
});
export const getRecentFeedback = (contentType, limit) => {
  const params = new URLSearchParams();
  if (contentType) params.set('contentType', contentType);
  if (limit) params.set('limit', limit);
  return request(`/digital-twin/feedback/recent?${params}`);
};

// Digital Twin - Taste Questionnaire
export const getTasteProfile = () => request('/digital-twin/taste');
export const getTasteSections = () => request('/digital-twin/taste/sections');
export const getTasteNextQuestion = (section) => request(`/digital-twin/taste/${section}/next`);
export const submitTasteAnswer = (section, questionId, answer, meta = {}) => request('/digital-twin/taste/answer', {
  method: 'POST',
  body: JSON.stringify({ section, questionId, answer, ...meta })
});
export const getTasteSectionResponses = (section) => request(`/digital-twin/taste/${section}/responses`);
export const generateTasteSummary = (providerId, model, section) => request('/digital-twin/taste/summary', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, ...(section ? { section } : {}) })
});
export const getPersonalizedTasteQuestion = (section, providerId, model) =>
  request(`/digital-twin/taste/${section}/personalized-question`, {
    method: 'POST',
    body: JSON.stringify({ providerId, model })
  });
export const resetTasteSection = (section) => request(`/digital-twin/taste/${section}`, {
  method: 'DELETE'
});

// Digital Twin - Autobiography
export const getAutobiographyStats = () => request('/digital-twin/autobiography');
export const getAutobiographyConfig = () => request('/digital-twin/autobiography/config');
export const updateAutobiographyConfig = (config) => request('/digital-twin/autobiography/config', {
  method: 'PUT',
  body: JSON.stringify(config)
});
export const getAutobiographyThemes = () => request('/digital-twin/autobiography/themes');
export const getAutobiographyPrompt = (exclude) =>
  request(`/digital-twin/autobiography/prompt${exclude ? `?exclude=${exclude}` : ''}`);
export const getAutobiographyPromptById = (id) => request(`/digital-twin/autobiography/prompt/${id}`);
export const getAutobiographyStories = (theme = null) =>
  request(`/digital-twin/autobiography/stories${theme ? `?theme=${theme}` : ''}`);
export const saveAutobiographyStory = (promptId, content, { parentStoryId, customPromptText } = {}) =>
  request('/digital-twin/autobiography/stories', {
    method: 'POST',
    body: JSON.stringify({ promptId, content, parentStoryId, customPromptText })
  });
export const updateAutobiographyStory = (id, content) => request(`/digital-twin/autobiography/stories/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ content })
});
export const deleteAutobiographyStory = (id) => request(`/digital-twin/autobiography/stories/${id}`, {
  method: 'DELETE'
});
export const triggerAutobiographyPrompt = () => request('/digital-twin/autobiography/trigger', {
  method: 'POST'
});
export const generateAutobiographyFollowUps = (storyId, providerId) =>
  request(`/digital-twin/autobiography/stories/${storyId}/follow-ups`, {
    method: 'POST',
    body: JSON.stringify({ providerId })
  });
export const getAutobiographyStoryChain = (storyId) =>
  request(`/digital-twin/autobiography/stories/${storyId}/chain`);

// Digital Twin - Assessment Analyzer
export const analyzeAssessment = (content, providerId, model) =>
  request('/digital-twin/interview/analyze', {
    method: 'POST',
    body: JSON.stringify({ content, providerId, model })
  });

// Digital Twin - Social Accounts
export const getSocialAccounts = (params = {}) => {
  const qs = new URLSearchParams(params).toString();
  return request(`/digital-twin/social-accounts${qs ? `?${qs}` : ''}`);
};
export const getSocialAccountPlatforms = () => request('/digital-twin/social-accounts/platforms');
export const getSocialAccountStats = () => request('/digital-twin/social-accounts/stats');
export const getSocialAccount = (id) => request(`/digital-twin/social-accounts/${id}`);
export const createSocialAccount = (data) => request('/digital-twin/social-accounts', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const createSocialAccountsBulk = (accounts) => request('/digital-twin/social-accounts/bulk', {
  method: 'POST',
  body: JSON.stringify({ accounts })
});
export const updateSocialAccount = (id, data) => request(`/digital-twin/social-accounts/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteSocialAccount = (id) => request(`/digital-twin/social-accounts/${id}`, {
  method: 'DELETE'
});

// Digital Twin - Time Capsule Snapshots
export const listTimeCapsuleSnapshots = () => request('/digital-twin/snapshots');
export const createTimeCapsuleSnapshot = (label, description = '') => request('/digital-twin/snapshots', {
  method: 'POST',
  body: JSON.stringify({ label, description })
});
export const getTimeCapsuleSnapshot = (id) => request(`/digital-twin/snapshots/${id}`);
export const deleteTimeCapsuleSnapshot = (id) => request(`/digital-twin/snapshots/${id}`, {
  method: 'DELETE'
});
export const compareTimeCapsuleSnapshots = (id1, id2) => request('/digital-twin/snapshots/compare', {
  method: 'POST',
  body: JSON.stringify({ id1, id2 })
});
