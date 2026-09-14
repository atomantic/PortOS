import { useEffect, useMemo, useRef, useState } from 'react';
import usePreviewRoute from './usePreviewRoute';
import { getGalleryImages, getVideoHistoryItem } from '../services/apiImageVideo';
import { normalizeImage, normalizeVideo } from '../components/media/normalize';

/**
 * `usePreviewRoute` plus lazy hydration of the OPEN item from its gallery
 * record — the image sidecar (`/image-gen/gallery/lookup`) or the video-history
 * entry.
 *
 * A page that owns its own media references composes a styled prompt on the way
 * out (universe/series style clause, project style suffix, deck style) and then
 * rebuilds a bare display label on the way back in. The lightbox then shows
 * wording that never reached the renderer, and Refine / Remix / Send to Video
 * open with that wrong prompt. The record written at render time is the only
 * thing that knows what was actually sent — along with the lineage fields
 * `MediaLightbox` needs for the original-vs-cleaned toggle and the
 * regen/watermark labels (`cleanedFrom`, `regenerated`, `watermarkRemoved`,
 * `renderMs`, `loraNames`, …), which a hand-rolled item shape drops.
 *
 * Hydrating lazily at this shared seam covers every `MediaPreview` host at once
 * and costs one single-item lookup when the modal opens, instead of a
 * whole-list POST on every page load. A page that needs records for more than
 * the lightbox (Universe Builder reads them for thumbs) still wants the eager
 * `useGallerySidecars` map.
 *
 * One item is the wrong unit for anything set-level, so lineage is only PARTLY
 * restored: `MediaPreview` substitutes the hydrated preview into the list it
 * scans, which is enough to pair an open CLEANED copy with its original, but
 * opening the original finds no cleaned sibling, because the siblings in the
 * list still carry no `cleanedFrom`. Hydrating the whole list is the only shape
 * that serves both directions — see #7346.
 *
 * The record wins on every field it carries; the host's item is the fallback,
 * and its `key` is kept outright — prev/next nav (`getAdjacentMedia`) and the
 * annotation lookup both match on it, so a key that drifted from the list would
 * silently disable both.
 *
 * Same `[preview, setPreview]` shape as `usePreviewRoute`; `options` passes
 * straight through (`paramName`, `resolveItem`).
 */
export default function useHydratedPreviewRoute(items, options) {
  const [preview, setPreview] = usePreviewRoute(items, options);
  // What the record is looked up BY: images by filename, videos by history id.
  // An item with neither (a synthetic entry backed by no gallery record) has
  // nothing to hydrate from and passes through untouched.
  const kind = preview?.kind;
  const ref = (kind === 'image' && preview.filename) || (kind === 'video' && preview.id) || null;
  // Cache the fetched records, not the merged items: the host's item identity
  // can change between opens (a re-render rebuilding the list) while the record
  // for a given filename/id does not.
  const [records, setRecords] = useState(() => new Map());
  // Every key already ATTEMPTED — hits and misses alike, so a legacy render
  // that has no record, or one whose lookup 404s, is asked for once rather than
  // on every reopen. Held in a ref so the effect can read it without taking the
  // map as a dependency and re-running on its own result (`useGallerySidecars`
  // does the same).
  const attemptedRef = useRef(new Set());

  useEffect(() => {
    const lookupKey = `${kind}:${ref}`;
    if (!ref || attemptedRef.current.has(lookupKey)) return undefined;
    let cancelled = false;
    const settle = (record) => {
      if (cancelled) return;
      attemptedRef.current.add(lookupKey);
      if (record) setRecords((prev) => new Map(prev).set(lookupKey, record));
    };
    // A failed lookup settles as a miss: non-fatal, and the host's own label
    // stands in for it.
    fetchRecord(kind, ref).then(settle, () => settle(null));
    return () => { cancelled = true; };
  }, [kind, ref]);

  const hydrated = useMemo(() => {
    const record = ref ? records.get(`${kind}:${ref}`) : null;
    return record ? mergeRecord(preview, record) : preview;
  }, [preview, kind, ref, records]);

  return [hydrated, setPreview];
}

function fetchRecord(kind, ref) {
  if (kind === 'video') return getVideoHistoryItem(ref, { silent: true });
  return getGalleryImages([ref], { silent: true })
    .then((list) => (Array.isArray(list) ? list : []).find((i) => i?.filename === ref) || null);
}

function mergeRecord(item, record) {
  const normalize = item.kind === 'video' ? normalizeVideo : normalizeImage;
  // `prompt` is the whole point, and it is the one fallback that has to happen
  // BEFORE normalize — which would otherwise substitute its own '(no prompt)'
  // for a record that carries none, burying the host's label under it.
  const merged = normalize({ ...record, prompt: record.prompt || item.prompt });
  return {
    ...merged,
    key: item.key,
    negativePrompt: merged.negativePrompt || item.negativePrompt || null,
    // A host may point at a file the normalizer can't address from the record
    // alone — a video-history entry with no thumbnail still has the host's
    // job-scoped poster.
    previewUrl: merged.previewUrl || item.previewUrl || null,
    downloadUrl: merged.downloadUrl || item.downloadUrl || null,
  };
}
