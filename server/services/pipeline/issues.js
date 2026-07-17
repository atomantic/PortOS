/**
 * Pipeline — Issues Service (barrel, #2531)
 *
 * The former ~1470-line monolith was split along CRUD / stage / sync seams:
 *
 *   - ./issuesShared.js — store facade, per-series write queue, sanitizers,
 *     read/save helpers, renumberInline (the shared store/queue).
 *   - ./issueCrud.js    — create/read/list/update/delete + numbering/reassign.
 *   - ./issueStages.js  — per-stage merge / history / restore.
 *   - ./issueSync.js    — peer-sync LWW merge + tombstone GC.
 *
 * This barrel re-exports the full public surface so every existing
 * `from './issues.js'` import path stays valid.
 */

export * from './issuesShared.js';
export * from './issueCrud.js';
export * from './issueStages.js';
export * from './issueSync.js';
