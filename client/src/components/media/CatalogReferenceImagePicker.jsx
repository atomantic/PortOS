import { useEffect, useState } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { getCatalogIngredientDetails } from '../../services/apiCatalog';
import { listSheetPointers } from '../../lib/sheetPointers';
import { isLeftOutOfLikeness, referenceReviewStatus } from '../../../../server/lib/catalogMediaLibrary.js';
import MediaImage from '../MediaImage';
import { safeBasename } from '../catalog/CatalogImagePreview';
import Modal from '../ui/Modal';

// Match the filenames accepted by the image-generation route. Canon pointers
// can predate media attachments, so include them alongside the media rows.
const imageFilename = (value) => typeof value === 'string' && value.length <= 256
  && safeBasename(value) && /\.(png|jpg|jpeg|webp)$/i.test(value);

export default function CatalogReferenceImagePicker({ ingredient, excluded, onClose, onBack, onSelect }) {
  const [state, setState] = useState({ id: null, media: null, missing: [], error: null });
  const [retry, setRetry] = useState(0);
  const id = ingredient?.id;

  useEffect(() => {
    if (!id) return undefined;
    let active = true;
    setState({ id, media: null, missing: [], error: null });
    getCatalogIngredientDetails(id, { view: 'media', silent: true })
      .then((result) => {
        if (active) setState({ id, media: result.media || [], missing: result.missingMedia || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ id, media: null, missing: [], error: error?.message || 'Request failed' });
      });
    return () => { active = false; };
  }, [id, retry]);

  const payload = ingredient?.payload || {};
  const canon = [payload.primaryImageRef, ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : []),
    ...listSheetPointers(payload).map(({ filename }) => filename)]
    .map((mediaKey) => ({ mediaKey, kind: 'reference' }));
  const rows = (Array.isArray(state.media) ? state.media : [])
    .filter((row) => !row.deleted && ['portrait', 'reference'].includes(row.kind));
  const images = new Map();
  for (const row of [...rows, ...canon]) {
    if (imageFilename(row.mediaKey) && !images.has(row.mediaKey)) images.set(row.mediaKey, row);
  }
  const missing = new Set((Array.isArray(state.missing) ? state.missing : []).map((row) => row.mediaKey));
  const unavailable = new Set(excluded);
  const bad = new Set(rows.filter((row) => referenceReviewStatus(row) === 'bad').map((row) => row.mediaKey));
  const leftOut = new Set(rows.filter(isLeftOutOfLikeness).map((row) => row.mediaKey));
  const loading = state.id !== id || (!state.media && !state.error);

  return (
    <Modal open={Boolean(ingredient)} onClose={onClose} size="xl" usePortal
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col" ariaLabel="Pick a catalog reference image">
      <div className="flex items-center justify-between gap-2 p-4 border-b border-port-border">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">Pick an image</h2>
          <p className="text-sm text-gray-400 break-words">{ingredient?.name || 'Catalog item'}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close catalog image picker"
          className="min-h-11 min-w-11 flex items-center justify-center rounded text-gray-400 hover:text-white">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <button type="button" onClick={onBack} className="min-h-11 inline-flex items-center gap-1 rounded border border-port-border px-2 text-xs text-port-accent hover:border-port-accent">
          <ArrowLeft size={14} aria-hidden="true" /> Choose another catalog item
        </button>
        {loading ? <p className="text-sm text-gray-400">Loading images…</p>
          : state.error ? <p role="alert" className="text-sm text-port-error">Could not load images: {state.error} <button type="button" onClick={() => setRetry((n) => n + 1)} className="underline">Retry</button></p>
            : images.size === 0 ? <p className="text-sm text-gray-400">This catalog item has no reference images.</p>
              : <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {[...images.values()].map((row) => {
                  const filename = row.mediaKey;
                  const isMissing = missing.has(filename);
                  const isSelected = unavailable.has(filename);
                  const label = row.caption || row.library?.variant?.label || (row.kind === 'portrait' ? 'Primary image' : 'Reference');
                  const notes = [bad.has(filename) && 'Marked bad', leftOut.has(filename) && 'Left out of likeness',
                    isMissing && 'Missing', isSelected && 'Already added'].filter(Boolean);
                  const src = `/data/images/${encodeURIComponent(filename)}`;
                  return <button key={filename} type="button" disabled={isMissing || isSelected} onClick={() => onSelect(filename)}
                    aria-label={`Use ${label}: ${filename}${notes.length ? ` · ${notes.join(' · ')}` : ''}`}
                    className="min-w-0 rounded border border-port-border bg-port-bg text-left overflow-hidden hover:border-port-accent disabled:opacity-50">
                    <MediaImage src={src} thumbnail fallbackSrc={`/data/image-refs/${encodeURIComponent(filename)}`} alt="" loading="lazy" className="w-full aspect-square object-cover" />
                    <span className="block p-2 text-xs text-gray-300 break-words">{label}{notes.length ? ` · ${notes.join(' · ')}` : ''}</span>
                  </button>;
                })}
              </div>}
      </div>
    </Modal>
  );
}
