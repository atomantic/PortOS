/**
 * Advisory run order for scheduled tasks: storage rules for a task's `suggestedAfter` list (which OTHER scheduled tasks to run first).
 *
 * `normalizeSuggestedAfter` drops blanks, duplicates and self-references and caps at `SUGGESTED_AFTER_MAX`; the shipped default is `auditCatalog.AUDIT_SUGGESTED_AFTER`, layered at read time in `getScheduleStatus`. Pure.
 *
 * Advisory only: nothing gates dispatch (the ENFORCED field is `runAfter`, `taskSchedule.js` `checkRunAfterDeps`; a user wanting a hard gate promotes the entry there; `suggestedAfter` only orders the page and labels cards). The 1-based STEP is derived where rendered (client/src/components/cos/tabs/schedule/scheduleConstants.js): a property of the whole visible graph, so a per-task wire field would go stale when another task is edited.
 */

/** The only cap on the list, so a hand-edited schedule file can't grow it unbounded. */
export const SUGGESTED_AFTER_MAX = 20;

/**
 * Normalize a `suggestedAfter` value into a clean array of task-type ids: `[]` for missing/invalid AND explicitly emptied. Absent-vs-cleared is resolved BEFORE this, by `interval.suggestedAfter ?? AUDIT_SUGGESTED_AFTER[taskType]` in `getScheduleStatus` (absent inherits the shipped order; a stored `[]` is a deliberate clear that `??` keeps, which is why the route stores `[]` rather than nulling it as `runAfter` does: null reads back as "never edited" and re-inherits).
 * Self-references (a task can't precede itself), blanks and duplicates are dropped; order is preserved (the user's choice).
 */
export function normalizeSuggestedAfter(value, taskType = null) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed === taskType || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= SUGGESTED_AFTER_MAX) break;
  }
  return out;
}
