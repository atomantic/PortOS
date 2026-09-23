import { request } from './apiCore.js';

// Code Animation — build an LLM prompt for a procedurally coded animation film
// styled by a universe (plus mood board, references, audio), and optionally run
// it on a provider to get the film's HTML. `options` is forwarded to the
// request helper so callers owning their error UI can pass `{ silent: true }`.

export const getCodeAnimationOptions = (options) => request('/code-animation/options', options);

export const buildCodeAnimationPrompt = (brief, options) => request('/code-animation/prompt', {
  method: 'POST',
  body: JSON.stringify(brief),
  ...options,
});

export const startCodeAnimationGeneration = (brief, options) => request('/code-animation/generate', {
  method: 'POST',
  body: JSON.stringify(brief),
  ...options,
});

export const getCodeAnimationJob = (id, options) =>
  request(`/code-animation/generate/${encodeURIComponent(id)}`, options);
