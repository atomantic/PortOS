/**
 * `useNoteSave({ vaultId, notePath, content })` saves an Obsidian note and offers an iCloud force-save
 * escape after repeated refusals.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { updateNote } from '../services/apiNotes.js';

// Consecutive non-transient refusals of the SAME note before the force-save
// override is offered. One is a bad-luck threshold: it would put a "write
// anyway" button in front of a user who has seen a single hiccup.
const REFUSALS_BEFORE_FORCE = 2;

const CLEARED = { target: null, count: 0 };

/**
 * Save an Obsidian note, with the iCloud force-save escape hatch (#3717).
 *
 * The server refuses to overwrite a note whose bytes look offloaded to iCloud (that write blocks the process uninterruptibly), but the "offloaded" inference also fires for ordinary sparse or
 * `decmpfs`-compressed files, and then the refusal is permanent, so the user needs a way through. Two conditions gate the override:
 *
 * 1. The server must report the refusal as `stalled` (`brctl` succeeded and its own before/after check found the download moved nothing). A timed-out or visibly progressing download is NOT
 *    stalled and must never arm the override. `stalled` is a filter, not proof (`brctl` can exit 0 mid-download), which is why the row that acts on it spells out the consequence (`<ForceSaveNoteRow>`).
 * 2. It must have happened twice in a row on the same note, and then it still takes its own explicit click. The override is never a retry default.
 *
 * Both note editors (Brain Notes, Wiki Browse) use this so the policy lives in one place.
 * @param {object} params
 * @param {string} params.vaultId
 * @param {string|null} params.notePath - vault-relative path of the open note.
 * @param {string} params.content - editor buffer to write.
 * @returns {{ saving: boolean, save: (opts?: { force?: boolean }) => Promise<object|null>,
 *   forceOffered: boolean, dismissForce: () => void,
 *   bufferChangedSince: (submitted: string) => boolean }}
 *   `save` resolves the updated note, or `null` when the write did not happen (refused, with the reason already toasted, or nothing to save / already in flight).
 *   The textarea stays editable during a write, so a completion handler passes its submitted content to `bufferChangedSince` and keeps the editor open when it returns true.
 */
export function useNoteSave({ vaultId, notePath, content }) {
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState(CLEARED);
  // Re-entrancy guard: `saving` can't do this (setState is async, so a second click lands before the disabled prop repaints), and a doubled "Save anyway" on a possibly-evicted note strands
  // another libuv threadpool thread for the life of the process. ⌘S must not stack either.
  const inFlight = useRef(false);
  const contentRef = useRef(content);
  contentRef.current = content;

  // Identity of the open note: the path ALONE isn't enough (vaults share basenames like `index.md`), or a refusal in one vault would arm the override on a same-named note in another.
  const target = notePath ? `${vaultId}\u0000${notePath}` : null;

  // Returning the previous object when already clear keeps the common cases —
  // every successful save, and every note switch — from re-rendering for nothing.
  const clearRefusals = useCallback(
    () => setRefusal(prev => (prev.target === null ? prev : CLEARED)),
    [],
  );

  // Drop a stale refusal when the editor moves to another note, so reopening a
  // note never greets the user with an override for a save they haven't retried.
  useEffect(() => { clearRefusals(); }, [target, clearRefusals]);

  const save = useCallback(async ({ force = false } = {}) => {
    if (!notePath || inFlight.current) return null;
    inFlight.current = true;
    setSaving(true);
    const data = await updateNote(vaultId, notePath, content, { force }).catch((err) => {
      if (err?.code === 'NOTE_EVICTED' && err.context?.stalled) {
        setRefusal(prev => (
          prev.target === target ? { target, count: prev.count + 1 } : { target, count: 1 }
        ));
      }
      return null;
    });
    inFlight.current = false;
    setSaving(false);
    if (data) clearRefusals();
    return data;
  }, [vaultId, notePath, target, content, clearRefusals]);

  const forceOffered = Boolean(target)
    && refusal.target === target
    && refusal.count >= REFUSALS_BEFORE_FORCE;

  const bufferChangedSince = useCallback(submitted => contentRef.current !== submitted, []);

  return { saving, save, forceOffered, dismissForce: clearRefusals, bufferChangedSince };
}

export default useNoteSave;
