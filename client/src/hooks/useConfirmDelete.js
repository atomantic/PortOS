import { useCallback, useState } from 'react';

/**
 * Single-at-a-time delete confirmation state for list/card rows.
 *
 * Standardizes the pattern PortOS already uses by hand in several brain tabs:
 * a trash button arms a row by setting `confirmingId`, an inline confirm UI
 * (<InlineConfirmRow> / <ConfirmButtonPair>) renders while that row is armed,
 * and confirming or cancelling clears it. Only one row is ever armed at once,
 * so opening a second confirm closes the first.
 *
 * Project memory: the user finds the two-click-arm button (useArmedAction)
 * non-discoverable — prefer this hook with an inline confirm row for new
 * destructive list actions.
 *
 * Returns:
 *   confirmingId        — the id currently armed (null when none)
 *   isConfirming(id)    — true when `id` is the armed row
 *   requestDelete(id)   — arm `id` (wire to the trash button onClick)
 *   cancelDelete()      — disarm (wire to the confirm row's onCancel)
 *   confirmDelete(fn)   — disarm, then run the async delete; returns its result
 */
export function useConfirmDelete() {
  const [confirmingId, setConfirmingId] = useState(null);

  const isConfirming = useCallback(
    (id) => confirmingId != null && confirmingId === id,
    [confirmingId],
  );

  const requestDelete = useCallback((id) => setConfirmingId(id), []);
  const cancelDelete = useCallback(() => setConfirmingId(null), []);

  const confirmDelete = useCallback((fn) => {
    setConfirmingId(null);
    return fn();
  }, []);

  return { confirmingId, isConfirming, requestDelete, cancelDelete, confirmDelete };
}

export default useConfirmDelete;
