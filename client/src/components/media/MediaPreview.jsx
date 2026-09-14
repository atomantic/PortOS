import { useMemo, useCallback, useEffect, useState } from 'react';
import MediaLightbox from './MediaLightbox';
import { getMediaNavProps } from '../../lib/mediaNavigation';
import { computeImageVariantGroup } from './variants';
import useImageVariants from '../../hooks/useImageVariants';
import { updateImagePrompt, updateVideoPrompt } from '../../services/apiImageVideo';

// Thin wrapper around MediaLightbox that owns the consistent wiring every
// page repeated by hand: open/close, prev/next nav, and the annotation
// lookup/patch dance. Page-specific handlers pass through as-is.
//
// MediaLightbox already gates SendToVideo / Clean on `!isVideo` and
// Continue on `isVideo`. Remix works for both kinds — callers should
// dispatch by `item.kind` inside their handler (see useMediaPreviewActions).
//
// Nav props win over handlers (spread order) so a stray `onPrevious`/`onNext`
// in a caller can't accidentally shadow the wrapper's navigation contract.
export default function MediaPreview({
  preview,
  setPreview,
  items,
  annotations,
  updateAnnotation,
  onPromptSaved,
  ...handlers
}) {
  const [promptOverride, setPromptOverride] = useState(null);
  const navProps = useMemo(
    () => getMediaNavProps(items, preview, setPreview),
    [items, preview, setPreview]
  );
  // `preview` is resolved from the URL and the host's item list. Keep a
  // successful prompt edit visible immediately even for a host that does not
  // own a mutable gallery list (the host callback still updates cards when it
  // has one). This is keyed to the media identity, never to the selection
  // itself, so the URL remains the source of truth for which item is open.
  useEffect(() => {
    setPromptOverride((current) => current?.key === preview?.key ? current : null);
  }, [preview?.key]);
  const displayedPreview = useMemo(() => {
    if (!preview || promptOverride?.key !== preview.key) return preview;
    const prompt = promptOverride.prompt;
    return {
      ...preview,
      prompt,
      raw: preview.raw ? { ...preview.raw, prompt: prompt === '(no prompt)' ? '' : prompt } : preview.raw,
    };
  }, [preview, promptOverride]);
  // Original-vs-cleaned toggle, computed over the UNION of the host's items
  // and the image's fetched lineage — neither source alone is complete. The
  // host list misses a copy it never held (see useImageVariants), while the
  // fetched set misses one the user just made, because a Clean splices the new
  // variant into the host's state (useMediaPreviewActions' onCleanComplete)
  // after the server set was read. Returns null for a non-image preview or a
  // lone variant.
  //
  // `preview` is substituted for its own entry in the host list first, which
  // is what the list scan needs while the lookup is in flight or after it
  // failed: a host that hydrates the OPEN item only (`useHydratedPreviewRoute`)
  // learns `cleanedFrom` for the preview and not for the row it came from, and
  // the scan reads `cleanedFrom` off the LIST.
  const fetchedVariants = useImageVariants(preview);
  const variantCandidates = useMemo(() => {
    let list = Array.isArray(items) ? items : [];
    if (preview) {
      const index = list.findIndex((i) => i?.key === preview.key);
      if (index !== -1 && list[index] !== preview) {
        list = list.slice();
        list[index] = preview;
      }
    }
    // A union with an empty set is the list itself — the short-circuit is an
    // optimization, not a read of `[]` as "not fetched".
    if (!fetchedVariants?.length) return list;
    const hostByFilename = new Map(list
      .filter((item) => item?.kind === 'image' && item.filename)
      .map((item) => [item.filename, item]));
    // The fetched record wins on LINEAGE — that is the whole point, since the
    // host's own row is exactly what may not carry `cleanedFrom`. But the
    // host's `key` wins outright wherever it lists the same file: picking a
    // variant writes that key to the URL, and prev/next nav (getAdjacentMedia)
    // and the annotation lookup both match on it, so a key that drifted from
    // the list would silently disable both (same contract useHydratedPreviewRoute
    // keeps when it merges a record over a host item).
    const byFilename = new Map(fetchedVariants.map((variant) => {
      const hosted = hostByFilename.get(variant.filename);
      return [variant.filename, hosted ? { ...variant, key: hosted.key } : variant];
    }));
    for (const [filename, item] of hostByFilename) {
      if (!byFilename.has(filename)) byFilename.set(filename, item);
    }
    return [...byFilename.values()];
  }, [fetchedVariants, items, preview]);
  const variantGroup = useMemo(
    () => computeImageVariantGroup(preview, variantCandidates),
    [preview, variantCandidates]
  );
  const onSelectVariant = useCallback((nextItem) => {
    if (!nextItem) return;
    setPreview(nextItem);
  }, [setPreview]);
  const savePrompt = useCallback(async (item, prompt) => {
    const result = item.kind === 'image'
      ? await updateImagePrompt(item.filename, prompt, { silent: true })
      : await updateVideoPrompt(item.id, prompt, { silent: true });
    const nextPrompt = result?.prompt || '(no prompt)';
    setPromptOverride({ key: item.key, prompt: nextPrompt });
    onPromptSaved?.(item, nextPrompt);
    return result;
  }, [onPromptSaved]);
  return (
    <MediaLightbox
      item={displayedPreview}
      onClose={() => setPreview(null)}
      annotation={annotations?.[preview?.key] ?? null}
      onAnnotationChange={preview && updateAnnotation ? (patch) => updateAnnotation(preview.key, patch) : undefined}
      onPromptChange={savePrompt}
      variantGroup={variantGroup}
      onSelectVariant={onSelectVariant}
      {...handlers}
      {...navProps}
    />
  );
}
