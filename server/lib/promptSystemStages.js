/**
 * The prompt stages PortOS features call by name — the single source of truth
 * for "which stage keys are system stages" (#3314).
 *
 * These stages are resolved by literal key (`getStage('cos-evaluate')`,
 * `runStage('brain-classifier')`, …) rather than authored by the user in the
 * Prompt Manager. Deleting one silently breaks the feature that names it, so
 * `DELETE /api/prompts/:stage` refuses without `?force=true`, and the Prompt
 * Manager badges + filters them.
 *
 * SCOPE: this is the CURATED protected set — the CoS / Brain / Memory /
 * app-detection stages the delete guard has always covered — not an exhaustive
 * index of every literal-key call site. Plenty of shipped stages are resolved
 * by literal key too (`pipeline-series-concept-judge`, `catalog-ideas-scenes-concepts`,
 * …) and are deliberately NOT here: force-guarding and badging ~100 pipeline
 * stages is a product decision, not a refactor, and is tracked separately.
 * Adding a row here means "this stage is now protected from deletion and
 * badged SYSTEM", which is a deliberate choice per stage.
 *
 * The map was previously restated three times — the usage handler's
 * `key -> usedBy[]` table, the DELETE guard's bare key array, and a client-side
 * `SYSTEM_STAGE_KEYS` mirror in `client/src/lib/promptStageGroups.js`. The
 * client copy could (and did) drift out of the server's, which after #3284 was
 * no longer cosmetic: a key missing from the client list made that stage
 * unreachable through the Stages pane's "System only" filter even though the
 * server would refuse to delete it. `GET /api/prompts` now ships the key list
 * so the client has nothing left to guess.
 *
 * Pure data + predicates — no I/O, no toolkit dependency. Adding a feature that
 * resolves a stage by literal key means adding a row here.
 */

/**
 * `stageKey -> human-readable feature names that call it`. The values are what
 * `GET /api/prompts/:stage/usage` surfaces as `usedBy` in the delete-confirm
 * dialog, so they read as UI copy rather than module paths.
 */
export const SYSTEM_STAGE_USAGE = Object.freeze({
  'cos-agent-briefing': Object.freeze(['CoS sub-agent task briefing']),
  'cos-evaluate': Object.freeze(['CoS task evaluation']),
  'cos-report-summary': Object.freeze(['CoS daily reports']),
  'cos-self-improvement': Object.freeze(['CoS self-improvement tasks']),
  'cos-task-enhance': Object.freeze(['CoS task prompt enhancement']),
  'brain-classifier': Object.freeze(['Brain thought classification']),
  'brain-daily-digest': Object.freeze(['Brain daily digest generation']),
  'brain-weekly-review': Object.freeze(['Brain weekly review generation']),
  'memory-evaluate': Object.freeze(['Memory extraction from agent output']),
  'app-detection': Object.freeze(['Project directory analysis']),
});

/** Derived, never restated — the DELETE guard and the API response both read this. */
export const SYSTEM_STAGE_KEYS = Object.freeze(Object.keys(SYSTEM_STAGE_USAGE));

const SYSTEM_STAGE_SET = new Set(SYSTEM_STAGE_KEYS);

/** True when `key` names a stage a PortOS feature resolves by literal key. */
export function isSystemStage(key) {
  return SYSTEM_STAGE_SET.has(key);
}

/**
 * The feature names that call `key`, or an empty array for a user-authored
 * stage. Always an array so callers can render it without a null guard.
 *
 * Gated on the Set rather than indexing the object directly — a stage literally
 * named `toString` or `constructor` would otherwise resolve to an inherited
 * `Object.prototype` member and be reported as in-use.
 */
export function systemStageUsedBy(key) {
  return isSystemStage(key) ? SYSTEM_STAGE_USAGE[key] : [];
}
