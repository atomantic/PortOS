import { useCallback } from 'react';
import toast from '../components/ui/Toast';
import { setImageHidden, setVideoHidden } from '../services/apiImageVideo';

// The one hide/unhide action for a gallery image or video, shared by the media
// cards and the preview lightbox on every page. `onHidden(item, hidden)` runs
// after the server accepts the change so the host can update or drop the row
// (a page that lists only visible items removes it; MediaPreview then opens
// the neighbor). Resolves true on success.
export function useMediaHideToggle(onHidden) {
  return useCallback(async (item) => {
    const raw = item?.raw || item;
    const isVideo = item?.kind === 'video';
    const hidden = !(item?.hidden ?? raw?.hidden);
    const saved = await (isVideo
      ? setVideoHidden(raw.id, hidden, { silent: true })
      : setImageHidden(raw.filename, hidden, { silent: true })
    ).then(() => true).catch((error) => {
      toast.error(error.message || 'Failed to update visibility');
      return false;
    });
    if (!saved) return false;
    onHidden?.(item, hidden);
    toast.success(`${isVideo ? 'Video' : 'Image'} ${hidden ? 'hidden' : 'unhidden'}`);
    return true;
  }, [onHidden]);
}
