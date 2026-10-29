/**
 * What a video or gallery-image delete response means for the list showing
 * the row (server/services/mediaRemoteDelete.js): whether the row leaves the
 * list, the pending marker to keep on it, and the notice to show.
 * Returns `{ remove, pendingDelete, notice, tone }`; tone is `success` or `info`.
 */
export function mediaDeleteOutcome(result, kind = 'video') {
  const peer = result?.peerName || 'the owning machine';
  switch (result?.status) {
    case 'pending':
      // Another holder deleted its copy (and the one here went with it) while
      // the origin was unreachable; the origin still has to delete its own.
      if (result.removedHere) {
        return { remove: true, pendingDelete: null, notice: `Deleted on ${result.deletedOn || 'another machine'}; still pending on ${peer} until it is reachable`, tone: 'info' };
      }
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
      return { remove: true, pendingDelete: null, notice: `Deleted ${kind === 'image' ? 'image' : 'video'}`, tone: 'success' };
  }
}
