/**
 * Code Review Defaults (Review Loop reviewer chain + per-backend local-LLM model).
 */

import { request } from './apiCore.js';

// Code Review Defaults — the global default reviewer chain + per-backend
// model the Review Loop seeds from when a task/task-type doesn't pin its own.
// Surfaced on the Models → Code Reviewers page; persisted under
// `settings.codeReview` via PUT /api/settings.
export const getCodeReviewDefaults = (options) => request('/code-review/defaults', options);

// Per-entry existence check of the saved `@login` / `@org/team` reviewers on the
// target forge. Kept off getCodeReviewDefaults so the settings load never waits
// on forge lookups.
export const getReviewerIdentities = (options) => request('/code-review/reviewer-identities', options);

// Clean rate per reviewer and per reviewed diff size, from the verdicts agent
// runs recorded on their own records. Shown on the CoS Learning tab.
export const getReviewerVerdictStats = (options) => request('/code-review/verdict-stats', options);
