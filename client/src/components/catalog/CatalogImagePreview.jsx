import { createContext, useContext, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import MediaImage from '../MediaImage';
import Modal from '../ui/Modal';
import { imageThumbnailSrc } from '../../lib/imageThumbnailSrc';
import usePreviewRoute from '../../hooks/usePreviewRoute';

const PreviewContext = createContext(null);
const SequenceContext = createContext(null);
const NO_ITEMS = [];

function imageIdentity(mount, filename) {
  if (!['images', 'image-refs'].includes(mount) || !filename || filename === '.' || filename === '..'
    || /[/\\?#]/.test(filename) || [...filename].some((char) => char.charCodeAt(0) < 32)) return null;
  return {
    key: `catalog-image:${mount}:${filename}`,
    filename,
    src: `/data/${mount}/${encodeURIComponent(filename)}`,
    fallbackSrc: `/data/${mount === 'images' ? 'image-refs' : 'images'}/${encodeURIComponent(filename)}`,
  };
}

const resolvePreview = async (key) => {
  const match = /^catalog-image:(images|image-refs):(.+)$/.exec(key);
  return match ? imageIdentity(match[1], match[2]) : null;
};

function imageFromSrc(src) {
  const match = /^\/data\/(images|image-refs)\/([^/?#]+)$/.exec(src || '');
  if (!match) return null;
  try {
    return imageIdentity(match[1], decodeURIComponent(match[2]));
  } catch {
    return null;
  }
}

// A single route host serves every tile, including a direct link to a related
// render outside the loaded page. The resolver never searches the gallery or
// accepts another static mount, an external URL, or a path traversal.
// A panel can register an ordered `sequence` ({ keys, render }) via
// useCatalogPreviewSequence: the modal then shows previous/next controls over
// `keys` (image filenames) and `render(key, { nextKey, prevKey, goTo })`
// supplies extra footer controls such as rating buttons.
export function useCatalogPreviewSequence(sequence) {
  const setSequence = useContext(SequenceContext);
  useEffect(() => {
    if (!setSequence) return undefined;
    setSequence(sequence);
    return () => setSequence(null);
  }, [setSequence, sequence]);
}

export function CatalogImagePreviewProvider({ name, children }) {
  const [preview, setPreview] = usePreviewRoute(NO_ITEMS, { resolveItem: resolvePreview });
  const [sequence, setSequence] = useState(null);
  const index = sequence && preview ? sequence.keys.indexOf(preview.filename) : -1;
  const prevKey = index > 0 ? sequence.keys[index - 1] : null;
  const nextKey = index >= 0 && index < sequence.keys.length - 1 ? sequence.keys[index + 1] : null;
  const goTo = (key) => setPreview(key ? imageIdentity('images', key) : null);
  useEffect(() => {
    if (!preview || index < 0) return undefined;
    const onKey = (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName)) return;
      const key = event.key === 'ArrowLeft' ? prevKey : event.key === 'ArrowRight' ? nextKey : null;
      if (!key) return;
      event.preventDefault();
      setPreview(imageIdentity('images', key));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, index, prevKey, nextKey, setPreview]);
  const alt = preview?.alt || `${name || 'Item'} image ${preview?.filename || ''}`;
  return (
    <PreviewContext.Provider value={setPreview}>
      <SequenceContext.Provider value={setSequence}>
      {children}
      </SequenceContext.Provider>
      {preview && (
        <Modal open onClose={() => setPreview(null)} ariaLabel={alt} size="3xl" usePortal panelClassName="bg-port-card border border-port-border rounded-lg">
          <div className="flex items-center justify-between gap-3 p-3 border-b border-port-border">
            <h2 className="text-sm font-semibold text-white break-words">{alt}</h2>
            <button type="button" onClick={() => setPreview(null)} aria-label="Close image preview"
              className="shrink-0 min-h-11 min-w-11 flex items-center justify-center p-2 rounded text-gray-400 hover:text-white focus-visible:outline-2 focus-visible:outline-port-accent">
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <MediaImage src={preview.src} fallbackSrc={preview.fallbackSrc} alt={alt} className="w-full max-h-[70dvh] object-contain" />
          {index >= 0 && (
            <div className="flex flex-wrap items-center gap-2 p-3 border-t border-port-border">
              <button type="button" disabled={!prevKey} onClick={() => goTo(prevKey)} aria-label="Previous image"
                className="min-h-11 flex items-center gap-1 rounded border border-port-border px-3 text-sm text-gray-300 hover:text-white disabled:opacity-40">
                <ChevronLeft size={16} aria-hidden="true" /> Previous
              </button>
              <span className="text-xs text-gray-400">{index + 1} / {sequence.keys.length}</span>
              <button type="button" disabled={!nextKey} onClick={() => goTo(nextKey)} aria-label="Next image"
                className="min-h-11 flex items-center gap-1 rounded border border-port-border px-3 text-sm text-gray-300 hover:text-white disabled:opacity-40">
                Next <ChevronRight size={16} aria-hidden="true" />
              </button>
              {sequence.render?.(preview.filename, { nextKey, prevKey, goTo })}
            </div>
          )}
        </Modal>
      )}
    </PreviewContext.Provider>
  );
}

export default function CatalogImagePreview({ src, fallbackSrc, alt, className = '', loading = 'lazy' }) {
  const setPreview = useContext(PreviewContext);
  const item = imageFromSrc(src);
  // Inline tiles load the 512px WebP derivative, not the multi-MB original;
  // the enlarged preview below still opens the original.
  const thumbSrc = imageThumbnailSrc(src);
  const thumbnail = thumbSrc
    ? <MediaImage src={thumbSrc} fallbackSrc={[src, fallbackSrc]} assetSrc={src} alt={alt} className={className} loading={loading} />
    : <MediaImage src={src} fallbackSrc={fallbackSrc} alt={alt} className={className} loading={loading} />;
  if (!item || !setPreview) return thumbnail;
  return (
    <button type="button" onClick={() => setPreview({ ...item, alt })} aria-label={`Enlarge ${alt}`}
      className="block w-full rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-port-accent">
      {thumbnail}
    </button>
  );
}
