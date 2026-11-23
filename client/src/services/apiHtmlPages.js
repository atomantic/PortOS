/**
 * HTML Pages bench API: installed models to pick from, queueing runs of the fixed creative brief, and reading, resuming or deleting stored runs.
 */

import { request } from './apiCore.js';

export const listHtmlPageModels = (options) => request('/html-pages/models', options);

// Summaries without the generated HTML; `getHtmlPageRun` returns one run's pages.
export const listHtmlPageRuns = (options) => request('/html-pages/runs', options);

export const getHtmlPageRun = (id, options) => request(`/html-pages/runs/${encodeURIComponent(id)}`, options);

export const startHtmlPageRuns = (payload, options) =>
  request('/html-pages/runs', { method: 'POST', body: JSON.stringify(payload), ...options });

// Re-queues a failed run from its first unfinished page.
export const resumeHtmlPageRun = (id, options) =>
  request(`/html-pages/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', ...options });

export const deleteHtmlPageRun = (id, options) =>
  request(`/html-pages/runs/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
