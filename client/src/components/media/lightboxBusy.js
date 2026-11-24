// Shared handler for the lightbox's in-place async actions (Clean /
// Regenerate / Remove watermark): guard against double-fire, flip the busy
// flag, run the action (the caller toasts its own error so we just stay open
// on throw), and close the lightbox on success.
export const runBusyAction = ({ item, onClose, busy, setBusy, action }) => async () => {
  if (busy) return;
  setBusy(true);
  let ok = false;
  try {
    await action(item);
    ok = true;
  } catch {
    // Caller toasts its own error; stay open so the user can retry.
  } finally {
    setBusy(false);
  }
  if (ok) onClose();
};
