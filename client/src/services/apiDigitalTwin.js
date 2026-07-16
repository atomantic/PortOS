import { request } from './apiCore.js';

// Digital Twin - Status & Summary
export const getDigitalTwinStatus = (options) => request('/digital-twin', options);

// Digital Twin - Documents
export const getDigitalTwinDocuments = (options = {}) => request('/digital-twin/documents', options);
export const getDigitalTwinDocument = (id) => request(`/digital-twin/documents/${id}`);
export const createDigitalTwinDocument = (data, options = {}) => request('/digital-twin/documents', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});
export const updateDigitalTwinDocument = (id, data, options = {}) => request(`/digital-twin/documents/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options
});
export const deleteDigitalTwinDocument = (id) => request(`/digital-twin/documents/${id}`, { method: 'DELETE' });

// Digital Twin - Testing
export const getDigitalTwinTests = () => request('/digital-twin/tests');
export const runDigitalTwinTests = (providerId, model, testIds = null, personaId = null) => request('/digital-twin/tests/run', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, testIds, personaId })
});
export const runDigitalTwinMultiTests = (providers, testIds = null, personaId = null) => request('/digital-twin/tests/run-multi', {
  method: 'POST',
  body: JSON.stringify({ providers, testIds, personaId })
});
export const getDigitalTwinTestHistory = (limit = 10) => request(`/digital-twin/tests/history?limit=${limit}`);

// Digital Twin - Values-Alignment Testing (M34 P6)
export const getValuesAlignmentTests = (options = {}) => request('/digital-twin/values-tests', options);
export const runValuesAlignmentTests = (providerId, model, testIds = null, personaId = null, options = {}) => request('/digital-twin/values-tests/run', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, testIds, personaId }),
  ...options
});
export const getValuesAlignmentTestHistory = (limit = 10, options = {}) => request(`/digital-twin/values-tests/history?limit=${limit}`, options);

// Digital Twin - Adversarial Boundary Testing (M34 P6)
export const getAdversarialTests = (options = {}) => request('/digital-twin/adversarial-tests', options);
export const runAdversarialTests = (providerId, model, testIds = null, personaId = null, options = {}) => request('/digital-twin/adversarial-tests/run', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, testIds, personaId }),
  ...options
});
export const getAdversarialTestHistory = (limit = 10, options = {}) => request(`/digital-twin/adversarial-tests/history?limit=${limit}`, options);

// Digital Twin - Multi-Turn Conversation Testing (M34 P6)
export const getMultiTurnTests = (options = {}) => request('/digital-twin/multi-turn-tests', options);
export const runMultiTurnTests = (providerId, model, testIds = null, personaId = null, options = {}) => request('/digital-twin/multi-turn-tests/run', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, testIds, personaId }),
  ...options
});
export const getMultiTurnTestHistory = (limit = 10, options = {}) => request(`/digital-twin/multi-turn-tests/history?limit=${limit}`, options);

// Digital Twin - Enrichment
export const getDigitalTwinEnrichCategories = () => request('/digital-twin/enrich/categories');
export const getDigitalTwinEnrichProgress = () => request('/digital-twin/enrich/progress');
export const getDigitalTwinEnrichQuestion = (category, providerOverride, modelOverride, skipIndices) => request('/digital-twin/enrich/question', {
  method: 'POST',
  body: JSON.stringify({ category, providerOverride, modelOverride, ...(skipIndices?.length ? { skipIndices } : {}) })
});
export const submitDigitalTwinEnrichAnswer = (data, options = {}) => request('/digital-twin/enrich/answer', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
});

// Digital Twin - Export
export const getDigitalTwinExportFormats = () => request('/digital-twin/export/formats');
export const exportDigitalTwin = (format, documentIds = null, includeDisabled = false) => request('/digital-twin/export', {
  method: 'POST',
  body: JSON.stringify({ format, documentIds, includeDisabled })
});

// Legacy Export (portable identity bundle) — #901 Phase 1 server foundation:
// `GET /api/legacy-export/preview` + `POST /api/legacy-export`. The preview is
// cheap enough to call on page load; the bundle build streams a zip attachment.
export const getLegacyExportPreview = (options) => request('/legacy-export/preview', options);
export const downloadLegacyExport = ({ sections = null, includePdf = false } = {}, options = {}) =>
  request('/legacy-export', {
    method: 'POST',
    body: JSON.stringify({ ...(sections ? { sections } : {}), ...(includePdf ? { includePdf } : {}) }),
    responseType: 'arraybuffer',
    ...options,
  });

// Digital Twin - Settings
export const getDigitalTwinSettings = (options) => request('/digital-twin/settings', options);
export const updateDigitalTwinSettings = (settings) => request('/digital-twin/settings', {
  method: 'PUT',
  body: JSON.stringify(settings)
});

// Digital Twin - Personas (M34 P7)
export const getDigitalTwinPersonas = (options) => request('/digital-twin/personas', options);
export const getActiveDigitalTwinPersona = (options) => request('/digital-twin/personas/active', options);
export const createDigitalTwinPersona = (data) => request('/digital-twin/personas', {
  method: 'POST',
  body: JSON.stringify(data)
});
export const updateDigitalTwinPersona = (id, data) => request(`/digital-twin/personas/${id}`, {
  method: 'PUT',
  body: JSON.stringify(data)
});
export const deleteDigitalTwinPersona = (id) => request(`/digital-twin/personas/${id}`, { method: 'DELETE' });
export const setActiveDigitalTwinPersona = (personaId) => request('/digital-twin/personas/active', {
  method: 'PUT',
  body: JSON.stringify({ personaId })
});

// Digital Twin - Validation & Analysis
export const getDigitalTwinCompleteness = () => request('/digital-twin/validate/completeness');
export const detectDigitalTwinContradictions = (providerId, model) => request('/digital-twin/validate/contradictions', {
  method: 'POST',
  body: JSON.stringify({ providerId, model })
});
export const generateDigitalTwinTests = (providerId, model, options = {}) => request('/digital-twin/tests/generate', {
  method: 'POST',
  body: JSON.stringify({ providerId, model }),
  ...options
});
export const analyzeWritingSamples = (samples, providerId, model, options = {}) => request('/digital-twin/analyze-writing', {
  method: 'POST',
  body: JSON.stringify({ samples, providerId, model }),
  ...options
});
// Spoken-vs-written style comparison (M34 P5). writtenSamples is optional —
// omit it to compare the transcript against the twin's existing documents.
export const compareSpokenWrittenStyle = (payload, options = {}) => request('/digital-twin/style/spoken-written', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options
});

// Image identity source (M34 P5). Analyze a photo with a vision model to extract
// visible appearance / presentation, then optionally save it as an identity doc.
export const analyzeIdentityImage = (payload, options = {}) => request('/digital-twin/identity/image', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options
});
export const saveIdentityImageDocument = (payload, options = {}) => request('/digital-twin/identity/image/save', {
  method: 'POST',
  body: JSON.stringify(payload),
  ...options
});

// Digital Twin - List-based Enrichment
export const analyzeEnrichmentList = (category, items, providerId, model, options = {}) => request('/digital-twin/enrich/analyze-list', {
  method: 'POST',
  body: JSON.stringify({ category, items, providerId, model }),
  ...options
});
export const saveEnrichmentList = (category, content, items, options = {}) => request('/digital-twin/enrich/save-list', {
  method: 'POST',
  body: JSON.stringify({ category, content, items }),
  ...options
});
export const getEnrichmentListItems = (category) => request(`/digital-twin/enrich/list-items/${category}`);

// Digital Twin Traits & Confidence
export const getDigitalTwinTraits = () => request('/digital-twin/traits');
export const analyzeDigitalTwinTraits = (providerId, model, forceReanalyze = false, options = {}) => request('/digital-twin/traits/analyze', {
  method: 'POST',
  body: JSON.stringify({ providerId, model, forceReanalyze }),
  ...options
});
export const updateDigitalTwinTraits = (updates, options = {}) => request('/digital-twin/traits', {
  method: 'PUT',
  body: JSON.stringify(updates),
  ...options
});
export const getDigitalTwinConfidence = () => request('/digital-twin/confidence');
export const calculateDigitalTwinConfidence = (providerId, model, options = {}) => request('/digital-twin/confidence/calculate', {
  method: 'POST',
  body: JSON.stringify({ providerId, model }),
  ...options
});
export const getDigitalTwinGaps = () => request('/digital-twin/gaps');

// Digital Twin External Import
export const getDigitalTwinImportSources = () => request('/digital-twin/import/sources');
export const analyzeDigitalTwinImport = (source, data, providerId, model, options = {}) => request('/digital-twin/import/analyze', {
  method: 'POST',
  body: JSON.stringify({ source, data, providerId, model }),
  ...options
});
export const saveDigitalTwinImport = (source, suggestedDoc, options = {}) => request('/digital-twin/import/save', {
  method: 'POST',
  body: JSON.stringify({ source, suggestedDoc }),
  ...options
});

// Digital Twin - Behavioral Feedback Loop
export const submitBehavioralFeedback = (data, options = {}) => request('/digital-twin/feedback', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options
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
export const submitTasteAnswer = (section, questionId, answer, meta = {}, options = {}) => request('/digital-twin/taste/answer', {
  method: 'POST',
  body: JSON.stringify({ section, questionId, answer, ...meta }),
  ...options
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
export const updateAutobiographyConfig = (config, options = {}) => request('/digital-twin/autobiography/config', {
  method: 'PUT',
  body: JSON.stringify(config),
  ...options
});
export const getAutobiographyThemes = () => request('/digital-twin/autobiography/themes');
export const getAutobiographyPrompt = (exclude, options = {}) =>
  request(`/digital-twin/autobiography/prompt${exclude ? `?exclude=${exclude}` : ''}`, options);
export const getAutobiographyPromptById = (id) => request(`/digital-twin/autobiography/prompt/${id}`);
export const getAutobiographyStories = (theme = null) =>
  request(`/digital-twin/autobiography/stories${theme ? `?theme=${theme}` : ''}`);
export const saveAutobiographyStory = (promptId, content, { parentStoryId, customPromptText } = {}, options = {}) =>
  request('/digital-twin/autobiography/stories', {
    method: 'POST',
    body: JSON.stringify({ promptId, content, parentStoryId, customPromptText }),
    ...options
  });
export const updateAutobiographyStory = (id, content, options = {}) => request(`/digital-twin/autobiography/stories/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ content }),
  ...options
});
export const deleteAutobiographyStory = (id, options = {}) => request(`/digital-twin/autobiography/stories/${id}`, {
  method: 'DELETE',
  ...options
});
export const triggerAutobiographyPrompt = () => request('/digital-twin/autobiography/trigger', {
  method: 'POST'
});
export const generateAutobiographyFollowUps = (storyId, providerId, options = {}) =>
  request(`/digital-twin/autobiography/stories/${storyId}/follow-ups`, {
    method: 'POST',
    body: JSON.stringify({ providerId }),
    ...options
  });
