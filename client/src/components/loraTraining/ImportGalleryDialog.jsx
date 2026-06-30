/**
 * Import-from-gallery dialog for the LoRA dataset workbench.
 *
 * Multi-select picker over the local image gallery (GET /api/image-gen/gallery)
 * — the "choose images already in the system" path alongside upload/generate/
 * slice. Reuses the same normalize + search helpers as GalleryImagePicker, but
 * accumulates a selection and imports them all in one POST. The server copies
 * each into the dataset (independent of the gallery original).
 */

import { useEffect, useMemo, useState } from 'react';
import { Search, X, RefreshCw, Loader2, Check } from 'lucide-react';
import Modal from '../ui/Modal';
import MediaCard from '../media/MediaCard';
import toast from '../ui/Toast';
import { normalizeImage } from '../media/normalize';
import { listImageGallery, importLoraDatasetGalleryImages } from '../../services/api';
import { buildMediaHaystack, tokenizeQuery, matchHaystack } from '../../lib/mediaSearch';

const MAX_IMPORT = 50;

export default function ImportGalleryDialog({ dataset, onClose, onImported }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]); // ordered list of filenames
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listImageGallery()
      .then((images) => {
        if (cancelled) return;
        const normalized = (Array.isArray(images) ? images : [])
          .map(normalizeImage)
          .filter((it) => !it.hidden && it.filename);
        setItems(normalized);
      })
      .catch(err => { console.warn('⚠️ Failed to load gallery images: ' + err.message); if (!cancelled) setItems([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const haystacks = useMemo(() => items.map(buildMediaHaystack), [items]);
  const tokens = useMemo(() => tokenizeQuery(query), [query]);
  const filtered = useMemo(
    () => (tokens.length === 0 ? items : items.filter((_, idx) => matchHaystack(haystacks[idx], tokens))),
    [items, haystacks, tokens],
  );

  const toggle = (filename) => {
    setSelected((prev) => {
      if (prev.includes(filename)) return prev.filter((f) => f !== filename);
      if (prev.length >= MAX_IMPORT) {
        toast.error(`Import up to ${MAX_IMPORT} at a time`);
        return prev;
      }
      return [...prev, filename];
    });
  };

  const doImport = async () => {
    if (!selected.length) return;
    setImporting(true);
    try {
      const { images } = await importLoraDatasetGalleryImages(dataset.id, selected);
      toast.success(`Imported ${images.length} image${images.length === 1 ? '' : 's'} — caption them next`);
      onImported?.(images);
    } catch {
      // The api `request` helper already toasted the failure — swallow so the
      // un-awaited onClick doesn't surface an unhandled promise rejection.
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="3xl"
      panelClassName="bg-port-card border border-port-border rounded-xl max-h-[85vh] flex flex-col"
      ariaLabel="Import images from your gallery"
    >
      <div className="flex items-center justify-between gap-3 p-3 border-b border-port-border">
        <h2 className="text-sm font-medium text-white shrink-0">Import from gallery</h2>
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
            {filtered.map((item) => {
              const idx = selected.indexOf(item.filename);
              return (
                <MediaCard
                  key={item.key}
                  item={item}
                  hideActions
                  showCollectionMenu={false}
                  selected={idx !== -1}
                  selectionLabel={idx !== -1 ? String(idx + 1) : null}
                  onClick={() => toggle(item.filename)}
                />
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 p-3 border-t border-port-border">
        <span className="text-xs text-gray-400">
          {selected.length ? `${selected.length} selected` : 'Click images to select'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-sm text-gray-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={doImport}
            disabled={!selected.length || importing}
            className="px-3 py-2 text-sm rounded bg-port-accent text-white disabled:opacity-50 flex items-center gap-2"
          >
            {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Import {selected.length || ''}
          </button>
        </div>
      </div>
    </Modal>
  );
}
