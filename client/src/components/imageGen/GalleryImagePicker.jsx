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
// beside the picker. Uploads have no default file-size limit.
//
// Local gallery only — no external/web search (deliberate, see plan).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GalleryPickerShell from '../media/GalleryPickerShell';
import { normalizeImage } from '../media/normalize';
import { listImageGalleryFacets } from '../../services/apiImageVideo';
import { listUniverseNames } from '../../services/apiUniverseBuilder';
import { uploadGalleryImage } from '../../services/apiSystem';
import {
  validateImageFile, UPLOAD_IMAGE_ACCEPT,
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
  open, onClose, onSelect, allowUpload = false, maxBytes = Infinity,
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
  const items = useMemo(() => page.items.map(normalizeImage), [page.items]);
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
    // Validate the format as well as the input's accept hint.
    const invalid = validateImageFile(file, maxBytes);
    if (invalid) { toast.error(invalid); return; }
    const session = sessionRef.current;
    setUploading(true);
    const saved = await uploadGalleryImage(file, { silent: true }).catch((err) => {
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
    handleSelectCard(normalizeImage({ filename: saved.filename, path: saved.path }));
  };

  const filters = (
    <>
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
    </>
  );

  return (
    <GalleryPickerShell
      open={open}
      onClose={onClose}
      title="Pick from gallery"
      ariaLabel="Pick an image from your gallery"
      searchId="gallery-picker-search"
      searchLabel="Search gallery"
      searchPlaceholder="Search prompt, model, seed, LoRA…"
      query={query}
      onQueryChange={setQuery}
      upload={allowUpload ? {
        accept: UPLOAD_IMAGE_ACCEPT, onChange: handleUpload, uploading, title: 'Upload an image from your device',
      } : null}
      filters={filters}
      items={items}
      loading={page.loading}
      loadingText="Loading gallery…"
      error={page.error}
      errorSubject="your image gallery"
      onRetry={page.retry}
      hasMore={page.hasMore}
      remaining={page.total - items.length}
      onLoadMore={page.loadMore}
      emptyText={query || scope || type ? 'No images match your search or filters.' : 'No images in your gallery yet.'}
      onSelect={handleSelectCard}
    />
  );
}
