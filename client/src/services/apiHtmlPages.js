/**
 * HTML Pages bench API: installed models to pick from, queueing runs of the fixed creative brief, and reading or deleting stored runs.
 */

import { request } from './apiCore.js';

export const listHtmlPageModels = (options) => request('/html-pages/models', options);

// Summaries without the generated HTML; `getHtmlPageRun` returns one run's pages.
export const listHtmlPageRuns = (options) => request('/html-pages/runs', options);

export const getHtmlPageRun = (id, options) => request(`/html-pages/runs/${encodeURIComponent(id)}`, options);

export const startHtmlPageRuns = (payload, options) =>
  request('/html-pages/runs', { method: 'POST', body: JSON.stringify(payload), ...options });

export const deleteHtmlPageRun = (id, options) =>
  request(`/html-pages/runs/${encodeURIComponent(id)}`, { method: 'DELETE', ...options });
