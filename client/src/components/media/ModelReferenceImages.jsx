import CatalogImagePreview from '../catalog/CatalogImagePreview';

// `editBase` (from the server preview) is the image the render edits (also
// listed in `images` with role 'edit-base'), a fallback with the reason a
// backend cannot edit it, or `none` when an age or look has no image of its
// own and the render generates fresh instead of editing the canonical portrait.
// `onToggleLikeness(image, include)` lets the record's own images (those with a
// `mediaKind`) be left out of or put back into the likeness guides.
export default function ModelReferenceImages({ images, editBase, onOpenPreview, onToggleLikeness }) {
  if (!Array.isArray(images)) return null;
  const editing = images.some((image) => image.role === 'edit-base');
  const sentCount = images.filter((image) => image.status !== 'left-out').length;
  return (
    <section aria-label="Reference images sent" className="space-y-2">
      <h3 className="text-xs font-semibold text-gray-300">Reference images sent</h3>
      <p className="text-xs text-gray-500">
        {editing
          ? `The render edits the ${editBase?.scope === 'form' ? 'first image' : 'portrait'}; the other images guide likeness.`
          : 'Render guides take priority; otherwise the portrait and canon images supply likeness.'}
      </p>
      {editBase?.status === 'none' && <p role="status" className="text-xs text-gray-400">{editBase.reason}</p>}
      {editBase?.status === 'fallback' && (
        <p role="status" className="text-xs text-port-warning">Not editing from the portrait: {editBase.reason}</p>
      )}
      {sentCount === 0 && (
        <p className="text-xs text-port-warning">No canonical reference images will be sent. This sheet will be generated from text only.</p>
      )}
      {images.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {images.map((image, index) => (
            <figure key={`${image.filename}:${index}`} className={`min-w-0 rounded border border-port-border bg-port-bg p-2 space-y-1 ${image.status === 'left-out' ? 'opacity-60' : ''}`}>
              {image.url && (
                onOpenPreview ? (
                  <button
                    type="button"
                    onClick={() => onOpenPreview(image.url, image)}
                    aria-label={`Open canonical reference ${index + 1}: ${image.filename}`}
                    className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 block w-full rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-port-accent"
                  >
                    <CatalogImagePreview
                      src={image.url}
                      alt={`Canonical reference ${index + 1}`}
                      className="w-full h-28 object-contain rounded"
                    />
                  </button>
                ) : (
                  <CatalogImagePreview
                    src={image.url}
                    alt={`Canonical reference ${index + 1}`}
                    className="w-full h-28 object-contain rounded"
                  />
                )
              )}
              <figcaption className="text-[11px] break-words">
                <span className="block text-gray-300">{image.filename}</span>
                <span className="block text-gray-500">{image.source}</span>
                {image.role === 'edit-base' && <span className="block font-medium text-port-accent">Edit base — the render starts from this image</span>}
                {typeof image.strength === 'number' && <span className="block text-gray-500">Strength {image.strength}</span>}
                <span className={image.status === 'included' ? 'text-port-success' : image.status === 'left-out' ? 'text-gray-500' : 'text-port-warning'}>
                  {image.status === 'included' ? 'Will be sent to the model'
                    : image.status === 'left-out' ? 'Left out of likeness guides'
                    : image.status === 'missing' ? 'Missing file — restore or update this reference'
                      : image.status === 'unsupported' ? 'Not sent — choose FLUX.2, Qwen Image 2.1 or a cloud image backend'
                      : 'Not sent — reference image limit reached'}
                </span>
                {onToggleLikeness && image.mediaKind && !image.relative && (
                  <button
                    type="button"
                    onClick={() => onToggleLikeness(image, image.status === 'left-out')}
                    aria-label={`${image.status === 'left-out' ? 'Use for likeness' : 'Leave out'}: ${image.filename}`}
                    className="mt-1 flex min-h-11 w-full items-center justify-center rounded border border-port-border px-2 text-xs text-gray-300 hover:border-port-accent"
                  >
                    {image.status === 'left-out' ? 'Use for likeness' : 'Leave out'}
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
