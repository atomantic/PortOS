/**
 * Vision-to-prose / vision-to-attributes modal for a canon entry.
 *
 * Add reference images — uploaded from disk OR picked from the image gallery —
 * pick an (API/vision-capable) provider + model on demand, and either:
 *   - "Describe" (all kinds): turn the image(s) into an image-gen-ready prose
 *     description that seeds the entry's descriptor field. A single image
 *     describes that subject; multiple images return the description COMMON to
 *     all of them (the same subject from several angles, …).
 *   - "Build character details" (characters only): have a vision model PROPOSE
 *     values for the character's still-blank structured fields (palette, visual
 *     notes, expressions, …). The proposals are shown for review (string fields
 *     editable) and applied via the entry-patch path.
 *
 * The modal is stateless w.r.t. the universe — it returns the generated prose
 * via `onApply(description)` and the reviewed attribute patch via
 * `onApplyFields(patch)`, and lets the parent write them into the entry.
 */

import { useState, useCallback, useRef } from 'react';
import { Loader2, ImagePlus, Images, Sparkles, X } from 'lucide-react';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import ProviderModelSelector from '../ProviderModelSelector';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import useProviderModels from '../../hooks/useProviderModels';
import { visionLocalModelFilter } from '../../utils/providers';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { processScreenshotUploads } from '../../utils/fileUpload';
import { describeEntityFromImages, expandEntityFromImages } from '../../services/apiUniverseBuilder';

// Vision is an API-provider-only capability (the runner only base64-inlines
// images on the API path) — so the picker only offers enabled API providers.
const apiProviderFilter = (p) => p.enabled !== false && p.type === 'api';

// Mirror server VISION_MAX_IMAGES so the UI stops the user before the request
// 400s.
const MAX_IMAGES = 8;

const KIND_NOUN = { character: 'character', place: 'place', object: 'object' };

// camelCase field name → human label for the attribute review list.
const humanizeField = (f) => f
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/^./, (c) => c.toUpperCase());

// Unique key per reference image so a gallery image and an upload sharing a
// name don't collide in the thumbnail list or the remove handler.
const imageKey = (img) => `${img.source}:${img.filename}`;

