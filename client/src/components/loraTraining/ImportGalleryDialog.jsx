/**
 * Import-from-gallery dialog for the LoRA dataset workbench.
 *
 * Multi-select picker over the local image gallery (GET /api/image-gen/gallery)
 * — the "choose images already in the system" path alongside upload/generate/
 * slice. Loads bounded, server-searched pages and accumulates a selection
 * across pages before importing them all in one POST. The server copies
 * each into the dataset (independent of the gallery original).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X, RefreshCw, Loader2, Check } from 'lucide-react';
import Modal from '../ui/Modal';
import MediaCard from '../media/MediaCard';
import toast from '../ui/Toast';
import { normalizeImage } from '../media/normalize';
import { listImageGalleryPage, importLoraDatasetGalleryImages } from '../../services/api';

const MAX_IMPORT = 50;

export default function ImportGalleryDialog({ dataset, onClose, onImported }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const requestId = useRef(0);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]); // ordered list of filenames
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(false);
    listImageGalleryPage({ limit: 60, offset, q: query, hidden: false }, { silent: true })
      .then(page => {
        if (id !== requestId.current) return;
        const next = page.items.map(normalizeImage);
        setItems(prev => offset === 0 ? next : [...prev, ...next]);
        setTotal(page.total);
      })
      .catch(err => {
        if (id !== requestId.current) return;
        setError(true);
        toast.error(err.message || 'Failed to load gallery');
      })
      .finally(() => { if (id === requestId.current) setLoading(false); });
    return () => { requestId.current += 1; };
  }, [query, offset, retry]);

  const toggle = useCallback((filename) => {
    setSelected((prev) => {
      if (prev.includes(filename)) return prev.filter((f) => f !== filename);
      if (prev.length >= MAX_IMPORT) {
        toast.error(`Import up to ${MAX_IMPORT} at a time`);
        return prev;
      }
      return [...prev, filename];
    });
  }, []);
  const handleToggleCard = useCallback((item) => toggle(item.filename), [toggle]);

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
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col"
      ariaLabel="Import images from your gallery"
    >
      <div className="flex items-center justify-between gap-3 p-3 border-b border-port-border">
        <h2 className="text-sm font-medium text-white shrink-0">Import from gallery</h2>
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOffset(0); setItems([]); setTotal(0); }}
            placeholder="Search prompt, model, seed, LoRA…"
            aria-label="Search gallery images"
            className="w-full pl-7 pr-7 py-1.5 text-xs bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setOffset(0); setItems([]); setTotal(0); }}
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
          className="shrink-0 p-1.5 text-gray-400 hover:text-white rounded min-h-[44px] min-w-[44px] flex items-center justify-center"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading && offset === 0 ? (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading gallery…
          </div>
        ) : items.length === 0 ? (
          <div className="text-xs text-gray-500 py-10 text-center">
            {error ? 'Gallery could not be loaded.' : query.trim() ? 'No images match your search.' : 'No images in your gallery yet.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {items.map((item) => {
              const idx = selected.indexOf(item.filename);
              return (
                <MediaCard
                  key={item.key}
                  item={item}
                  hideActions
                  showCollectionMenu={false}
                  selected={idx !== -1}
                  selectionLabel={idx !== -1 ? String(idx + 1) : null}
                  onClick={handleToggleCard}
                />
              );
            })}
          </div>
        )}
        {error && <button type="button" onClick={() => setRetry(n => n + 1)} className="w-full min-h-[44px] text-port-accent">Retry loading images</button>}
        {!error && items.length < total && (
          <button type="button" disabled={loading} onClick={() => setOffset(items.length)}
            className="w-full min-h-[44px] mt-3 text-sm text-port-accent disabled:opacity-50">
            {loading ? 'Loading…' : 'Show more'}
          </button>
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
