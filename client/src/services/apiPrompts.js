import { request } from './apiCore.js';

// Prompt stages, variables, and job skills for the Prompt Manager and the
// inline StagePromptModelPicker. The `/api/providers` list these surfaces also
// need lives in apiProviders.js (`getProviders`) — reuse it rather than
// re-wrapping the same endpoint here.
//
// `options` (e.g. { silent: true }) lets callers that own their own error UI
// (custom catch + toast) suppress the request() helper's default toast.

// Stages
export const getPrompts = (options) => request('/prompts', options);
export const getPrompt = (stage, options) => request(`/prompts/${encodeURIComponent(stage)}`, options);
export const createPrompt = (data, options = {}) => request('/prompts', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});
export const savePrompt = (stage, data, options = {}) => request(`/prompts/${encodeURIComponent(stage)}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options,
});
export const deletePrompt = (stage, { force = false } = {}, options = {}) =>
  request(`/prompts/${encodeURIComponent(stage)}${force ? '?force=true' : ''}`, { method: 'DELETE', ...options });
export const previewPrompt = (stage, testData = {}, options = {}) => request(`/prompts/${encodeURIComponent(stage)}/preview`, {
  method: 'POST',
  body: JSON.stringify({ testData }),
  ...options,
});
export const getPromptUsage = (stage, options) => request(`/prompts/${encodeURIComponent(stage)}/usage`, options);

// Variables
export const getPromptVariables = (options) => request('/prompts/variables', options);
export const createPromptVariable = (data, options = {}) => request('/prompts/variables', {
  method: 'POST',
  body: JSON.stringify(data),
  ...options,
});
export const savePromptVariable = (key, data, options = {}) => request(`/prompts/variables/${encodeURIComponent(key)}`, {
  method: 'PUT',
  body: JSON.stringify(data),
  ...options,
});
export const deletePromptVariable = (key, options = {}) => request(`/prompts/variables/${encodeURIComponent(key)}`, {
  method: 'DELETE',
  ...options,
});

// Autonomous job-skill prompt templates
export const getJobSkills = (options) => request('/prompts/skills/jobs', options);
export const getJobSkill = (name, options) => request(`/prompts/skills/jobs/${encodeURIComponent(name)}`, options);
export const saveJobSkill = (name, content, options = {}) => request(`/prompts/skills/jobs/${encodeURIComponent(name)}`, {
  method: 'PUT',
  body: JSON.stringify({ content }),
  ...options,
});
export const previewJobSkill = (name, options) => request(`/prompts/skills/jobs/${encodeURIComponent(name)}/preview`, options);
