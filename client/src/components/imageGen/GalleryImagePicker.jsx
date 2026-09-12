// Visual picker over paginated local image metadata. Search, collection/universe
// scope and type filters run before server paging; global facets keep older
// images discoverable. onSelect receives the normalized media item.
//
// Two dropdowns narrow the grid further: a grouped Universe/Collection scope
// and an entry Type. Both AND-combine with the text query.
//
// With `allowUpload`, a header "Upload" button lets the user pick a file off
// disk: it's saved into the gallery via POST /api/image-gen/upload (so the
// stored `/data/images/<f>` URL syncs to peers, unlike a generic upload) and
// then selected exactly like a gallery image — the same source-image flow the
// image→3D page feeds to createImageTo3dModel. Hosts get one modal for both
// "reuse an image" and "upload a new one" instead of a separate file `<input>`
// beside the picker; `maxBytes` narrows the size cap below the wire limit.
//
// Local gallery only — no external/web search (deliberate, see plan).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, RefreshCw, Upload } from 'lucide-react';
import Modal from '../ui/Modal';
import FilePickerButton from '../ui/FilePickerButton';
import MediaCard from '../media/MediaCard';
import { normalizeImage } from '../media/normalize';
import { listImageGalleryFacets } from '../../services/apiImageVideo';
import { listUniverseNames } from '../../services/apiUniverseBuilder';
import { uploadGalleryImage } from '../../services/apiSystem';
import {
  readFileAsBase64, validateImageFile, JSON_UPLOAD_MAX_FILE_SIZE, UPLOAD_IMAGE_ACCEPT,
} from '../../utils/fileUpload';
import { useGalleryPage } from '../../hooks/useGalleryPage';
import { humanizeCategory } from '../../lib/universeBuilderShared';
import toast from '../ui/Toast';

// Scope-select values are prefixed so one <select> can carry both option kinds.
const UNI_PREFIX = 'uni:';
const COL_PREFIX = 'col:';
// The type select spans two independent vocabularies — `entryCategory` is a
// user-authored bucket key, `entryKind` is the fixed canon/variation/sheet
// stage. They can collide (a category literally keyed `canon`), so options are
// prefixed by which field they filter and grouped so the two "Canon" rows are
// still distinguishable in the list.
const CAT_PREFIX = 'cat:';
const KIND_PREFIX = 'kind:';
// A collection stores membership as `{ kind, ref }` (server/lib/mediaItemKey.js),
// which serializes to the same `<kind>:<ref>` string `normalizeImage` puts on
// `item.key` — so membership is a set lookup, not a filename comparison.
const byLabel = (a, b) => a.label.localeCompare(b.label);
// Image sidecars are unvalidated JSON on disk and arrive from peers, so a
// non-string `entryCategory` / `universeName` is representable. Everything
// downstream here calls string methods (humanizeCategory, localeCompare), so a
// bad value drops the option rather than throwing during render.
const asText = (value) => (typeof value === 'string' && value.trim() ? value : null);

