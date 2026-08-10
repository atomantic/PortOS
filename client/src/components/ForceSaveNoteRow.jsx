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
 * The copy names the cost of being wrong on purpose. `brctl` exit 0 means the
 * download was accepted, not that the bytes are local, so even a stalled verdict
 * does not PROVE the file is on this Mac — and if it isn't, the forced write
 * blocks a libuv thread uninterruptibly. The user can only weigh "Save anyway"
 * against "Keep waiting" if the prompt says that out loud.
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
      question="iCloud says this note isn't downloaded, but asking it to download changed nothing. If the note really is on this Mac, saving is safe — if it isn't, PortOS may stop responding until you restart it. Write it anyway?"
      confirmText="Save anyway"
      confirmTitle="Bypass the iCloud download check and write this note"
      cancelText="Keep waiting"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
