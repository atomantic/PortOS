/** Reads stored POST sessions and normalizes their evaluations and local day keys. */

import { LLM_DRILL_TYPES } from '../../lib/postDrillTypes.js';
import { normalizeHistoricalPostLlmEvaluation } from '../../lib/postLlmContracts.js';
import { recordDayKey, withDerivedDayKeys } from '../../lib/postStreak.js';
import { getUserTimezone } from '../userTimezone.js';
import { getStoredPostSession, listPostSessions } from '../postRunStore.js';

/**
 * @param {{ strict?: boolean }} [options] - `strict: true` throws when
 *   post-sessions.json is present-but-unreadable/corrupt instead of falling back to
 *   an empty session list. Off by default: every existing caller wants the fallback
 *   (an unreadable file shouldn't break a drill you're mid-way through). Callers
 *   that COUNT sessions opt in — a fake 0 there is a lie, not a default (#2726).
 */
export async function loadSessions({ strict = false } = {}) {
  return { sessions: await listPostSessions({ strict }) };
}

function normalizeHistoricalLlmEvaluations(session) {
  return {
    ...session,
    tasks: (session?.tasks || []).map((task) => (
      LLM_DRILL_TYPES.includes(task?.type) && task.evaluation
        ? { ...task, evaluation: normalizeHistoricalPostLlmEvaluation(task.evaluation) }
        : task
    )),
  };
}

/**
 * All scored sessions, with each record's `date` RE-DERIVED from its `startedAt`
 * instant in the user's CURRENT timezone (issue #4168). This is the single read
 * boundary for sessions — every stats/streak/history reader and the client go
 * through it — so a `settings.timezone` change re-keys existing history on read
 * instead of leaving days frozen in the zone that was active when they were
 * written. The stored `date` stays as a cache the readers ignore; the write path
 * (`submitPostSession`, via `loadSessions`) is untouched.
 */
export async function getPostSessions(from, to, options) {
  const data = await loadSessions(options);
  const timezone = await getUserTimezone();
  let sessions = withDerivedDayKeys(data.sessions, timezone).map(normalizeHistoricalLlmEvaluations);
  // Re-derivation can move a record across a day boundary, so re-sort rather
  // than trusting the stored-date order `submitPostSession` wrote.
  sessions.sort((a, b) => (a?.date || '').localeCompare(b?.date || ''));
  if (from || to) {
    sessions = sessions.filter((session) => {
      const date = session?.date;
      return date && (!from || date >= from) && (!to || date <= to);
    });
  }
  return sessions;
}

/**
 * One session by id, with the same re-derived `date` the list view gets (#4168)
 * — otherwise the detail drawer would quote the frozen write-time day while the
 * history row beside it shows the re-keyed one.
 */
export async function getPostSession(id) {
  const session = await getStoredPostSession(id);
  if (!session) return null;
  return normalizeHistoricalLlmEvaluations({ ...session, date: recordDayKey(session, await getUserTimezone()) });
}
