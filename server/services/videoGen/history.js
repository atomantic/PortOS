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

export const loadHistory = () => readJSONFile(HISTORY_FILE, []);
export const saveHistory = (h) => atomicWrite(HISTORY_FILE, h);

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
