/**
 * Vision-to-prose modal for a canon entry (character / place / object).
 *
 * Upload one or more reference images, pick an (API/vision-capable) provider +
 * model on demand, and have the vision model turn the image(s) into an
 * image-gen-ready prose description. A single image describes that subject;
 * multiple images return the description COMMON to all of them (the same
 * character from several angles, a location across lighting conditions, …).
 *
 * The modal is stateless w.r.t. the universe — it returns the generated prose
 * via `onApply(description)` and lets the parent write it into the right entry
 * field.
 */

import { useState, useCallback, useRef } from 'react';
import { Loader2, ImagePlus, Sparkles, X } from 'lucide-react';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { processScreenshotUploads } from '../../utils/fileUpload';
import { describeEntityFromImages } from '../../services/apiUniverseBuilder';

// Vision is an API-provider-only capability (the runner only base64-inlines
// images on the API path) — so the picker only offers enabled API providers.
const apiProviderFilter = (p) => p.enabled !== false && p.type === 'api';

// Mirror server VISION_MAX_IMAGES so the UI stops the user before the request
// 400s.
const MAX_IMAGES = 8;

const KIND_NOUN = { character: 'character', place: 'place', object: 'object' };

export default function VisionDescribeModal({ open, kind, entryName, onApply, onClose }) {
  // Each: { filename, preview }. `filename` is the server-stored screenshot
  // name we send to the describe endpoint; `preview` is the data URL for the
  // thumbnail.
  const [images, setImages] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState('');
  // Optional "known context" the user can type to disambiguate the subject
  // (e.g. a name the images don't make obvious) — passed straight to the
  // vision prompt.
  const [context, setContext] = useState('');
  const fileInputRef = useRef(null);

  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading,
  } = useProviderModels({ filter: apiProviderFilter, silent: true });

  const noun = KIND_NOUN[kind] || 'subject';

  const handleFiles = useCallback(async (fileList) => {
    // Respect the cap across the already-selected set. Slice BEFORE uploading
    // so over-cap files never hit the screenshots dir as orphans.
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      toast.error(`Up to ${MAX_IMAGES} images at a time`);
      return;
    }
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    if (files.length > room) toast.error(`Only adding ${room} — max ${MAX_IMAGES} images`);
    setUploading(true);
    // processScreenshotUploads handles the image-type filter, size check, and
    // sequential upload; onSuccess appends each result (guarded by the cap).
    await processScreenshotUploads(files.slice(0, room), {
      onSuccess: (info) => setImages((prev) => (prev.length >= MAX_IMAGES
        ? prev
        : [...prev, { filename: info.filename, preview: info.preview }])),
      onError: (msg) => toast.error(msg),
    });
    setUploading(false);
  }, [images.length]);

  const removeImage = useCallback((filename) => {
    setImages((prev) => prev.filter((img) => img.filename !== filename));
  }, []);

  const [runDescribe, describing] = useAsyncAction(async () => {
    const res = await describeEntityFromImages({
      kind,
      name: entryName || undefined,
      context: context.trim() || undefined,
      screenshots: images.map((img) => img.filename),
      providerId: selectedProviderId || undefined,
      model: selectedModel || undefined,
    }, { silent: true });
    if (res?.description) setResult(res.description);
    return res;
  }, { errorMessage: 'Failed to describe image(s)' });

  const apply = () => {
    onApply(result.trim());
    toast.success(`Applied description to ${entryName || `this ${noun}`}`);
    onClose();
  };

  const canDescribe = images.length > 0 && !describing && !uploading;
  const multi = images.length > 1;

  return (
    <Modal open={open} onClose={onClose} size="lg" closeOnBackdrop={false} ariaLabel={`Describe ${noun} from images`}>
      <div className="bg-port-card border border-port-border rounded-lg shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles size={14} className="text-port-accent" />
            Describe {entryName ? `"${entryName}"` : `this ${noun}`} from image{multi ? 's' : ''}
          </h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <p className="text-xs text-gray-500">
            Upload one image to describe this {noun}, or several of the same {noun} to get the
            description common to all of them. A vision model turns them into image-gen-ready prose.
          </p>

          {/* Image picker + thumbnails */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
            />
            <div className="flex flex-wrap gap-2">
              {images.map((img) => (
                <div key={img.filename} className="relative w-20 h-20">
                  <img
                    src={img.preview || `/api/screenshots/${encodeURIComponent(img.filename)}`}
                    alt="reference"
                    className="w-full h-full object-cover rounded border border-port-border"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(img.filename)}
                    title="Remove image"
                    aria-label="Remove image"
                    className="absolute -top-1.5 -right-1.5 bg-port-bg border border-port-border rounded-full p-0.5 text-gray-400 hover:text-port-error"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              {images.length < MAX_IMAGES ? (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded border border-dashed border-port-border text-gray-500 hover:text-port-accent hover:border-port-accent/50 disabled:opacity-50"
                >
                  {uploading ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
                  <span className="text-[10px]">{images.length ? 'Add' : 'Upload'}</span>
                </button>
              ) : null}
            </div>
          </div>

          {/* Provider + model picker (API/vision-capable providers only) */}
          {providers.length > 0 ? (
            <ProviderModelSelector
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedModel={selectedModel}
              availableModels={availableModels}
              onProviderChange={setSelectedProviderId}
              onModelChange={setSelectedModel}
              label="Vision provider"
              layout="row"
            />
          ) : (
            <p className="text-xs text-port-warning">
              {providersLoading
                ? 'Loading providers…'
                : 'No API provider configured. Add one with a vision-capable model under Settings → Providers to describe images.'}
            </p>
          )}

          {/* Optional context to disambiguate the subject for the model. */}
          <div>
            <label htmlFor="vision-describe-context" className="block text-xs text-gray-500 mb-1">
              Known context (optional)
            </label>
            <input
              id="vision-describe-context"
              type="text"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={`Anything the images don't make obvious about this ${noun}`}
              maxLength={2000}
              className="w-full px-2 py-1.5 text-xs bg-port-bg border border-port-border rounded text-gray-200"
            />
          </div>

          <button
            type="button"
            onClick={runDescribe}
            disabled={!canDescribe || providers.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
          >
            {describing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            {describing ? 'Describing…' : `Describe from image${multi ? 's' : ''}`}
          </button>

          {/* Result — editable before applying */}
          {result ? (
            <div className="space-y-2">
              <label htmlFor="vision-describe-result" className="block text-xs text-gray-500">
                Generated description (edit before applying if you like)
              </label>
              <textarea
                id="vision-describe-result"
                value={result}
                onChange={(e) => setResult(e.target.value)}
                rows={6}
                className="w-full px-2 py-1.5 text-xs bg-port-bg border border-port-border rounded text-gray-200 whitespace-pre-wrap"
              />
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-port-border">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border border-port-border text-gray-300 text-sm hover:text-white">
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={!result.trim()}
            className="px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
          >
            Apply to {noun}
          </button>
        </div>
      </div>
    </Modal>
  );
}
