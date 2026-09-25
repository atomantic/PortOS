import { useEffect, useMemo, useRef, useState } from 'react';
import usePreviewRoute from './usePreviewRoute';
import { fetchMediaRecord, mediaRecordRef, mergeMediaRecord } from '../components/media/mediaDetail';

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
 * One item is the wrong unit for anything set-level, so the variant toggle is
 * no longer built from this at all: `MediaPreview` asks the server for the
 * open image's lineage (`useImageVariants`), which answers both directions from
 * either end. Substituting the hydrated preview into the scanned list remains
 * the fallback while that lookup is in flight or after it fails (#7346).
 *
 * The record wins on every field it carries; the host's item is the fallback,
 * and its `key` is kept outright — prev/next nav (`getAdjacentMedia`) and the
 * annotation lookup both match on it, so a key that drifted from the list would
 * silently disable both.
 *
 * A compact list item (`item.compact`, #8292) carries only a prompt preview,
 * so for it a failed or empty lookup is not a quiet miss: the returned preview
 * stays `compact` and gains `detailError: true`, and closing then reopening it
 * retries. The lightbox withholds prompt editing while an item is compact.
 *
 * Same `[preview, setPreview]` shape as `usePreviewRoute`; `options` passes
 * straight through (`paramName`, `resolveItem`).
 */
export default function useHydratedPreviewRoute(items, options) {
  const [preview, setPreview] = usePreviewRoute(items, options);
  // An item with no filename/id (a synthetic entry backed by no gallery
  // record) has nothing to hydrate from and passes through untouched.
  const kind = preview?.kind;
  const ref = mediaRecordRef(preview);
  const compact = !!preview?.compact;
  // Cache the fetched records, not the merged items: the host's item identity
  // can change between opens (a re-render rebuilding the list) while the record
  // for a given filename/id does not.
  const [records, setRecords] = useState(() => new Map());
  // Compact items whose lookup failed or found nothing — cleared on retry.
  const [failed, setFailed] = useState(() => new Set());
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
    setFailed((prev) => (prev.has(lookupKey) ? withoutKey(prev, lookupKey) : prev));
    const settle = (record) => {
      if (cancelled) return;
      if (record) {
        attemptedRef.current.add(lookupKey);
        setRecords((prev) => new Map(prev).set(lookupKey, record));
      } else if (compact) {
        // Left unattempted so a reopen asks again.
        setFailed((prev) => new Set(prev).add(lookupKey));
      } else {
        // A full host item settles a failed lookup as a miss: non-fatal, and
        // the host's own label stands in for it.
        attemptedRef.current.add(lookupKey);
      }
    };
    fetchMediaRecord(kind, ref).then(settle, () => settle(null));
    return () => { cancelled = true; };
  }, [kind, ref, compact]);

  const hydrated = useMemo(() => {
    const lookupKey = `${kind}:${ref}`;
    const record = ref ? records.get(lookupKey) : null;
    if (record) return mergeMediaRecord(preview, record);
    return preview?.compact && failed.has(lookupKey) ? { ...preview, detailError: true } : preview;
  }, [preview, kind, ref, records, failed]);

  return [hydrated, setPreview];
}

function withoutKey(set, key) {
  const next = new Set(set);
  next.delete(key);
  return next;
}
