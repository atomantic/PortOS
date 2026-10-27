import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import MediaImage from '../MediaImage';
import MediaPreview from '../media/MediaPreview';
import { normalizeImage } from '../media/normalize';
import { imageThumbnailSrc } from '../../lib/imageThumbnailSrc';
import useHydratedPreviewRoute from '../../hooks/useHydratedPreviewRoute';
import useGalleryPreviewResolver from '../../hooks/useGalleryPreviewResolver';
import useMediaPreviewActions from '../../hooks/useMediaPreviewActions';
import { useMediaAnnotations } from '../../hooks/useMediaAnnotations';

const PreviewContext = createContext(null);
const SequenceContext = createContext(null);

const safeBasename = (filename) => !!filename && filename !== '.' && filename !== '..'
  && !/[/\\?#]/.test(filename) && ![...filename].some((char) => char.charCodeAt(0) < 32);

// A catalog image as a standard media-viewer item. Gallery images keep the
// gallery's `image:<filename>` key, so star/note, hydration from the render
// record, film look and the other gallery actions all work. An upload-only
// reference (`/data/image-refs`) has no gallery record: it carries no
// `filename`, which keeps record-bound actions off it.
function catalogImageItem(mount, filename, label = '') {
  if (!['images', 'image-refs'].includes(mount) || !safeBasename(filename)) return null;
  const other = mount === 'images' ? 'image-refs' : 'images';
  const src = `/data/${mount}/${encodeURIComponent(filename)}`;
  const fallbackUrl = `/data/${other}/${encodeURIComponent(filename)}`;
  if (mount === 'image-refs') {
    return { kind: 'image', key: `catalog-image:image-refs:${filename}`, previewUrl: src, downloadUrl: src, fallbackUrl, prompt: '(no prompt)', ...(label ? { label } : {}) };
  }
  return { ...normalizeImage({ filename }), previewUrl: src, downloadUrl: src, fallbackUrl, ...(label ? { label } : {}) };
}

function imageFromSrc(src, label) {
  const match = /^\/data\/(images|image-refs)\/([^/?#]+)$/.exec(src || '');
  if (!match) return null;
  try {
    return catalogImageItem(match[1], decodeURIComponent(match[2]), label);
  } catch {
    return null;
  }
}

// A single route host serves every tile, including a direct link to a related
// render outside the loaded page, and opens it in the standard media viewer.
// The resolver accepts only a local image basename — never another static
// mount, an external URL, or a path traversal — and still opens the
// `catalog-image:<mount>:<file>` links this page wrote before.
// A panel can register an ordered `sequence` ({ keys, render }) via
// useCatalogPreviewSequence: prev/next then steps over `keys` (image
// filenames) and `render(key, { nextKey, prevKey, goTo })` adds the page's own
// controls (rating, guide, primary, remove) to the viewer's side pane.
export function useCatalogPreviewSequence(sequence) {
  const setSequence = useContext(SequenceContext);
  useEffect(() => {
    if (!setSequence) return undefined;
    setSequence(sequence);
    return () => setSequence(null);
  }, [setSequence, sequence]);
}

export function CatalogImagePreviewProvider({ children }) {
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
  const pageActions = index >= 0 ? sequence.render?.(preview.filename, { nextKey, prevKey, goTo }) : null;
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
        {...(preview?.filename ? {
          onRemix: actions.handleRemix,
          onSendToImage: actions.handleSendToImage,
          onSendToVideo: actions.handleSendToVideo,
          onSendTo3d: actions.handleSendTo3d,
        } : {})}
        onFilmLookComplete={actions.handleFilmLookComplete}
      />
    </PreviewContext.Provider>
  );
}

export default function CatalogImagePreview({ src, fallbackSrc, alt, className = '', loading = 'lazy' }) {
  const setPreview = useContext(PreviewContext);
  const item = imageFromSrc(src, alt);
  // Inline tiles load the 512px WebP derivative, not the multi-MB original;
  // the enlarged preview below still opens the original.
  const thumbSrc = imageThumbnailSrc(src);
  const thumbnail = thumbSrc
    ? <MediaImage src={thumbSrc} fallbackSrc={[src, fallbackSrc]} assetSrc={src} alt={alt} className={className} loading={loading} />
    : <MediaImage src={src} fallbackSrc={fallbackSrc} alt={alt} className={className} loading={loading} />;
  if (!item || !setPreview) return thumbnail;
  return (
    <button type="button" onClick={() => setPreview(item)} aria-label={`Enlarge ${alt}`}
      className="block w-full rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-port-accent">
      {thumbnail}
    </button>
  );
}
