// Visual picker over the local image gallery — the "search + grid" alternative
// to the plain file `<input>` in InitImagePicker. Opens as a modal, fetches the
// gallery on open (GET /api/image-gen/gallery via listImageGallery), and lets
// the user search by prompt/model/seed/LoRA/etc. (shared lib/mediaSearch logic,
// same as MediaHistory) and click a thumbnail to pick it. Calls `onSelect(item)`
// with the normalized media item (item.filename + item.previewUrl) then closes.
//
// With `allowUpload`, a header "Upload" button lets the user pick a file off
// disk: it's saved into the gallery via POST /api/image-gen/upload (so the
// stored `/data/images/<f>` URL syncs to peers, unlike a generic upload) and
// then selected exactly like a gallery image — the same source-image flow the
// image→3D page feeds to createImageTo3dModel.
//
// Local gallery only — no external/web search (deliberate, see plan).

import { useEffect, useMemo, useState } from 'react';
import { Search, X, RefreshCw, Upload } from 'lucide-react';
import Modal from '../ui/Modal';
import MediaCard from '../media/MediaCard';
import { normalizeImage } from '../media/normalize';
import { listImageGallery } from '../../services/apiImageVideo';
import { uploadGalleryImage } from '../../services/apiSystem';
import { readFileAsBase64 } from '../../utils/fileUpload';
import { buildMediaHaystack, tokenizeQuery, matchHaystack } from '../../lib/mediaSearch';
import toast from '../ui/Toast';

export default function GalleryImagePicker({ open, onClose, onSelect, allowUpload = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');

  // Fetch the gallery each time the picker opens so newly generated images show
  // up without a page reload. Reset the search on close so a re-open starts clean.
  useEffect(() => {
    if (!open) { setQuery(''); return; }
    let cancelled = false;
    setLoading(true);
    listImageGallery()
      .then((images) => {
        if (cancelled) return;
        const normalized = (Array.isArray(images) ? images : [])
          .map(normalizeImage)
          // Skip hidden images — the picker is for reuse, not gallery management.
          .filter((it) => !it.hidden);
        setItems(normalized);
      })
      .catch(() => { if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // Cache each item's haystack per fetched list; keystrokes then only re-run the
  // cheap token match instead of rebuilding every haystack (mirrors MediaHistory).
  const haystacks = useMemo(() => items.map(buildMediaHaystack), [items]);
  const tokens = useMemo(() => tokenizeQuery(query), [query]);
  const filtered = useMemo(
    () => tokens.length === 0 ? items : items.filter((_, idx) => matchHaystack(haystacks[idx], tokens)),
    [items, haystacks, tokens],
  );

  // Upload a file off disk into the gallery, then select it like any gallery
  // image. Saving goes through the peer-syncable `/data/images/` upload so the
  // resulting `filename` resolves for createImageTo3dModel.
  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file after an error
    if (!file) return;
    setUploading(true);
    const base64 = await readFileAsBase64(file).catch(() => null);
    if (!base64) { setUploading(false); toast.error(`Failed to read ${file.name}`); return; }
    const saved = await uploadGalleryImage(base64, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Upload failed');
      return null;
    });
    setUploading(false);
    if (!saved?.filename) return;
    onSelect?.(normalizeImage({ filename: saved.filename, path: saved.path }));
    onClose?.();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="3xl"
      // Portal to <body> so the picker escapes every page/modal stacking
      // context. Without this it renders inline and, under themes that ship a
      // non-none --port-backdrop-filter (Lumen Glass, Blueprint Ops), each
      // ancestor .bg-port-card becomes a stacking context that traps the fixed
      // overlay beneath the page header/cards (and beneath a host modal when the
      // picker is opened from inside one).
      usePortal
      panelClassName="bg-port-card border border-port-border rounded-xl max-h-[85vh] flex flex-col"
      ariaLabel="Pick an image from your gallery"
    >
      <div className="flex items-center justify-between gap-3 p-3 border-b border-port-border">
        <h2 className="text-sm font-medium text-white shrink-0">Pick from gallery</h2>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompt, model, seed, LoRA…"
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
        {allowUpload && (
          <label
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-300 ${uploading ? 'cursor-wait opacity-60' : 'cursor-pointer hover:border-port-accent hover:text-white'}`}
            title="Upload an image from your device"
          >
            {uploading
              ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Uploading…</>
              : <><Upload className="h-3.5 w-3.5" /> Upload</>}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              disabled={uploading}
              onChange={handleUpload}
            />
          </label>
        )}
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 p-1.5 text-gray-400 hover:text-white rounded"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading gallery…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-gray-500 py-10 text-center">
            {items.length === 0 ? 'No images in your gallery yet.' : 'No images match your search.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {filtered.map((item) => (
              <MediaCard
                key={item.key}
                item={item}
                hideActions
                showCollectionMenu={false}
                onClick={() => { onSelect?.(item); onClose?.(); }}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
