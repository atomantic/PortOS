import { useState, useMemo, useCallback } from 'react';
import { normalizeImage } from '../components/media/normalize';
import { descriptorForCanonEntry } from '../lib/canonPrompt';
import { listSheetPointers } from '../lib/sheetPointers';
import useGallerySidecars from './useGallerySidecars';
import usePreviewRoute from './usePreviewRoute';
import useMediaPreviewActions from './useMediaPreviewActions';
import { useMediaAnnotations } from './useMediaAnnotations';

// Page-level lightbox + gallery-metadata concern for the Universe Builder.
// Extracted from UniverseBuilder.jsx (#2532) so the route shell stays thin.
// A single MediaPreview at this level covers EVERY thumb on the page:
// variations, composite sheets, canon imageRefs, style probes, and character
// reference sheets — so clicking any image opens the same full-detail modal
// History / Collections / ImageGen use, with the same actions (Refine / Remix
// / SendToVideo / Clean / AddToCollection / Download / notes).
//
// Inputs:
//   - draft: the editable universe draft. `previewItems` is derived from its
//     categories / compositeSheets / styleImageRefs / canon arrays.
//   - runsLength: `runs.length` — advances on initial-load and queue-time, used
//     (alongside `galleryRefreshKey`) to trigger the gallery-metadata refetch.
//
// Returns the full preview/gallery bundle the page wires into UI:
//   previewItems, preview, setPreview, previewActions,
//   openPreviewByFilename, openVariationPreview, annotations, updateAnnotation,
//   bumpGalleryRefresh.
export default function useUniverseGallery({ draft, runsLength }) {
  // Filename → full image-metadata-sidecar record (prompt, negativePrompt,
  // modelId, width, height, seed, etc.). Hydrates `previewItems` with the
  // ACTUAL prompt that was used to render the image — without this the
  // modal would only see the variation's label, and Refine Prompt / Remix
  // / Send to Video would all open with empty fields.
  //
  // The refresh key carries two signals: `runsLength` advances when a run is
  // queued or loaded, and `galleryRefreshKey` is bumped on every job
  // completion — keying on runs alone left a freshly rendered thumb opening
  // with label-only metadata until a full page reload.
  const [galleryRefreshKey, setGalleryRefreshKey] = useState(0);
  const bumpGalleryRefresh = useCallback(() => setGalleryRefreshKey((k) => k + 1), []);
  const galleryFilenames = useMemo(() => {
    const refs = new Set(draft?.styleImageRefs || []);
    for (const bucket of Object.values(draft?.categories || {})) {
      for (const entry of bucket?.variations || []) for (const filename of entry.imageRefs || []) refs.add(filename);
    }
    for (const entry of [...(draft?.compositeSheets || []), ...(draft?.characters || []), ...(draft?.places || []), ...(draft?.objects || [])]) {
      for (const filename of entry.imageRefs || []) refs.add(filename);
    }
    return [...refs];
  }, [draft]);
  const { byFilename: galleryByFilename, setSidecar } = useGallerySidecars(galleryFilenames, `${runsLength}:${galleryRefreshKey}`);
  const { annotations, updateAnnotation } = useMediaAnnotations();
  const previewItems = useMemo(() => {
    const out = [];
    // Dedupe by full namespaced key (`image:<filename>` vs
    // `canon-sheet:<filename>`) so a gallery image and a character reference
    // sheet that share a basename can coexist in the items list — without the
    // namespace, the first-pushed item would suppress the second and the
    // preview-URL resolver would never see the other asset.
    const seen = new Set();
    const pushFilename = (filename, label) => {
      if (typeof filename !== 'string' || !filename) return;
      const key = `image:${filename}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Pull the real prompt + render settings out of the gallery metadata
      // map when available so the lightbox shows the full prompt that was
      // sent to the renderer (with universe style influences, variation
      // prompt fragment, etc.), not just the row's display label. The row's
      // label is the fallback for filenames not in the gallery (legacy
      // renders or a pending re-fetch).
      //
      // Same `image:<filename>` key normalizeImage() stamps everywhere else —
      // History, Collections, ImageGen — so a star/note added from this
      // lightbox is the SAME annotation record those pages already read, and
      // the cleaning/regen lineage the lightbox's variant toggle keys on
      // survives the hop (a hand-rolled item shape silently dropped it).
      const meta = galleryByFilename.get(filename);
      out.push(normalizeImage({ ...meta, filename, prompt: meta?.prompt || label || filename }));
    };
    const cats = draft?.categories && typeof draft.categories === 'object' ? draft.categories : {};
    for (const [bucketKey, bucket] of Object.entries(cats)) {
      const variations = Array.isArray(bucket?.variations) ? bucket.variations : [];
      for (const v of variations) {
        const refs = Array.isArray(v?.imageRefs) ? v.imageRefs : [];
        for (const f of refs) pushFilename(f, `${bucketKey} · ${v.label}`);
      }
    }
    const sheets = Array.isArray(draft?.compositeSheets) ? draft.compositeSheets : [];
    for (const s of sheets) {
      const refs = Array.isArray(s?.imageRefs) ? s.imageRefs : [];
      for (const f of refs) pushFilename(f, `Composite · ${s.label}`);
    }
    // Base style probe renders — same `image:<filename>` namespace so the
    // lightbox finds them and reuses the gallery sidecar metadata.
    const styleRefs = Array.isArray(draft?.styleImageRefs) ? draft.styleImageRefs : [];
    for (const f of styleRefs) pushFilename(f, 'Base style');
    // Canon refs — characters / places / objects. Hydrate from the gallery
    // sidecar so the modal shows the ACTUAL render prompt (the same one the
    // History page sees), not just the character description. The descriptor
    // string is only used as a fallback label when no sidecar exists (legacy
    // canon renders without metadata). Character reference sheets live in a
    // different static prefix (`/data/image-refs/`) so they get a dedicated
    // `canon-sheet:<filename>` key + don't collide with gallery entries.
    const canonKinds = [
      { key: 'characters', singular: 'character' },
      { key: 'places', singular: 'place' },
      { key: 'objects', singular: 'object' },
    ];
    for (const kind of canonKinds) {
      const list = Array.isArray(draft?.[kind.key]) ? draft[kind.key] : [];
      for (const entry of list) {
        const descriptor = descriptorForCanonEntry(kind.key, entry) || '';
        const fallbackLabel = `${entry.name}${descriptor ? `: ${descriptor}` : ''}`;
        const refs = Array.isArray(entry?.imageRefs) ? entry.imageRefs : [];
        for (const f of refs) pushFilename(f, fallbackLabel);
        if (kind.key === 'characters') {
          for (const { variant, filename } of listSheetPointers(entry)) {
            const sheetKey = `canon-sheet:${variant}:${filename}`;
            if (seen.has(sheetKey)) continue;
            seen.add(sheetKey);
            out.push({
              key: sheetKey,
              kind: 'image',
              filename,
              previewUrl: `/data/image-refs/${filename}`,
              downloadUrl: `/data/image-refs/${filename}`,
              prompt: `${entry.name} — character reference sheet (${variant})`,
            });
          }
        }
      }
    }
    return out;
  }, [draft, galleryByFilename]);
  const [preview, setPreview] = usePreviewRoute(previewItems);
  // Shared preview action handlers (Remix / SendToVideo / Clean) so the
  // universe lightbox opens the same downstream pages with the same params
  // as the History grid + Image Gen page. `onCleanComplete` splices the
  // cleaned image into the local gallery map so the next preview open
  // shows it immediately — no full refetch needed.
  const previewActions = useMediaPreviewActions({ onCleanComplete: setSidecar });
  // Generic filename → preview opener used by every clickable thumb on the
  // page (variation grids, composite sheets, canon entries, character
  // reference sheets). `opts.isSheet` forces a key match against the
  // `canon-sheet:<variant>:` prefix so a basename collision with a gallery
  // image can't route the lightbox to `/data/images/` instead of
  // `/data/image-refs/`. The exact variant id isn't known at this callsite
  // (the panel reads the field; the variant only lives inside the key),
  // so match on the `canon-sheet:` prefix + filename suffix instead of an
  // exact equality compare. Pre-variant keys (`canon-sheet:<filename>`)
  // still match this prefix check.
  const openPreviewByFilename = useCallback((filename, opts) => {
    if (!filename) return;
    const sheetMatch = opts?.isSheet
      ? previewItems.find((i) => typeof i.key === 'string' && i.key.startsWith('canon-sheet:') && i.filename === filename)
      : null;
    const match = sheetMatch || previewItems.find((i) => i.filename === filename);
    if (match) setPreview(match);
  }, [previewItems, setPreview]);
  // Legacy name retained for the variation/composite call sites that pass a
  // single filename — same implementation, different label.
  const openVariationPreview = openPreviewByFilename;

  return {
    previewItems,
    preview,
    setPreview,
    previewActions,
    openPreviewByFilename,
    openVariationPreview,
    annotations,
    updateAnnotation,
    bumpGalleryRefresh,
  };
}
