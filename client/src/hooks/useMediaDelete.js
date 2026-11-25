/**
 * Deletes gallery images and videos, manages pending-delete notices and peer names, and reports row changes to the host.
 */

import { useCallback } from 'react';
import toast from '../components/ui/Toast';
import { mediaDeleteOutcome } from '../lib/mediaDeleteOutcome';
import {
  cancelImagePendingDelete,
  cancelVideoPendingDelete,
  deleteImage,
  deleteVideoHistoryItem,
} from '../services/apiImageVideo.js';
import { refreshMediaUsages } from './useMediaUsages';
import usePendingDeletePeerNames from './usePendingDeletePeerNames';

export function useMediaDelete({ rows, onPending, onRemoved, notifyOnDelete = false }) {
  const { peerNames: pendingPeerNames, rememberPeerName } = usePendingDeletePeerNames(rows);

  const deleteItem = useCallback(async (item, { force = false } = {}) => {
    const isImage = item?.kind === 'image';
    const ref = isImage ? item.filename : item?.kind === 'video' && item.id;
    if (!ref) return;
    const remove = isImage ? deleteImage : deleteVideoHistoryItem;
    const result = await remove(ref, { silent: true, force }).catch((error) => {
      // Usage changed after the card loaded. Show the current references before a force delete.
      if (error?.code === 'MEDIA_IN_USE') void refreshMediaUsages();
      if (!error?.toasted) toast.error(error?.message || 'Delete failed');
      return null;
    });
    if (!result) return;
    void refreshMediaUsages();
    const outcome = mediaDeleteOutcome(result, item.kind);
    if (!outcome.remove) {
      rememberPeerName(outcome.pendingDelete?.peerId, result.peerName);
      onPending(item, outcome.pendingDelete);
      toast(outcome.notice);
      return;
    }
    onRemoved(item);
    if (outcome.tone === 'info') toast(outcome.notice);
    else if (notifyOnDelete) toast.success(isImage ? `Deleted ${item.filename}` : outcome.notice);
  }, [notifyOnDelete, onPending, onRemoved, rememberPeerName]);

  const cancelPendingDelete = useCallback(async (item) => {
    const isImage = item?.kind === 'image';
    const ref = isImage ? item.filename : item?.kind === 'video' && item.id;
    if (!ref) return;
    const cancel = isImage ? cancelImagePendingDelete : cancelVideoPendingDelete;
    const cancelled = await cancel(ref, { silent: true }).then(() => true).catch((error) => {
      if (!error?.toasted) toast.error(error?.message || 'Cancel failed');
      return false;
    });
    if (!cancelled) return;
    onPending(item, null);
    toast.success('Pending delete cancelled');
  }, [onPending]);

  return { deleteItem, cancelPendingDelete, pendingPeerNames };
}
