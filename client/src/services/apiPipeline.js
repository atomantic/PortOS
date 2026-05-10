import { request } from './apiCore.js';

// Stage IDs mirror server/services/pipeline/issues.js — keep these in sync.
export const PIPELINE_TEXT_STAGES = Object.freeze(['idea', 'prose', 'comicScript', 'tvScript']);
export const PIPELINE_VISUAL_STAGES = Object.freeze(['comicPages', 'storyboards', 'episodeVideo']);
export const PIPELINE_STAGES = Object.freeze([...PIPELINE_TEXT_STAGES, ...PIPELINE_VISUAL_STAGES]);

export const PIPELINE_STAGE_LABELS = Object.freeze({
  idea: 'Idea',
  prose: 'Prose',
  comicScript: 'Comic Script',
  tvScript: 'TV Script',
  comicPages: 'Comic Pages',
  storyboards: 'Storyboards',
  episodeVideo: 'Episode Video',
});

export const PIPELINE_TARGET_FORMATS = Object.freeze(['comic', 'tv', 'comic+tv']);

// ---- Series ----
export const listPipelineSeries = () => request('/pipeline/series');
export const getPipelineSeries = (id) => request(`/pipeline/series/${encodeURIComponent(id)}`);
export const createPipelineSeries = (data) => request('/pipeline/series', {
  method: 'POST',
  body: JSON.stringify(data),
});
export const updatePipelineSeries = (id, patch) => request(`/pipeline/series/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(patch),
});
export const deletePipelineSeries = (id) => request(`/pipeline/series/${encodeURIComponent(id)}`, {
  method: 'DELETE',
});

// ---- Issues ----
export const listPipelineIssues = (seriesId) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/issues`);

export const createPipelineIssue = (seriesId, data) =>
  request(`/pipeline/series/${encodeURIComponent(seriesId)}/issues`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const getPipelineIssue = (id) => request(`/pipeline/issues/${encodeURIComponent(id)}`);

export const updatePipelineIssue = (id, patch) =>
  request(`/pipeline/issues/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

export const deletePipelineIssue = (id) =>
  request(`/pipeline/issues/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ---- Stage operations ----
export const generatePipelineStage = (issueId, stageId, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/generate`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

export const generatePipelineVisualImage = (issueId, stageId, opts) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/stages/${encodeURIComponent(stageId)}/visual`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

// ---- Auto-run text chain ----
export const startPipelineAutoRunText = (issueId, opts = {}) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/auto-run-text`, {
    method: 'POST',
    body: JSON.stringify(opts),
  });

export const cancelPipelineAutoRunText = (issueId) =>
  request(`/pipeline/issues/${encodeURIComponent(issueId)}/auto-run-text/cancel`, {
    method: 'POST',
  });

export const pipelineAutoRunSseUrl = (issueId) =>
  `/api/pipeline/issues/${encodeURIComponent(issueId)}/auto-run-text/progress`;
