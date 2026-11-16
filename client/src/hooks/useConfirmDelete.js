/**
 * Single-at-a-time `{ confirmingId, isConfirming, requestDelete, cancelDelete, confirmDelete }` for
 * arming one list/card row at a time.
 *
 * Use when: New destructive list action — pair with `<InlineConfirmRow>` / `<ConfirmButtonPair>`
 * instead of deleting on the raw trash click.
 */

import { useCallback, useState } from 'react';

/**
 * Single-at-a-time delete confirmation state for list/card rows: a trash button arms a row by setting `confirmingId`, an inline confirm UI (<InlineConfirmRow> / <ConfirmButtonPair>) renders while it is armed, and confirming or cancelling clears it. Opening a second confirm closes the first.
 * Returns: confirmingId (the armed id, null when none); isConfirming(id); requestDelete(id) (wire to the trash button); cancelDelete() (the confirm row's onCancel); confirmDelete(fn) (disarm, then run the async delete and return its result).
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
