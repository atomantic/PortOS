/**
 * Advisory run order for scheduled tasks.
 *
 * Every task carries an editable `suggestedAfter` array naming the task types a
 * user should generally run BEFORE it. It answers "which of these do I run
 * first?" by pointing at other scheduled tasks by name, which prose guidance
 * could not do.
 *
 * Advisory is the whole point: nothing here gates dispatch. The ENFORCED
 * dependency field is `runAfter` (taskSchedule.js `checkRunAfterDeps`), which
 * holds a due task until each named type has run since its own last run. A user
 * who wants a hard gate promotes the entry there; `suggestedAfter` only orders
 * the page and labels the cards.
 *
 * The 1-based STEP each task lands on is derived where it is rendered
 * (client/src/components/cos/tabs/schedule/scheduleConstants.js) — it is a
 * property of the whole visible graph, not of a task, so a per-task field on
 * the wire would go stale the moment any other task was edited.
 *
 * Pure — no I/O.
 */

/** The only cap on the list — a hand-edited schedule file cannot grow it unbounded. */
export const SUGGESTED_AFTER_MAX = 20;

/**
 * Normalize a `suggestedAfter` value into a clean array of task-type ids.
 *
 * Returns `[]` for a missing/invalid value AND for an explicitly emptied list.
 * The absent-vs-cleared distinction is resolved BEFORE this is called, by the
 * `interval.suggestedAfter ?? AUDIT_SUGGESTED_AFTER[taskType]` fallback in
 * `getScheduleStatus`: an absent key inherits the shipped order, while a stored
 * `[]` is the user's deliberate clear and `??` keeps it. That is also why the
 * route stores `[]` rather than nulling it the way `runAfter` does — a null
 * would read back as "never edited" and re-inherit.
 *
 * A self-reference is dropped (a task cannot precede itself), as are blanks and
 * duplicates. Order is preserved — it is the order the user chose.
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
