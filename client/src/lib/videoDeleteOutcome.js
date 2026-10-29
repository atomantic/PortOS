/**
 * What a video delete response means for the list showing the row
 * (server/services/mediaRemoteDelete.js): whether the row leaves the list,
 * the pending marker to keep on it, and the notice to show.
 * Returns `{ remove, pendingDelete, notice, tone }`; tone is `success` or `info`.
 */
export function videoDeleteOutcome(result) {
  const peer = result?.peerName || 'the owning machine';
  switch (result?.status) {
    case 'pending':
      return { remove: false, pendingDelete: result.pendingDelete || { peerId: null }, notice: `Delete pending until ${peer} is reachable`, tone: 'info' };
    case 'owner-unknown':
      return { remove: true, pendingDelete: null, notice: 'Owner unknown: hidden on this machine only, nothing was deleted', tone: 'info' };
    case 'deleted-remote':
      return result.hiddenHere
        ? { remove: true, pendingDelete: null, notice: `Deleted on ${peer}; the copy on this machine was only hidden`, tone: 'info' }
        : { remove: false, pendingDelete: null, notice: `Deleted on ${peer}; the copy on this machine remains`, tone: 'info' };
    case 'cancelled':
      return { remove: false, pendingDelete: null, notice: 'Delete cancelled', tone: 'info' };
    default:
      return { remove: true, pendingDelete: null, notice: 'Deleted video', tone: 'success' };
  }
}
