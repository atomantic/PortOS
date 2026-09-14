import { useCallback } from 'react';
import { listMediaGalleryPage } from '../services/apiImageVideo';
import { normalizeMediaRow } from '../components/media/normalize';

/**
 * `resolveItem` for `usePreviewRoute` — resolve a `?preview=` param the host's
 * own items list cannot account for, by looking the record up in the gallery.
 * `usePreviewRoute` uses this as its default, so a host only calls it directly
 * to scope the lookup to one collection.
 *
 * `key` is what `usePreviewRoute` put in the URL — an `image:`/`video:` key, or
 * a bare filename for hosts that never prefixed one.
 *
 * @param {object} [options]
 * @param {string} [options.collectionId] - scope the lookup to one collection
 * @returns {Function} stable async `(key) => normalized item | null`
 */
export default function useGalleryPreviewResolver({ collectionId } = {}) {
  return useCallback(async (key) => {
    const kind = key.startsWith('video:') ? 'video' : key.startsWith('image:') ? 'image' : 'all';
    const filename = key.replace(/^(image|video):/, '');
    const page = await listMediaGalleryPage(
      { limit: 1, kind, filename, ...(collectionId ? { collectionId } : {}) },
      { silent: true },
    );
    return page.items[0] ? normalizeMediaRow(page.items[0]) : null;
  }, [collectionId]);
}
