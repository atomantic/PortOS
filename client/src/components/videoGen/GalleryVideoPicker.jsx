// Visual picker over video history — the video counterpart of GalleryImagePicker.
// Opens as a modal, fetches one bounded compact page of GET /api/video-gen/history, lets the user
// search (server-side, so prompt text beyond the card preview still matches)
// and click a thumbnail. With
// `allowUpload`, a header Upload button saves the file via POST /api/uploads
// and selects it as `{ kind: 'upload', filename }` so the reverse-prompt
// endpoint can sample frames from PATHS.uploads. With `uploadToGallery`
// (#4188), the upload instead lands in the shared gallery (POST
// /api/video-gen/upload → /data/videos/ + a history entry, peer-syncable) and
// selects the normalized gallery item — required when the selection will be
// REFERENCED by a synced record (e.g. a mood-board item), because
// /api/uploads' scratch dir does not federate.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X, RefreshCw, Upload } from 'lucide-react';
import Modal from '../ui/Modal';
import FilePickerButton from '../ui/FilePickerButton';
import MediaCard from '../media/MediaCard';
import { normalizeVideo } from '../media/normalize';
import { listVideoHistory, uploadGalleryVideo } from '../../services/apiImageVideo';
import { uploadFile } from '../../services/apiMedia';
import useListResource from '../../hooks/useListResource';
import useCancelableDebounce from '../../hooks/useCancelableDebounce';
import ListLoadError from '../ui/ListLoadError';
import toast from '../ui/Toast';

const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.webm,.mov,.m4v';

const PICKER_PAGE_LIMIT = 60;
const SEARCH_DEBOUNCE_MS = 250;

export default function GalleryVideoPicker({
  open,
  onClose,
  onSelect,
  allowUpload = false,
  uploadToGallery = false,
  accept = VIDEO_ACCEPT,
}) {
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [scheduleSearch, cancelSearch] = useCancelableDebounce();
  const fetchVideoItems = useCallback(() => listVideoHistory({
    silent: true,
    query: { limit: PICKER_PAGE_LIMIT, compact: true, hidden: false, q: searchTerm.trim() },
  }).then((videos) => (Array.isArray(videos) ? videos : []).map(normalizeVideo).filter((it) => !it.hidden)), [searchTerm]);
  const { items, state, error, retry } = useListResource(fetchVideoItems, { enabled: open });
  // Invalidate on every open/close transition and on unmount. A host can
  // change its selected record while an upload is reading or posting; a late
  // completion must leave the saved gallery asset unselected.
  const sessionRef = useRef(0);
  const handleSelectCard = useCallback((item) => {
    onSelect?.(item);
    onClose?.();
  }, [onClose, onSelect]);
  useEffect(() => {
    sessionRef.current += 1;
    return () => { sessionRef.current += 1; };
  }, [open]);

  useEffect(() => {
    if (!open) { cancelSearch(); setQuery(''); setSearchTerm(''); }
  }, [open, cancelSearch]);

  const updateQuery = (value) => {
    setQuery(value);
    scheduleSearch(() => setSearchTerm(value), SEARCH_DEBOUNCE_MS);
  };
  const clearQuery = () => { cancelSearch(); setQuery(''); setSearchTerm(''); };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const session = sessionRef.current;
    setUploading(true);
    if (uploadToGallery) {
      const entry = await uploadGalleryVideo(file, file.name, { silent: true }).catch((err) => {
        if (sessionRef.current === session) toast.error(err?.message || 'Upload failed');
        return null;
      });
      if (sessionRef.current !== session) return;
      setUploading(false);
      if (!entry?.filename) return;
      onSelect?.(normalizeVideo(entry), { origin: 'upload' });
      onClose?.();
      return;
    }
    const saved = await uploadFile(file, file.name, { silent: true }).catch((err) => {
      if (sessionRef.current === session) toast.error(err?.message || 'Upload failed');
      return null;
    });
    if (sessionRef.current !== session) return;
    setUploading(false);
    if (!saved?.filename) return;
    onSelect?.({
      kind: 'upload',
      filename: saved.filename,
      label: file.name,
      previewUrl: null,
    });
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="3xl"
      usePortal
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col"
      ariaLabel="Pick a video from your gallery"
    >
      <div className="p-3 border-b border-port-border space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-white shrink-0">Pick a video</h2>
          <div className="flex items-center gap-2 shrink-0">
            {allowUpload && (
              <FilePickerButton
                accept={accept}
                onChange={handleUpload}
                disabled={uploading}
                title="Upload a video from your device"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-300 hover:border-port-accent hover:text-white"
              >
                {uploading
                  ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Uploading…</>
                  : <><Upload className="h-3.5 w-3.5" /> Upload</>}
              </FilePickerButton>
            )}
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 p-1.5 text-gray-400 hover:text-white rounded min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="relative">
          <label htmlFor="video-picker-search" className="sr-only">Search videos</label>
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            id="video-picker-search"
            type="text"
            value={query}
            onChange={(e) => updateQuery(e.target.value)}
            placeholder="Search prompt, model, seed…"
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={clearQuery}
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {state === 'loading' ? (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading videos…
          </div>
        ) : state === 'error' ? (
          <ListLoadError what="your video gallery" error={error} onRetry={retry} />
        ) : items.length === 0 ? (
          <div className="text-xs text-gray-500 py-10 text-center">
            {!searchTerm.trim() ? 'No videos in your gallery yet.' : 'No videos match your search.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {items.map((item) => (
              <MediaCard
                key={item.key}
                item={item}
                hideActions
                showCollectionMenu={false}
                onClick={handleSelectCard}
              />
            ))}
          </div>
        )}
        {state === 'ready' && items.length >= PICKER_PAGE_LIMIT && (
          <p className="pt-3 text-center text-xs text-gray-500">
            {searchTerm.trim()
              ? `Showing the first ${PICKER_PAGE_LIMIT} matches — refine your search.`
              : `Showing the newest ${PICKER_PAGE_LIMIT} videos — search to find older ones.`}
          </p>
        )}
      </div>
    </Modal>
  );
}
