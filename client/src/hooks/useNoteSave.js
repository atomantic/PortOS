import { useCallback, useState } from 'react';
import * as api from '../services/api';

// Consecutive non-transient refusals of the SAME note before the force-save
// override is offered. One is a bad-luck threshold: it would put a "write
// anyway" button in front of a user who has seen a single hiccup.
const REFUSALS_BEFORE_FORCE = 2;

const CLEARED = { path: null, count: 0 };

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
 * 1. The server must report the refusal as `stalled` — its own before/after
 *    check found the download moved nothing, so retrying provably cannot help.
 *    A genuinely in-flight download must NEVER arm the override; waiting is the
 *    right answer there, and forcing would issue the blocking write the guard
 *    exists to prevent.
 * 2. It must have happened twice in a row on the same note, and then it still
 *    takes its own explicit click. The override is never a retry default.
 *
 * Both editors that write notes (Brain Notes, Wiki Browse) use this, so the
 * policy lives in one place rather than being mirrored into each of them.
 *
 * @param {object} params
 * @param {string} params.vaultId
 * @param {string|null} params.notePath - vault-relative path of the open note.
 * @param {string} params.content - editor buffer to write.
 * @returns {{ saving: boolean, save: (opts?: { force?: boolean }) => Promise<object|null>,
 *   forceOffered: boolean, dismissForce: () => void }}
 *   `save` resolves the updated note, or `null` when the write did not happen
 *   (the API layer has already toasted the reason).
 */
export function useNoteSave({ vaultId, notePath, content }) {
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState(CLEARED);

  // Returning the previous object when already clear keeps the common case —
  // every successful save calls this — from re-rendering the editor for nothing.
  const clearRefusals = useCallback(
    () => setRefusal(prev => (prev.path === null ? prev : CLEARED)),
    [],
  );

  const save = useCallback(async ({ force = false } = {}) => {
    if (!notePath) return null;
    setSaving(true);
    const data = await api.updateNote(vaultId, notePath, content, { force }).catch((err) => {
      if (err?.code === 'NOTE_EVICTED' && err.context?.stalled) {
        setRefusal(prev => (
          prev.path === notePath ? { path: notePath, count: prev.count + 1 } : { path: notePath, count: 1 }
        ));
      }
      return null;
    });
    setSaving(false);
    if (data) clearRefusals();
    return data;
  }, [vaultId, notePath, content, clearRefusals]);

  const forceOffered = Boolean(notePath)
    && refusal.path === notePath
    && refusal.count >= REFUSALS_BEFORE_FORCE;

  return { saving, save, forceOffered, dismissForce: clearRefusals };
}

export default useNoteSave;
