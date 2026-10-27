import { createContext, useContext } from 'react';
import MediaImage from '../MediaImage';
import { normalizeImage } from '../media/normalize';
import { imageThumbnailSrc } from '../../lib/imageThumbnailSrc';

// The viewer host lives in CatalogImagePreviewProvider.jsx so a plain tile
// (also used outside catalog pages) does not pull in the whole media viewer.
export const PreviewContext = createContext(null);
export const SequenceContext = createContext(null);

export const safeBasename = (filename) => !!filename && filename !== '.' && filename !== '..'
  && !/[/\\?#]/.test(filename) && ![...filename].some((char) => char.charCodeAt(0) < 32);

// A catalog image as a standard media-viewer item. Gallery images keep the
// gallery's `image:<filename>` key, so star/note, hydration from the render
// record, film look and the other gallery actions all work. An upload-only
// reference (`/data/image-refs`) has no gallery record: it carries no
// `filename`, which keeps record-bound actions off it.
export function catalogImageItem(mount, filename, label = '') {
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
