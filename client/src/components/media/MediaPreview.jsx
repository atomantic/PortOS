import { useMemo, useCallback, useEffect, useState } from 'react';
import MediaLightbox from './MediaLightbox';
import { getMediaNavProps } from '../../lib/mediaNavigation';
import { computeImageVariantGroup } from './variants';
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
  // Original-vs-cleaned toggle. Computed from the same `items` list that
  // drives prev/next nav — so if the cleaned copy was auto-filed into this
  // page's source collection, both variants are present and the toggle
  // appears. Returns null for non-image previews or single-variant items.
  const variantGroup = useMemo(
    () => computeImageVariantGroup(preview, items),
    [preview, items]
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
