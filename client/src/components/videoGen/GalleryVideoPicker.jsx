// Visual picker over video history — the video counterpart of GalleryImagePicker.
// Opens as a modal, fetches GET /api/video-gen/history on open, lets the user
// search (same haystack as MediaHistory) and click a thumbnail. With
// `allowUpload`, a header Upload button saves the file via POST /api/uploads
// and selects it as `{ kind: 'upload', filename }` so the reverse-prompt
// endpoint can sample frames from PATHS.uploads. With `uploadToGallery`
// (#4188), the upload instead lands in the shared gallery (POST
// /api/video-gen/upload → /data/videos/ + a history entry, peer-syncable) and
// selects the normalized gallery item — required when the selection will be
// REFERENCED by a synced record (e.g. a mood-board item), because
// /api/uploads' scratch dir does not federate.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, RefreshCw, Upload } from 'lucide-react';
import Modal from '../ui/Modal';
import FilePickerButton from '../ui/FilePickerButton';
import MediaCard from '../media/MediaCard';
import { normalizeVideo } from '../media/normalize';
import { listVideoHistory, uploadGalleryVideo } from '../../services/apiImageVideo';
import { uploadFile } from '../../services/apiMedia';
import { readFileAsBase64, JSON_UPLOAD_MAX_FILE_SIZE } from '../../utils/fileUpload';
import { buildMediaHaystack, tokenizeQuery, matchHaystack } from '../../lib/mediaSearch';
import { formatBytes } from '../../utils/formatters';
import toast from '../ui/Toast';

const VIDEO_ACCEPT = 'video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.webm,.mov,.m4v';

export default function GalleryVideoPicker({
  open,
  onClose,
  onSelect,
  allowUpload = false,
  uploadToGallery = false,
  accept = VIDEO_ACCEPT,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
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
    if (!open) { setQuery(''); return undefined; }
    let cancelled = false;
    setLoading(true);
    listVideoHistory()
      .then((videos) => {
        if (cancelled) return;
        const normalized = (Array.isArray(videos) ? videos : [])
          .map(normalizeVideo)
          .filter((it) => !it.hidden);
        setItems(normalized);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const haystacks = useMemo(() => items.map(buildMediaHaystack), [items]);
  const tokens = useMemo(() => tokenizeQuery(query), [query]);
  const filtered = useMemo(() => {
    if (!tokens.length) return items;
    return items.filter((_, idx) => matchHaystack(haystacks[idx], tokens));
  }, [items, haystacks, tokens]);

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > JSON_UPLOAD_MAX_FILE_SIZE) {
      toast.error(`Video is too large (${formatBytes(file.size)}). Max ${formatBytes(JSON_UPLOAD_MAX_FILE_SIZE)}.`);
      return;
    }
    const session = sessionRef.current;
    setUploading(true);
    const base64 = await readFileAsBase64(file).catch(() => null);
    if (sessionRef.current !== session) return;
    if (!base64) { setUploading(false); toast.error(`Failed to read ${file.name}`); return; }
    if (uploadToGallery) {
      const entry = await uploadGalleryVideo(base64, file.name, { silent: true }).catch((err) => {
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
    const saved = await uploadFile(base64, file.name, { silent: true }).catch((err) => {
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
      panelClassName="bg-port-card border border-port-border rounded-xl max-h-[85vh] flex flex-col"
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompt, model, seed…"
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading videos…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-gray-500 py-10 text-center">
            {items.length === 0 ? 'No videos in your gallery yet.' : 'No videos match your search.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filtered.map((item) => (
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
      </div>
    </Modal>
  );
}