export default function VisionDescribeModal({
  open, kind, entryName, universeId, entryId, onApply, onApplyFields, onClose,
}) {
  // Each: { source: 'upload'|'gallery', filename, preview }. `filename` is what
  // we send to the server (an uploaded screenshot name or a gallery name);
  // `preview` is the URL for the thumbnail.
  const [images, setImages] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [result, setResult] = useState('');
  // Structured attribute proposals (characters): { fields, updatedFields }.
  const [proposed, setProposed] = useState(null);
  // Per-field include set + edited string values for the review list.
  const [selectedFields, setSelectedFields] = useState(() => new Set());
  const [fieldEdits, setFieldEdits] = useState({});
  // Optional "known context" the user can type to disambiguate the subject.
  const [context, setContext] = useState('');
  const fileInputRef = useRef(null);

  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading: providersLoading,
  } = useProviderModels({ filter: apiProviderFilter, modelFilter: visionLocalModelFilter, silent: true });

  const noun = KIND_NOUN[kind] || 'subject';
  const isCharacter = kind === 'character';

  const addImages = useCallback((next) => {
    setImages((prev) => {
      const seen = new Set(prev.map(imageKey));
      const merged = [...prev];
      for (const img of next) {
        if (merged.length >= MAX_IMAGES) break;
        if (seen.has(imageKey(img))) continue;
        seen.add(imageKey(img));
        merged.push(img);
      }
      return merged;
    });
  }, []);

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
    await processScreenshotUploads(files.slice(0, room), {
      onSuccess: (info) => addImages([{ source: 'upload', filename: info.filename, preview: info.preview }]),
      onError: (msg) => toast.error(msg),
    });
    setUploading(false);
  }, [images.length, addImages]);

  const handleGalleryPick = useCallback((item) => {
    if (!item?.filename) return;
    if (images.length >= MAX_IMAGES) {
      toast.error(`Up to ${MAX_IMAGES} images at a time`);
      return;
    }
    addImages([{ source: 'gallery', filename: item.filename, preview: item.previewUrl }]);
  }, [images.length, addImages]);

  const removeImage = useCallback((key) => {
    setImages((prev) => prev.filter((img) => imageKey(img) !== key));
  }, []);

  // Payload shared by both vision calls.
  const imagePayload = () => ({
    images: images.map((img) => ({ source: img.source, filename: img.filename })),
    providerId: selectedProviderId || undefined,
    model: selectedModel || undefined,
  });

  const [runDescribe, describing] = useAsyncAction(async () => {
    const res = await describeEntityFromImages({
      kind,
      name: entryName || undefined,
      context: context.trim() || undefined,
      ...imagePayload(),
    }, { silent: true });
    if (res?.description) setResult(res.description);
    return res;
  }, { errorMessage: 'Failed to describe image(s)' });

  const [runBuildAttributes, building] = useAsyncAction(async () => {
    const res = await expandEntityFromImages(universeId, entryId, {
      name: entryName || undefined,
      context: context.trim() || undefined,
      ...imagePayload(),
    }, { silent: true });
    // Keep any prose description that's already shown — both the description and
    // the structured proposals stay open so the user can apply each in turn.
    if (res?.locked) {
      toast.error(`${entryName || 'This character'} is locked — unlock it to fill from an image`);
      return res;
    }
    const fields = res?.fields && typeof res.fields === 'object' ? res.fields : {};
    const updated = Array.isArray(res?.updatedFields) ? res.updatedFields : [];
    setProposed({ fields, updatedFields: updated });
    setSelectedFields(new Set(updated));
    // Seed editable string values; list fields apply their proposed value as-is.
    const edits = {};
    for (const f of updated) if (typeof fields[f] === 'string') edits[f] = fields[f];
    setFieldEdits(edits);
    if (updated.length === 0) toast(`No new details to fill for ${entryName || `this ${noun}`}`);
    return res;
  }, { errorMessage: 'Failed to build details from image(s)' });

  // Whether the structured-attributes panel still has unsaved proposals.
  const hasPendingAttributes = !!proposed && proposed.updatedFields.length > 0;

  const applyDescription = () => {
    onApply(result.trim());
    toast.success(`Applied description to ${entryName || `this ${noun}`}`);
    // Clear just the description (it's saved); keep the modal open if the
    // structured proposals are still unsaved so the user can apply those too.
    setResult('');
    if (!hasPendingAttributes) onClose();
  };

  const toggleField = (f) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  const applyAttributes = () => {
    if (!proposed) return;
    const patch = {};
    for (const f of proposed.updatedFields) {
      if (!selectedFields.has(f)) continue;
      const value = typeof proposed.fields[f] === 'string'
        ? (fieldEdits[f] ?? proposed.fields[f])
        : proposed.fields[f];
      patch[f] = value;
    }
    if (Object.keys(patch).length === 0) {
      toast.error('Select at least one detail to apply');
      return;
    }
    onApplyFields(patch);
    toast.success(`Applied ${Object.keys(patch).length} detail${Object.keys(patch).length > 1 ? 's' : ''} to ${entryName || `this ${noun}`}`);
    // Clear just the proposals (they're saved); keep the modal open if a prose
    // description is still unsaved so the user can apply that too.
    setProposed(null);
    setSelectedFields(new Set());
    setFieldEdits({});
    if (!result.trim()) onClose();
  };

  // A vision model must be explicitly selected — otherwise the request sends
  // `model: undefined` and the server resolves the provider's default, which on
  // a local backend is often a text-only model that silently drops the images.
  // When the selected provider is a local backend with no vision-capable model,
  // `availableModels` is empty and `selectedModel` is '' — block the run and
  // tell the user why.
  const noVisionModel = providers.length > 0 && !selectedModel;
  const canRun = images.length > 0 && !describing && !building && !uploading
    && providers.length > 0 && !!selectedModel;
  const multi = images.length > 1;

  return (
    <Modal open={open} onClose={onClose} size="lg" closeOnBackdrop={false} usePortal ariaLabel={`Describe ${noun} from images`}>
      <div className="bg-port-card border border-port-border rounded-lg shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles size={14} className="text-port-accent" />
            {entryName ? `"${entryName}"` : `This ${noun}`} from image{multi ? 's' : ''}
          </h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-white" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <p className="text-xs text-gray-500">
            Add one image, or several of the same {noun}, from your device or your gallery.
            {isCharacter
              ? ' Describe them into the descriptor field, or build their structured details (palette, visual notes, expressions, …) from the reference.'
              : ' A vision model turns them into image-gen-ready prose.'}
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
                <div key={imageKey(img)} className="relative w-20 h-20">
                  <img
                    src={img.preview || (img.source === 'upload' ? `/api/screenshots/${encodeURIComponent(img.filename)}` : `/data/images/${encodeURIComponent(img.filename)}`)}
                    alt="reference"
                    className="w-full h-full object-cover rounded border border-port-border"
                  />
                  <button
                    type="button"
                    onClick={() => removeImage(imageKey(img))}
                    title="Remove image"
                    aria-label="Remove image"
                    className="absolute -top-1.5 -right-1.5 bg-port-bg border border-port-border rounded-full p-0.5 text-gray-400 hover:text-port-error"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              {images.length < MAX_IMAGES ? (
                <>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded border border-dashed border-port-border text-gray-500 hover:text-port-accent hover:border-port-accent/50 disabled:opacity-50"
                  >
                    {uploading ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
                    <span className="text-[10px]">Upload</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setGalleryOpen(true)}
                    className="w-20 h-20 flex flex-col items-center justify-center gap-1 rounded border border-dashed border-port-border text-gray-500 hover:text-port-accent hover:border-port-accent/50"
                  >
                    <Images size={16} />
                    <span className="text-[10px]">Gallery</span>
                  </button>
                </>
              ) : null}
            </div>
          </div>

          {/* Provider + model picker (API/vision-capable providers only) */}
          {providers.length > 0 ? (
            <>
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
              {noVisionModel ? (
                <p className="text-xs text-port-warning">
                  This provider has no vision-capable model installed. Pick another provider, or install a
                  vision model (e.g. a qwen-vl or llava model) to analyze images.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-port-warning">
              {providersLoading
                ? 'Loading providers…'
                : 'No API provider configured. Add one with a vision-capable model under Settings → Providers to analyze images.'}
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

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={runDescribe}
              disabled={!canRun}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
            >
              {describing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {describing ? 'Describing…' : `Describe from image${multi ? 's' : ''}`}
            </button>
            {isCharacter ? (
              <button
                type="button"
                onClick={runBuildAttributes}
                disabled={!canRun}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-port-accent text-port-accent text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/10"
              >
                {building ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {building ? 'Analyzing…' : 'Build character details'}
              </button>
            ) : null}
          </div>

          {/* Prose result — editable before applying */}
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
              <button
                type="button"
                onClick={applyDescription}
                disabled={!result.trim()}
                className="px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
              >
                Apply description
              </button>
            </div>
          ) : null}

          {/* Structured attribute review — characters only */}
          {proposed && proposed.updatedFields.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">
                Proposed details (only blank fields). Uncheck any you don't want; edit text inline. Existing values are never overwritten.
              </p>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {proposed.updatedFields.map((f) => {
                  const value = proposed.fields[f];
                  const isList = Array.isArray(value);
                  const checked = selectedFields.has(f);
                  return (
                    <div key={f} className="border border-port-border rounded p-2 bg-port-bg">
                      <label className="flex items-center gap-2 text-xs text-gray-300 mb-1">
                        <input type="checkbox" checked={checked} onChange={() => toggleField(f)} />
                        <span className="font-medium">{humanizeField(f)}</span>
                        {isList ? <span className="text-gray-500">({value.length} item{value.length > 1 ? 's' : ''})</span> : null}
                      </label>
                      {isList ? (
                        <p className="text-[11px] text-gray-400 pl-6">
                          {value.map((row) => row?.name || row?.label).filter(Boolean).join(', ') || '—'}
                        </p>
                      ) : (
                        <textarea
                          value={fieldEdits[f] ?? ''}
                          onChange={(e) => setFieldEdits((prev) => ({ ...prev, [f]: e.target.value }))}
                          disabled={!checked}
                          rows={2}
                          aria-label={humanizeField(f)}
                          className="w-full px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-200 disabled:opacity-50"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={applyAttributes}
                disabled={selectedFields.size === 0}
                className="px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
              >
                Apply {selectedFields.size} detail{selectedFields.size > 1 ? 's' : ''}
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-port-border">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded border border-port-border text-gray-300 text-sm hover:text-white">
            Close
          </button>
        </div>
      </div>

      <GalleryImagePicker
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onSelect={handleGalleryPick}
      />
    </Modal>
  );
}
