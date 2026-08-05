// Visual picker over the local image gallery — the "search + grid" alternative
// to the plain file `<input>` in InitImagePicker. Opens as a modal, fetches the
// gallery on open (GET /api/image-gen/gallery via listImageGallery), and lets
// the user search by prompt/model/seed/LoRA/etc. (shared lib/mediaSearch logic,
// same as MediaHistory) and click a thumbnail to pick it. Calls `onSelect(item)`
// with the normalized media item (item.filename + item.previewUrl) then closes.
//
// Two dropdowns narrow the grid further: a grouped Universe/Collection scope
// and an entry Type. Both AND-combine with the text query.
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
import FilePickerButton from '../ui/FilePickerButton';
import MediaCard from '../media/MediaCard';
import { normalizeImage } from '../media/normalize';
import { listImageGallery, listMediaCollections } from '../../services/apiImageVideo';
import { listUniverses } from '../../services/apiUniverseBuilder';
import { uploadGalleryImage } from '../../services/apiSystem';
import { readFileAsBase64 } from '../../utils/fileUpload';
import { buildMediaHaystack, tokenizeQuery, matchHaystack } from '../../lib/mediaSearch';
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
const membershipKey = (it) => `${it?.kind}:${it?.ref}`;
const byLabel = (a, b) => a.label.localeCompare(b.label);

export default function GalleryImagePicker({ open, onClose, onSelect, allowUpload = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [query, setQuery] = useState('');
  const [collections, setCollections] = useState([]);
  const [universes, setUniverses] = useState([]);
  // '' = All. Otherwise `uni:<id>` or `col:<id>`.
  const [scope, setScope] = useState('');
  const [type, setType] = useState('');

  // Fetch the gallery each time the picker opens so newly generated images show
  // up without a page reload. Reset the search on close so a re-open starts clean.
  useEffect(() => {
    if (!open) { setQuery(''); setScope(''); setType(''); return; }
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

  // Filter sources are best-effort: either fetch failing just drops that group
  // from the scope dropdown, leaving text + type filtering intact. `silent`
  // because the empty-list fallback below is this caller's error UI.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    listMediaCollections({ silent: true })
      .then((list) => { if (!cancelled) setCollections(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setCollections([]); });
    listUniverses({ silent: true })
      .then((list) => { if (!cancelled) setUniverses(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setUniverses([]); });
    return () => { cancelled = true; };
  }, [open]);

  // Cache each item's haystack per fetched list; keystrokes then only re-run the
  // cheap token match instead of rebuilding every haystack (mirrors MediaHistory).
  const haystacks = useMemo(() => items.map(buildMediaHaystack), [items]);
  const tokens = useMemo(() => tokenizeQuery(query), [query]);

  // Universes are seeded from the images' own `universeId`/`universeName` stamps
  // so the group still populates when listUniverses fails; the fetched record
  // only supplies a fresher display name for a universe that was renamed after
  // the sidecar was written. Universes with no image here are dropped — a scope
  // that can only ever yield an empty grid isn't worth an option row.
  const universeOptions = useMemo(() => {
    const present = new Map();
    for (const it of items) {
      if (it.universeId && !present.has(it.universeId)) present.set(it.universeId, it.universeName || it.universeId);
    }
    for (const u of universes) {
      if (u?.id && u.name && present.has(u.id)) present.set(u.id, u.name);
    }
    return [...present.entries()]
      .map(([id, label]) => ({ value: `${UNI_PREFIX}${id}`, label }))
      .sort(byLabel);
  }, [items, universes]);

  const galleryKeys = useMemo(() => new Set(items.map((it) => it.key)), [items]);

  // Same "must match something" rule as universes. A collection also holds video
  // refs, which this image-only picker can never surface.
  const collectionOptions = useMemo(() => collections
    .filter((c) => Array.isArray(c?.items) && c.items.some((it) => galleryKeys.has(membershipKey(it))))
    .map((c) => ({ value: `${COL_PREFIX}${c.id}`, label: c.name || c.id }))
    .sort(byLabel), [collections, galleryKeys]);

  const [categoryOptions, kindOptions] = useMemo(() => {
    const categories = new Set();
    const kinds = new Set();
    for (const it of items) {
      if (it.entryCategory) categories.add(it.entryCategory);
      if (it.entryKind) kinds.add(it.entryKind);
    }
    const toOptions = (values, prefix) => [...values]
      .map((value) => ({ value: `${prefix}${value}`, label: humanizeCategory(value) }))
      .sort(byLabel);
    return [toOptions(categories, CAT_PREFIX), toOptions(kinds, KIND_PREFIX)];
  }, [items]);

  // Membership set for the selected collection — `null` whenever no collection
  // is scoped, which is the signal the filter uses to skip the check entirely.
  const scopedCollectionKeys = useMemo(() => {
    if (!scope.startsWith(COL_PREFIX)) return null;
    const collection = collections.find((c) => c?.id === scope.slice(COL_PREFIX.length));
    return new Set((collection?.items || []).map(membershipKey));
  }, [scope, collections]);

  // A selection that survived a gallery/collection refetch but no longer has an
  // option row would silently filter everything out — drop it back to "All".
  useEffect(() => {
    if (scope && ![...universeOptions, ...collectionOptions].some((o) => o.value === scope)) setScope('');
  }, [scope, universeOptions, collectionOptions]);
  useEffect(() => {
    if (type && ![...categoryOptions, ...kindOptions].some((o) => o.value === type)) setType('');
  }, [type, categoryOptions, kindOptions]);

  const filtered = useMemo(() => {
    const universeId = scope.startsWith(UNI_PREFIX) ? scope.slice(UNI_PREFIX.length) : null;
    const category = type.startsWith(CAT_PREFIX) ? type.slice(CAT_PREFIX.length) : null;
    const kind = type.startsWith(KIND_PREFIX) ? type.slice(KIND_PREFIX.length) : null;
    if (tokens.length === 0 && !universeId && !scopedCollectionKeys && !category && !kind) return items;
    return items.filter((item, idx) => {
      if (tokens.length > 0 && !matchHaystack(haystacks[idx], tokens)) return false;
      if (universeId && item.universeId !== universeId) return false;
      if (scopedCollectionKeys && !scopedCollectionKeys.has(item.key)) return false;
      if (category && item.entryCategory !== category) return false;
      if (kind && item.entryKind !== kind) return false;
      return true;
    });
  }, [items, haystacks, tokens, scope, scopedCollectionKeys, type]);

  // Upload a file off disk into the gallery, then select it like any gallery
  // image. Saving goes through the peer-syncable `/data/images/` upload so the
  // resulting `filename` resolves for createImageTo3dModel.
  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
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
      <div className="p-3 border-b border-port-border space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-white shrink-0">Pick from gallery</h2>
          <div className="flex items-center gap-2 shrink-0">
            {allowUpload && (
              <FilePickerButton
                accept="image/png,image/jpeg,image/webp,image/gif"
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
        {loading ? (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading gallery…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-gray-500 py-10 text-center">
            {items.length === 0 ? 'No images in your gallery yet.' : 'No images match your search or filters.'}
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
