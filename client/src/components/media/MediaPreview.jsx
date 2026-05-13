import { useMemo } from 'react';
import MediaLightbox from './MediaLightbox';
import { getMediaNavProps } from '../../lib/mediaNavigation';

// Thin wrapper around MediaLightbox that owns the consistent wiring every
// page repeated by hand: open/close, prev/next nav, and the annotation
// lookup/patch dance. Page-specific handlers pass through as-is.
//
// MediaLightbox already gates Remix / SendToVideo / Clean on `isVideo` and
// Continue on `!isVideo`, so callers should pass handlers unconditionally
// rather than pre-filtering by `preview.kind`.
//
// Nav props win over handlers (spread order) so a stray `onPrevious`/`onNext`
// in a caller can't accidentally shadow the wrapper's navigation contract.
export default function MediaPreview({
  preview,
  setPreview,
  items,
  annotations,
  updateAnnotation,
  ...handlers
}) {
  const navProps = useMemo(
    () => getMediaNavProps(items, preview, setPreview),
    [items, preview, setPreview]
  );
  return (
    <MediaLightbox
      item={preview}
      onClose={() => setPreview(null)}
      annotation={annotations?.[preview?.key] ?? null}
      onAnnotationChange={preview && updateAnnotation ? (patch) => updateAnnotation(preview.key, patch) : undefined}
      {...handlers}
      {...navProps}
    />
  );
}
