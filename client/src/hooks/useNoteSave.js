import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../services/api';

// Consecutive non-transient refusals of the SAME note before the force-save
// override is offered. One is a bad-luck threshold: it would put a "write
// anyway" button in front of a user who has seen a single hiccup.
const REFUSALS_BEFORE_FORCE = 2;

const CLEARED = { target: null, count: 0 };

/**
 * Save an Obsidian note, with the iCloud force-save escape hatch (#3717).
 *
 * The server refuses to overwrite a note whose bytes look offloaded to iCloud,
 * because that write blocks the process uninterruptibly. The screen infers
 * "offloaded" from a real byte length with no local blocks, which an ordinary
 * sparse or `decmpfs`-compressed file also reports — and when it misfires, the
 * refusal is permanent: asking iCloud to download an already-local file succeeds
 * instantly and changes nothing. So the user needs a way through.
 *
 * Two conditions gate that override, and both matter:
 *
 * 1. The server must report the refusal as `stalled` — `brctl` succeeded and its
 *    own before/after check found the download moved nothing. A download that
 *    timed out against a wedged iCloud, or that visibly moved bytes and simply
 *    hasn't finished, is NOT stalled and must never arm the override; waiting is
 *    the right answer there, and forcing would issue the blocking write the guard
 *    exists to prevent. `stalled` is a filter, not a proof: `brctl` can exit 0
 *    while a real download is still in flight, so it narrows the offer to cases
 *    that LOOK hopeless — it cannot establish that the bytes are local. That
 *    residual doubt is why the row that acts on it spells out the consequence
 *    (see `<ForceSaveNoteRow>`) instead of presenting itself as a plain retry.
 * 2. It must have happened twice in a row on the same note — two full `brctl`
 *    rounds, which a genuinely progressing download would have moved bytes
 *    across — and then it still takes its own explicit click. The override is
 *    never a retry default.
 *
 * Both editors that write notes (Brain Notes, Wiki Browse) use this, so the
 * policy lives in one place rather than being mirrored into each of them.
 *
 * @param {object} params
 * @param {string} params.vaultId
 * @param {string|null} params.notePath - vault-relative path of the open note.
 * @param {string} params.content - editor buffer to write.
 * @returns {{ saving: boolean, save: (opts?: { force?: boolean }) => Promise<object|null>,
 *   forceOffered: boolean, dismissForce: () => void,
 *   bufferChangedSince: (submitted: string) => boolean }}
 *   `save` resolves the updated note, or `null` when the write did not happen —
 *   either because it was refused (the API layer has already toasted the reason)
 *   or because there was nothing to save / a save was already in flight.
 *   The textarea stays editable while a write is in flight, so a completion
 *   handler passes the content it submitted to `bufferChangedSince` and keeps
 *   the editor open (rather than discarding newer text) when it returns true.
 */
export function useNoteSave({ vaultId, notePath, content }) {
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState(CLEARED);
  // Re-entrancy guard. `saving` can't do this job: a setState is async, so a
  // second click lands before the disabled prop repaints — and the click that
  // matters here is "Save anyway" on a note that may genuinely be evicted, where
  // each extra forced write strands another libuv threadpool thread for the life
  // of the process. Same reason ⌘S must not stack.
  const inFlight = useRef(false);
  const contentRef = useRef(content);
  contentRef.current = content;

  // Identity of the open note. The path ALONE is not enough: vaults routinely
  // share basenames (`index.md`, `README.md`, daily notes), so a refusal recorded
  // against one vault's note would arm the override on a same-named note in
  // another vault that has never been screened at all.
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
    const data = await api.updateNote(vaultId, notePath, content, { force }).catch((err) => {
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
