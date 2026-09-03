import { request } from './apiCore.js';

// Code Review Defaults — the global default reviewer chain + per-backend
// model the Review Loop seeds from when a task/task-type doesn't pin its own.
// Surfaced on the Models → Code Reviewers page; persisted under
// `settings.codeReview` via PUT /api/settings.
export const getCodeReviewDefaults = (options) => request('/code-review/defaults', options);
