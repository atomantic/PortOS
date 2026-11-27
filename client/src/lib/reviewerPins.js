/**
 * Reviewer pin controls and shared reviewer vocabulary for the CoS UI.
 */

import {
  normalizeReviewUsernames,
  REVIEWER_MODEL_FORBIDDEN_RE,
  REVIEW_STOP_MODES as REVIEW_STOP_MODE_VALUES,
} from '../../../server/lib/reviewerVocabulary.js';

export {
  APPLY_CAPABLE_REVIEWERS,
  BRACKET_MODEL_REVIEWERS,
  DEFAULT_REVIEWER,
  DEFAULT_REVIEWERS,
  DEFAULT_REVIEW_STOP_MODE,
  EFFORT_SELECTABLE_REVIEWERS,
  LOCAL_LLM_EFFORT_LEVELS,
  LOCAL_LLM_REVIEWERS,
  MAX_REVIEWER_MAX_ROUNDS,
  MAX_REVIEWER_MODEL_LENGTH,
  MAX_REVIEW_USERNAMES,
  MODEL_CAPABLE_CLI_REVIEWERS,
  MODEL_SELECTABLE_REVIEWERS,
  PORTOS_ONLY_REVIEWERS,
  REVIEWER_ALIASES,
  REVIEWER_EFFORT_LEVELS,
  REVIEWER_LIST_OVERRIDE_KEYS,
  REVIEWER_OVERRIDE_KEYS,
  REVIEWER_VALUES,
  cleanReviewUsername,
  hasReviewerOverride,
  isApplyCapableReviewer,
  isProviderReviewer,
  normalizeReviewUsernames,
  normalizeReviewerSlug,
  normalizeReviewers,
  resolveProviderReviewerSlug,
  reviewerEffortLevels,
} from '../../../server/lib/reviewerVocabulary.js';

// Which goal-fidelity verdicts fire the follow-up actions (file an issue /
// queue a fix). Mirror of GOAL_FIDELITY_FOLLOW_UP_TRIGGERS in
// server/lib/goalFidelityFollowUp.js — the settings schema is a `z.enum` over
// it, so a value offered here but absent there 400s the whole settings save.
export const GOAL_FIDELITY_FOLLOW_UP_TRIGGERS = Object.freeze(['rethink', 'any-finding']);
export const DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER = 'rethink';

// Strip slashdo token delimiters as the user types, while preserving spaces in model ids.
const reviewerModelDelimiters = new RegExp(REVIEWER_MODEL_FORBIDDEN_RE, 'g');
export const sanitizeReviewerModelInput = (raw) =>
  typeof raw === 'string' ? raw.replace(reviewerModelDelimiters, '') : '';

const REVIEW_STOP_MODE_COPY = {
  all: { label: 'Run all', description: 'Run every reviewer in order before merging (default)' },
  'on-findings': { label: 'Stop on first fix', description: 'Stop after the first reviewer that landed a fix' },
  'on-clean': { label: 'Stop on first clean', description: 'Stop after the first reviewer that reports zero findings' },
};

export const REVIEW_STOP_MODES = REVIEW_STOP_MODE_VALUES.map(value => ({ value, ...REVIEW_STOP_MODE_COPY[value] }));

// Display mirror of the server's resolveOptionalReviewers + taskPinnedReviewerTokens:
// a task's `optionalReviewers` decides only the reviewers the task itself pins;
// a reviewer inherited from the Code Review Defaults keeps the defaults' `~opt`.
export function resolveTaskOptionalReviewers(metadata, defaultOptional) {
  const defaults = Array.isArray(defaultOptional) ? defaultOptional : [];
  const own = metadata?.optionalReviewers;
  if (!Array.isArray(own)) return defaults;
  const key = (token) => String(token).trim().toLowerCase();
  const pinnedList = Array.isArray(metadata.reviewers) ? metadata.reviewers
    : (typeof metadata.reviewer === 'string' && metadata.reviewer ? [metadata.reviewer] : []);
  const pinnedUsers = Array.isArray(metadata.usernames) ? normalizeReviewUsernames(metadata.usernames).map((user) => `@${user}`) : [];
  const pinned = new Set([...pinnedList, ...pinnedUsers].map(key));
  const ownKeys = new Set(own.map(key));
  return [...own, ...defaults.filter((token) => !pinned.has(key(token)) && !ownKeys.has(key(token)))];
}