export const getAutobiographyStoryChain = (storyId) =>
  request(`/digital-twin/autobiography/stories/${storyId}/chain`);
export const weaveAutobiographyNarrative = (storyId, providerId) =>
  request(`/digital-twin/autobiography/stories/${storyId}/weave`, {
    method: 'POST',
    body: JSON.stringify({ providerId })
  });

// Digital Twin - Assessment Analyzer
export const analyzeAssessment = (content, providerId, model, options = {}) =>
  request('/digital-twin/interview/analyze', {
    method: 'POST',
    body: JSON.stringify({ content, providerId, model }),
    ...options
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

// Twin enrichment — observed taste + chronotype evidence (Phase 7, #2156)
export const getTwinEvidence = (options) => request('/digital-twin/twin-evidence', options);
export const recomputeTwinEvidence = (options = {}) => request('/digital-twin/twin-evidence/recompute', {
  method: 'POST',
  body: JSON.stringify({}),
  ...options
});
export const interpretTwinConsumption = (providerId, model, options = {}) => request('/digital-twin/twin-evidence/interpret', {
  method: 'POST',
  body: JSON.stringify({ providerId, model }),
  ...options
});

// Soul aliases (used by digital-twin UI components)
export const createSoulDocument = createDigitalTwinDocument;
export const updateSoulDocument = updateDigitalTwinDocument;
export const deleteSoulDocument = deleteDigitalTwinDocument;
export const updateSoulSettings = updateDigitalTwinSettings;
export const detectSoulContradictions = detectDigitalTwinContradictions;
export const submitSoulEnrichAnswer = submitDigitalTwinEnrichAnswer;
export const runSoulTests = runDigitalTwinTests;
export const runSoulMultiTests = runDigitalTwinMultiTests;
export const generateSoulTests = generateDigitalTwinTests;
export const exportSoul = exportDigitalTwin;