export default function GalleryImagePicker({
  open, onClose, onSelect, allowUpload = false, maxBytes = JSON_UPLOAD_MAX_FILE_SIZE,
}) {
  const [facets, setFacets] = useState({ universes: [], categories: [], kinds: [], collections: [] });
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [universes, setUniverses] = useState([]);
  // '' = All. Otherwise `uni:<id>` or `col:<id>`.
  const [scope, setScope] = useState('');
  const [type, setType] = useState('');
  // Bumped on every open/close transition — and on unmount, for a host that
  // tears the picker down instead of toggling `open` — so an async upload can
  // tell whether the picker session it started in is still the current one.
  const sessionRef = useRef(0);
  const handleSelectCard = useCallback((item) => {
    onSelect?.(item);
    onClose?.();
  }, [onClose, onSelect]);
  useEffect(() => {
    sessionRef.current += 1;
    return () => { sessionRef.current += 1; };
  }, [open]);

  const page = useGalleryPage({ q: query, hidden: false,
    universeId: scope.startsWith(UNI_PREFIX) ? scope.slice(UNI_PREFIX.length) : undefined,
    collectionId: scope.startsWith(COL_PREFIX) ? scope.slice(COL_PREFIX.length) : undefined,
    entryCategory: type.startsWith(CAT_PREFIX) ? type.slice(CAT_PREFIX.length) : undefined,
    entryKind: type.startsWith(KIND_PREFIX) ? type.slice(KIND_PREFIX.length) : undefined,
  }, { enabled: open });
  const { loading } = page;
  const items = useMemo(() => page.items.map(normalizeImage), [page.items]);
  const filtered = items;
  useEffect(() => {
    if (!open) { setQuery(''); setScope(''); setType(''); setFacets({ universes: [], categories: [], kinds: [], collections: [] }); setUniverses([]); return; }
    let cancelled = false;
    listImageGalleryFacets({ silent: true }).then(value => { if (!cancelled) setFacets(value); })
      .catch(() => { if (!cancelled) toast.error('Could not load gallery filters'); });
    listUniverseNames({ silent: true }).then(value => { if (!cancelled) setUniverses(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);
  const universeOptions = useMemo(() => facets.universes.map(u => ({ value: `${UNI_PREFIX}${u.id}`,
    label: asText(universes.find(v => v.id === u.id)?.name) || u.name || u.id })).sort(byLabel), [facets, universes]);
  const collectionOptions = useMemo(() => facets.collections.map(c => ({ value: `${COL_PREFIX}${c.id}`, label: asText(c.name) || c.id })).sort(byLabel), [facets]);
  const categoryOptions = useMemo(() => facets.categories.map(value => ({ value: `${CAT_PREFIX}${value}`, label: humanizeCategory(value) })).sort(byLabel), [facets]);
  const kindOptions = useMemo(() => facets.kinds.map(value => ({ value: `${KIND_PREFIX}${value}`, label: humanizeCategory(value) })).sort(byLabel), [facets]);

  // Upload a file off disk into the gallery, then select it like any gallery
  // image. Saving goes through the peer-syncable `/data/images/` upload so the
  // resulting `filename` resolves for createImageTo3dModel — and so a host that
  // stores the returned URL on a record (album cover, artist portrait, author
  // headshot) gets bytes that actually transfer to federated peers (issue #1327).
  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    // Drag-drop and clipboard paste bypass the picker's `accept`, and an
    // oversized body only fails as an opaque 413 — so gate here, not just in the
    // file dialog. `maxBytes` lets a host keep a tighter product cap than the wire limit.
    const invalid = validateImageFile(file, maxBytes);
    if (invalid) { toast.error(invalid); return; }
    const session = sessionRef.current;
    setUploading(true);
    const base64 = await readFileAsBase64(file).catch(() => null);
    if (!base64) { setUploading(false); toast.error(`Failed to read ${file.name}`); return; }
    const saved = await uploadGalleryImage(base64, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Upload failed');
      return null;
    });
    setUploading(false);
    if (!saved?.filename) return;
    // The host may have dismissed the picker (Esc / backdrop / X) while the read
    // + POST were in flight and moved on to a different record. Selecting now
    // would write this image onto whatever the host has open instead — so the
    // upload stays in the gallery, but nothing is picked.
    if (sessionRef.current !== session) return;
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
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col"
      ariaLabel="Pick an image from your gallery"
    >
      <div className="p-3 border-b border-port-border space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-white shrink-0">Pick from gallery</h2>
          <div className="flex items-center gap-2 shrink-0">
            {allowUpload && (
              <FilePickerButton
                accept={UPLOAD_IMAGE_ACCEPT}
                onChange={handleUpload}
                disabled={uploading}
                title="Upload an image from your device"
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
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <label htmlFor="gallery-picker-search" className="sr-only">Search gallery</label>
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              id="gallery-picker-search"
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
          {(universeOptions.length > 0 || collectionOptions.length > 0) && (
            <div className="sm:w-44">
              <label htmlFor="gallery-picker-scope" className="sr-only">Filter by universe or collection</label>
              <select
                id="gallery-picker-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-port-accent"
              >
                <option value="">All universes &amp; collections</option>
                {universeOptions.length > 0 && (
                  <optgroup label="Universes">
                    {universeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </optgroup>
                )}
                {collectionOptions.length > 0 && (
                  <optgroup label="Collections">
                    {collectionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          )}
          {(categoryOptions.length > 0 || kindOptions.length > 0) && (
            <div className="sm:w-36">
              <label htmlFor="gallery-picker-type" className="sr-only">Filter by type</label>
              <select
                id="gallery-picker-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-port-accent"
              >
                <option value="">All types</option>
                {categoryOptions.length > 0 && (
                  <optgroup label="Categories">
                    {categoryOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </optgroup>
                )}
                {kindOptions.length > 0 && (
                  <optgroup label="Entry kinds">
                    {kindOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </optgroup>
                )}
              </select>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading gallery…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-gray-500 py-10 text-center">
            {query || scope || type ? 'No images match your search or filters.' : 'No images in your gallery yet.'}
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
        {page.error && <p role="alert" className="text-sm text-port-error">{page.error} <button type="button" onClick={page.retry}>Retry</button></p>}
        {page.hasMore && <button type="button" disabled={loading} onClick={page.loadMore} className="w-full min-h-[44px] text-port-accent">{loading ? 'Loading…' : `Show more (${page.total - items.length} remaining)`}</button>}
      </div>
    </Modal>
  );
}
