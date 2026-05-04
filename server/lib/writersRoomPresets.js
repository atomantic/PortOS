// Single source of truth for Writers Room enums. Imported by validation.js
// (Zod) and services/writersRoom/local.js (membership checks) so the schema
// and the storage layer can never drift.

export const WORK_KINDS = ['novel', 'short-story', 'screenplay', 'essay', 'treatment', 'other'];
export const WORK_STATUSES = ['idea', 'drafting', 'revision', 'adaptation', 'rendering', 'complete', 'archived'];
export const EXERCISE_STATUSES = ['running', 'finished', 'discarded'];
export const ANALYSIS_KINDS = ['evaluate', 'format', 'script', 'characters', 'settings'];
