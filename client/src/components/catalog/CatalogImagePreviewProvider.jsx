import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import MediaPreview from '../media/MediaPreview';
import useHydratedPreviewRoute from '../../hooks/useHydratedPreviewRoute';
import useGalleryPreviewResolver from '../../hooks/useGalleryPreviewResolver';
import useMediaPreviewActions from '../../hooks/useMediaPreviewActions';
import { useMediaAnnotations } from '../../hooks/useMediaAnnotations';
import { PreviewContext, SequenceContext, catalogImageItem, safeBasename } from './CatalogImagePreview';

// A single route host serves every tile, including a direct link to a related
// render outside the loaded page, and opens it in the standard media viewer.
// The resolver accepts only a local image basename — never another static
// mount, an external URL, or a path traversal — and still opens the
// `catalog-image:<mount>:<file>` links this page wrote before.
// A panel can register an ordered `sequence` ({ keys, render }) via
// useCatalogPreviewSequence: prev/next then steps over `keys` (image
// filenames), `render(key, { nextKey, prevKey, goTo })` adds the page's own
// controls (guide, primary, remove) to the viewer's side pane, and
// `rating(key, nav)` puts the record's reference rating in the viewer's
// standard good/bad slot.
export function useCatalogPreviewSequence(sequence) {
  const setSequence = useContext(SequenceContext);
  useEffect(() => {
    if (!setSequence) return undefined;
    setSequence(sequence);
    return () => setSequence(null);
  }, [setSequence, sequence]);
}

// `onVariantSaved(variant, source)` runs after the viewer saves a derived copy
// (a film look) of the open image, so the page can file it on its record.
export function CatalogImagePreviewProvider({ children, ingredientId, onQuickEditQueued, onVariantSaved }) {
  const [sequence, setSequence] = useState(null);
  const items = useMemo(() => (sequence?.keys || []).map((key) => catalogImageItem('images', key)).filter(Boolean), [sequence]);
  const galleryResolver = useGalleryPreviewResolver();
  const resolveItem = useCallback(async (key) => {
    const legacy = /^catalog-image:(images|image-refs):(.+)$/.exec(key);
    if (legacy) return catalogImageItem(legacy[1], legacy[2]);
    const filename = key.replace(/^image:/, '');
    if (!safeBasename(filename) || filename.includes(':')) return null;
    // A variant picked in the viewer (a cleaned or film-look copy) is a gallery
    // record; any other image on this page still opens without one.
    const record = await galleryResolver(`image:${filename}`).catch(() => null);
    return record?.kind === 'image' ? record : catalogImageItem('images', filename);
  }, [galleryResolver]);
  const [preview, setPreview] = useHydratedPreviewRoute(items, { resolveItem });
  const { annotations, updateAnnotation } = useMediaAnnotations();
  const actions = useMediaPreviewActions();
  const index = sequence && preview?.filename ? sequence.keys.indexOf(preview.filename) : -1;
  const prevKey = index > 0 ? sequence.keys[index - 1] : null;
  const nextKey = index >= 0 && index < sequence.keys.length - 1 ? sequence.keys[index + 1] : null;
  const goTo = (key) => setPreview(key ? catalogImageItem('images', key) : null);
  const nav = { nextKey, prevKey, goTo };
  const pageActions = index >= 0 ? sequence.render?.(preview.filename, nav) : null;
  const ratingControl = index >= 0 ? sequence.rating?.(preview.filename, nav) ?? null : null;
  const activeIngredientId = sequence?.ingredientId || ingredientId;
  const activeOnQuickEditQueued = sequence?.onQuickEditQueued || onQuickEditQueued;
  return (
    <PreviewContext.Provider value={setPreview}>
      <SequenceContext.Provider value={setSequence}>
      {children}
      </SequenceContext.Provider>
      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={index >= 0 ? items : []}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        pageActions={pageActions}
        ratingControl={ratingControl}
        {...(preview?.filename ? {
          onRemix: actions.handleRemix,
          onSendToImage: actions.handleSendToImage,
          onSendToVideo: actions.handleSendToVideo,
          onSendTo3d: actions.handleSendTo3d,
        } : {})}
        onFilmLookComplete={async (variant) => {
          await actions.handleFilmLookComplete(variant);
          if (variant?.filename && preview?.filename) await onVariantSaved?.(variant, preview);
        }}
        quickEditParams={activeIngredientId ? { catalogIngredientId: activeIngredientId, catalogMediaKind: 'reference' } : undefined}
        onQuickEditQueued={activeOnQuickEditQueued}
      />
    </PreviewContext.Provider>
  );
}
