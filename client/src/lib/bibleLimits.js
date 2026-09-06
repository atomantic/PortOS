/**
 * Re-export of `BIBLE_LIMITS` from the pure server leaf `server/lib/bibleLimits.js`
 * (the caps every canon sanitizer measures against), plus the client-only
 * `capImageRefs` / `appendImageRefById` helpers the optimistic imageRefs-append
 * paths use.
 */
import { BIBLE_LIMITS } from '../../../server/lib/bibleLimits.js';

export { BIBLE_LIMITS };

// Client-only helper (the cap *value* IMAGE_REFS_PER_ENTRY_MAX comes from the
// server leaf above; this convenience function is client-only). Trims an imageRefs list to that
// last-N cap, mirroring the server's `appendEntryImageRef` rotation. Shared by
// the optimistic imageRefs-append paths in the universe/canon render surfaces so
// a local stamp never grows past what the durable server append keeps.
export const capImageRefs = (refs) => (
  refs.length > BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX
    ? refs.slice(-BIBLE_LIMITS.IMAGE_REFS_PER_ENTRY_MAX)
    : refs
);

// Optimistic client mirror of the server's `mapAppendImageRef` (see
// `server/services/universeBuilder/crud.js`): append `filename` to the
// id-matched entry's imageRefs[], deduped and capped. The server's completion
// hook has already made this durable — this only swaps the row from spinner to
// thumbnail without waiting for the next refetch, so it returns the SAME array
// and entry references when nothing changed (unknown id, or the ref is already
// there) and callers can hand the result straight to setState without forcing a
// re-render. Non-array input returns `null` so a caller can bail on its update.
export const appendImageRefById = (entries, id, filename) => {
  if (!Array.isArray(entries) || !id || !filename) return null;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry?.id !== id) return entry;
    const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];
    if (refs.includes(filename)) return entry;
    changed = true;
    return { ...entry, imageRefs: capImageRefs([...refs, filename]) };
  });
  return changed ? next : entries;
};
