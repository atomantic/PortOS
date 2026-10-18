import { createContext, useContext } from 'react';
import { X } from 'lucide-react';
import MediaImage from '../MediaImage';
import Modal from '../ui/Modal';
import usePreviewRoute from '../../hooks/usePreviewRoute';

const PreviewContext = createContext(null);
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
export function CatalogImagePreviewProvider({ name, children }) {
  const [preview, setPreview] = usePreviewRoute(NO_ITEMS, { resolveItem: resolvePreview });
  const alt = preview?.alt || `${name || 'Item'} image ${preview?.filename || ''}`;
  return (
    <PreviewContext.Provider value={setPreview}>
      {children}
      {preview && (
        <Modal open onClose={() => setPreview(null)} ariaLabel={alt} size="3xl" usePortal panelClassName="bg-port-card border border-port-border rounded-lg">
          <div className="flex items-center justify-between gap-3 p-3 border-b border-port-border">
            <h2 className="text-sm font-semibold text-white break-words">{alt}</h2>
            <button type="button" onClick={() => setPreview(null)} aria-label="Close image preview"
              className="shrink-0 min-h-11 min-w-11 flex items-center justify-center p-2 rounded text-gray-400 hover:text-white focus-visible:outline-2 focus-visible:outline-port-accent">
              <X size={20} aria-hidden="true" />
            </button>
          </div>
          <MediaImage src={preview.src} fallbackSrc={preview.fallbackSrc} alt={alt} className="w-full max-h-[75dvh] object-contain" />
        </Modal>
      )}
    </PreviewContext.Provider>
  );
}

export default function CatalogImagePreview({ src, fallbackSrc, alt, className = '', loading = 'lazy' }) {
  const setPreview = useContext(PreviewContext);
  const item = imageFromSrc(src);
  const thumbnail = <MediaImage src={src} fallbackSrc={fallbackSrc} alt={alt} className={className} loading={loading} />;
  if (!item || !setPreview) return thumbnail;
  return (
    <button type="button" onClick={() => setPreview({ ...item, alt })} aria-label={`Enlarge ${alt}`}
      className="block w-full rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-port-accent">
      {thumbnail}
    </button>
  );
}
