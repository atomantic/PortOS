import MediaImage from '../MediaImage';
import { imageThumbnailSrc } from '../../lib/imageThumbnailSrc';

export default function ModelReferenceImages({ images }) {
  if (!Array.isArray(images)) return null;
  return (
    <section aria-label="Canonical reference images" className="space-y-2">
      <h3 className="text-xs font-semibold text-gray-300">Canonical reference images</h3>
      <p className="text-xs text-gray-500">Render guides take priority; otherwise the portrait and canon images supply likeness.</p>
      {images.length === 0 ? (
        <p className="text-xs text-port-warning">No canonical reference images will be sent. This sheet will be generated from text only.</p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {images.map((image, index) => (
            <figure key={`${image.filename}:${index}`} className="min-w-0 rounded border border-port-border bg-port-bg p-2 space-y-1">
              {image.url && (
                <a href={image.url} target="_blank" rel="noreferrer" aria-label={`Open canonical reference ${index + 1}: ${image.filename}`}>
                  <MediaImage src={imageThumbnailSrc(image.url) || image.url} fallbackSrc={image.url}
                    alt={`Canonical reference ${index + 1}`} className="w-full h-28 object-contain rounded" />
                </a>
              )}
              <figcaption className="text-[11px] break-words">
                <span className="block text-gray-300">{image.filename}</span>
                <span className="block text-gray-500">{image.source}</span>
                <span className={image.status === 'included' ? 'text-port-success' : 'text-port-warning'}>
                  {image.status === 'included' ? 'Will be sent to the model'
                    : image.status === 'missing' ? 'Missing file — restore or update this reference'
                      : image.status === 'unsupported' ? 'Not sent — choose FLUX.2, Qwen Image 2.1 or a cloud image backend'
                      : 'Not sent — reference image limit reached'}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
