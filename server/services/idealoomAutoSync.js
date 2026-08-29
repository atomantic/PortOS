/**
 * Opt-in, debounced automatic IdeaLoom export.
 *
 * Automatic writes are the one part of the exchange the user never watches, so
 * this layer is deliberately the most conservative one:
 *
 * - **Opt-in twice.** It runs only when the integration is enabled AND
 *   `autoSync` is on AND a vault is configured. Every gate is re-read at fire
 *   time, so turning the toggle off cancels work already queued.
 * - **Never destructive.** It calls `exportToObsidian` with the defaults, so it
 *   cannot delete a note and cannot recreate one the user deleted — a list
 *   whose note is gone comes back as `missing` and waits for an explicit
 *   recovery request.
 * - **No feedback loop.** Only a user-initiated local list write schedules a
 *   run (the import and sync routes never do), and an export whose rendered
 *   Markdown already matches the note on disk is skipped rather than rewritten.
 *
 * The debounce coalesces a burst of edits — reordering ideas one click at a
 * time is one vault write, not eight.
 */

import * as ideaLoomLists from './idealoomLists.js';
import * as ideaLoomObsidian from './idealoomObsidian.js';

export const AUTO_SYNC_DEBOUNCE_MS = 5000;

const pending = new Set();
let timer = null;
// Runs are chained rather than fired concurrently: two overlapping exports of
// the same list would read the same base hash and race on the note.
let queue = Promise.resolve();

const runPending = async () => {
  const listIds = [...pending];
  pending.clear();
  if (!listIds.length) return;

  const settings = await ideaLoomLists.getSettings();
  if (!settings.enabled || !settings.autoSync || !settings.obsidianVaultId) return;

  for (const listId of listIds) {
    const result = await ideaLoomObsidian.exportToObsidian({ listId });
    const problems = ['conflicted', 'missing', 'malformed', 'unavailable', 'failed']
      .reduce((total, key) => total + (result[key] || 0), 0);
    if (problems) console.warn(`⚠️ IdeaLoom auto-sync left ${problems} unresolved outcome(s) for list ${listId}`);
  }
};

/**
 * Queue a debounced automatic export of one list.
 *
 * Safe to call on every save: repeat calls inside the debounce window collapse
 * into one run, and the whole run is a no-op while the toggles are off.
 */
export function scheduleAutoSync(listId, { delayMs = AUTO_SYNC_DEBOUNCE_MS } = {}) {
  if (!listId) return;
  pending.add(listId);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    // This fires outside the Express request lifecycle, so an unhandled throw
    // here would take down the process instead of reaching error middleware.
    queue = queue
      .then(runPending)
      .catch((error) => console.error(`❌ IdeaLoom auto-sync failed: ${error.message}`));
  }, delayMs);
  timer.unref?.();
}

/** Await any queued automatic export — used by tests and shutdown paths. */
export async function flushAutoSync() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    queue = queue
      .then(runPending)
      .catch((error) => console.error(`❌ IdeaLoom auto-sync failed: ${error.message}`));
  }
  await queue;
}
