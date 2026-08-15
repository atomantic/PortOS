/**
 * Video Gen — render history I/O.
 *
 * The render history (`data/video-history.json`) is the flat list the Media
 * History page grid-views. This module owns the read/write primitives; the
 * generation and post-processing code in local.js loads/saves through them.
 */

import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../../lib/fileUtils.js';

const HISTORY_FILE = join(PATHS.data, 'video-history.json');

// STRICT (#4115): every write to this file goes `loadHistory` → mutate →
// `saveHistory`, so a present-but-unreadable video-history.json swallowed to `[]`
// makes the next completed download persist an empty array over the user's whole
// render history. The Media History page also counts this list ("Show more (N
// remaining)"), where a fake 0 reads as fact. Absent stays a real first-run empty.
export const loadHistory = () => readJSONFile(HISTORY_FILE, [], { strict: true });
export const saveHistory = (h) => atomicWrite(HISTORY_FILE, h);

// Resolve ONE entry by its history id, or `null` when no entry carries it (#4165).
// A history id is NOT the filename stem — `videoGen/local.js` names a clip
// `<jobId>.mp4` (so reconstruction happens to work there), but the timeline
// renderer mints `timeline-<project>-<ts>.mp4` beside an independent
// `randomUUID()` id, so a Creative Director `finalVideoId` can only be resolved
// through the stored `filename`. Callers that hold just an id used to pull the
// WHOLE list to find one row; this is the single-entry read behind
// `GET /api/video-gen/history/:id`.
//
// `null` (not a throw) is the not-found signal so the route owns the 404 and
// this stays usable as a plain lookup; distinct from the strict `loadHistory`
// read, which still throws on an unreadable history file rather than reporting
// a bogus "no such entry".
export async function getHistoryItem(id) {
  const history = await loadHistory();
  if (!Array.isArray(history)) return null;
  return history.find((entry) => entry?.id === id) || null;
}

// Serialized read-modify-write for the shared history file. `loadHistory` +
// mutate + `saveHistory` is not atomic on its own, so two write paths that
// finish near-simultaneously (e.g. two out-of-queue video downloads completing
// from two browser tabs — see server/services/videoDownload.js) both read the
// same stale array and the later save clobbers the earlier's new entry, leaving
// an orphaned file that's absent from the list/media-index and undeletable. A
// module-level promise tail collapses concurrent mutations to a single writer
// per file (the `issueWriteTail` pattern in CLAUDE.md). `mutator(list)` receives
// the freshest persisted array and returns the array to persist (return the
// same reference after mutating it in place, or a new array). Any writer that
// can race another on this file should route through here.
let historyWriteTail = Promise.resolve();
export function mutateVideoHistory(mutator) {
  const run = historyWriteTail.then(async () => {
    const history = await loadHistory();
    const next = await mutator(Array.isArray(history) ? history : []);
    const toSave = Array.isArray(next) ? next : history;
    await saveHistory(toSave);
    return toSave;
  });
  // Keep the tail alive even if this mutation rejects, so one failure doesn't
  // wedge every subsequent write behind a permanently-rejected promise.
  historyWriteTail = run.then(() => {}, () => {});
  return run;
}
