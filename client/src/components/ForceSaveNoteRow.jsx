import InlineConfirmRow from './ui/InlineConfirmRow';

/**
 * "iCloud won't let this note save — write it anyway?" confirm row (#3717).
 *
 * Shown by an Obsidian note editor once `useNoteSave` reports `forceOffered`:
 * the server has twice refused this note with a verdict that retrying cannot
 * clear (see the hook for the two conditions). Confirming issues the write past
 * the guard, which is why this is a row the user has to answer and never an
 * automatic retry.
 *
 * Renders nothing when not offered, so callers can drop it in unconditionally.
 * Shared by Brain Notes and the Wiki browser — the same lockout is reachable
 * from both, and the copy must not drift between them.
 */
export default function ForceSaveNoteRow({ offered, onConfirm, onCancel }) {
  if (!offered) return null;
  return (
    <InlineConfirmRow
      variant="separator"
      tone="warning"
      question="iCloud keeps reporting this note as not downloaded, so saving is refused. Write it anyway?"
      confirmText="Save anyway"
      confirmTitle="Bypass the iCloud download check and write this note"
      cancelText="Keep waiting"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
