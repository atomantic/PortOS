// With `allowUpload`, the Upload button saves the file via POST /api/uploads
// and selects it as `{ kind: 'upload', filename }` so the reverse-prompt
// endpoint can sample frames from PATHS.uploads. With `uploadToGallery`
// (#4188), the upload instead lands in the shared gallery (POST
// /api/video-gen/upload → /data/videos/ + a history entry, peer-syncable) and
// selects the normalized gallery item — required when the selection will be
// REFERENCED by a synced record (e.g. a mood-board item), because
// /api/uploads' scratch dir does not federate.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GalleryPickerShell from '../media/GalleryPickerShell';
import { normalizeMediaRow, normalizeVideo } from '../media/normalize';
import { uploadGalleryVideo } from '../../services/apiImageVideo';
import { uploadFile } from '../../services/apiMedia';
import { useGalleryPage } from '../../hooks/useGalleryPage';
import toast from '../ui/Toast';

const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.webm,.mov,.m4v';

export default function GalleryVideoPicker({ open, ...props }) {
  // A fresh picker has its own search, pagination and upload session.
  return open ? <OpenVideoPicker {...props} /> : null;
}

function OpenVideoPicker({
  onClose,
  onSelect,
  allowUpload = false,
  uploadToGallery = false,
  accept = VIDEO_ACCEPT,
}) {
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const search = query.trim();
  const page = useGalleryPage({ kind: 'video', hidden: false, compact: true, q: search }, { media: true });
  const items = useMemo(() => page.items.map(normalizeMediaRow), [page.items]);
  // A host can switch records while the upload is in flight.
  const dismissed = useRef(false);
  const handleSelectCard = useCallback((item) => {
    onSelect?.(item);
    onClose?.();
  }, [onClose, onSelect]);
  useEffect(() => {
    dismissed.current = false;
    return () => { dismissed.current = true; };
  }, []);

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const uploadVideo = uploadToGallery ? uploadGalleryVideo : uploadFile;
    const saved = await uploadVideo(file, file.name, { silent: true }).catch((err) => {
      if (!dismissed.current) toast.error(err?.message || 'Upload failed');
      return null;
    });
    if (dismissed.current) return;
    setUploading(false);
    if (!saved?.filename) return;
    if (uploadToGallery) {
      onSelect?.(normalizeVideo(saved), { origin: 'upload' });
      onClose?.();
      return;
    }
    onSelect?.({
      kind: 'upload',
      filename: saved.filename,
      label: file.name,
      previewUrl: null,
    });
    onClose?.();
  };

  return (
    <GalleryPickerShell
      open
      onClose={onClose}
      title="Pick a video"
      ariaLabel="Pick a video from your gallery"
      searchId="video-picker-search"
      searchLabel="Search videos"
      searchPlaceholder="Search prompt, model, seed…"
      query={query}
      onQueryChange={setQuery}
      upload={allowUpload ? {
        accept, onChange: handleUpload, uploading, title: 'Upload a video from your device',
      } : null}
      items={items}
      loading={page.loading}
      loadingText="Loading videos…"
      error={page.error}
      errorSubject="your video gallery"
      onRetry={page.retry}
      hasMore={page.hasMore}
      remaining={page.total - items.length}
      onLoadMore={page.loadMore}
      emptyText={search ? 'No videos match your search.' : 'No videos in your gallery yet.'}
      onSelect={handleSelectCard}
    />
  );
}
