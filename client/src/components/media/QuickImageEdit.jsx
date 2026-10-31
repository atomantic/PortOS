import { useState } from 'react';
import { Images, Pencil, Plus, X } from 'lucide-react';
import toast from '../ui/Toast';
import { generateImage, previewImagePrompt } from '../../services/api';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { formatCount } from '../../utils/formatters';
import ModelInputPreview from './ModelInputPreview';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';

// Extra pictures to draw from (a place, a prop, a face) beside the edited image.
export const QUICK_EDIT_MAX_REFERENCES = 3;
const thumbUrl = (filename) => `/data/images/${encodeURIComponent(filename)}`;

/**
 * One-step "change this about the image" action: sends the image as the
 * reference plus a short instruction through the default image render, no
 * prompt rewriting or form detour. The wrapper text is shown beside the input.
 * Further gallery images can ride along as visual references; `referenceChoices`
 * are the viewer's other items (e.g. the record's references), offered first.
 */
export default function QuickImageEdit({ item, onDone, generateParams, referenceChoices = [] }) {
  const [instruction, setInstruction] = useState('');
  const [references, setReferences] = useState([]);
  const [choosing, setChoosing] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const atMax = references.length >= QUICK_EDIT_MAX_REFERENCES;
  const pageChoices = [...new Set(referenceChoices
    .filter((choice) => choice?.kind === 'image' && choice.filename && choice.filename !== item.filename)
    .map((choice) => choice.filename))];
  const addReference = (filename) => {
    if (!filename || filename === item.filename) return;
    setReferences((prev) => (prev.includes(filename) || prev.length >= QUICK_EDIT_MAX_REFERENCES ? prev : [...prev, filename]));
  };
  const removeReference = (filename) => setReferences((prev) => prev.filter((f) => f !== filename));
  const [busy, setBusy] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const request = {
    ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
    ...(generateParams || {}),
    prompt: instruction,
    quickEdit: true,
    referenceImageFiles: [item.filename, ...references],
  };
  const modelInputPreview = useModelInputPreview(previewImagePrompt, { ...request, reviewReference: true }, { enabled: Boolean(instruction.trim()), revision: previewRevision });
  const { preview } = modelInputPreview;
  const canSubmit = instruction.trim() && !busy && Boolean(preview?.reviewedPromptDigest && preview?.reviewedReferenceDigest && preview?.reviewedReferenceImage);

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    // silent: this component toasts the failure itself.
    const result = await generateImage({
      ...request,
      reviewedReferenceDigest: preview.reviewedReferenceDigest,
      reviewedPromptDigest: preview.reviewedPromptDigest,
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Edit failed');
      setPreviewRevision(revision => revision + 1);
      return null;
    });
    setBusy(false);
    if (!result) return;
    toast.success(result.mode === IMAGE_GEN_MODE.EXTERNAL ? 'Edit complete' : result.position ? `Edit queued #${result.position}` : 'Edit queued');
    onDone?.(result, { instruction, item });
  };

  return (
    <form onSubmit={submit} className="w-full mt-1 p-2.5 rounded border border-port-border bg-port-bg/60 space-y-2">
      <label htmlFor="quick-edit-instruction" className="block text-[11px] uppercase tracking-wide text-gray-400">What should change?</label>
      <div className="flex gap-2">
        <input
          id="quick-edit-instruction"
          type="text"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          disabled={busy}
          placeholder="e.g. make the jacket red"
          className="flex-1 min-w-0 px-2 py-1 text-xs rounded bg-port-card border border-port-border text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-port-accent"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="min-h-[36px] flex items-center gap-1.5 px-3 text-xs bg-port-accent text-white hover:opacity-90 rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Pencil className="w-3.5 h-3.5" /> {busy ? 'Sending…' : 'Edit'}
        </button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        {preview?.reviewedReferenceImage && <img src={preview.reviewedReferenceImage} alt="Reference for this edit" className="max-h-32 max-w-full object-contain" />}
        {references.map((filename, index) => (
          <div key={filename} className="relative shrink-0">
            <img src={thumbUrl(filename)} alt={`Reference image ${index + 2}`} loading="lazy" className="h-16 w-16 rounded object-cover border border-port-border" />
            <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[10px] text-white">{index + 2}</span>
            <button type="button" onClick={() => removeReference(filename)} disabled={busy}
              aria-label={`Remove reference image ${index + 2}`}
              className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-port-card border border-port-border text-gray-300 hover:text-white flex items-center justify-center">
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        {!atMax && (
          <button type="button" onClick={() => (pageChoices.length ? setChoosing((open) => !open) : setGalleryOpen(true))} disabled={busy}
            aria-expanded={pageChoices.length ? choosing : undefined}
            className="min-h-[44px] inline-flex items-center gap-1 rounded border border-dashed border-port-border px-2 text-xs text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> Add reference
          </button>
        )}
      </div>
      {choosing && !atMax && pageChoices.length > 0 && (
        <div className="space-y-1">
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {pageChoices.map((filename, choiceIndex) => {
              const picked = references.includes(filename);
              return (
                <button key={filename} type="button" aria-pressed={picked} disabled={busy}
                  onClick={() => (picked ? removeReference(filename) : addReference(filename))}
                  aria-label={`Page image ${choiceIndex + 1}`}
                  className={`shrink-0 rounded border-2 ${picked ? 'border-port-accent' : 'border-transparent hover:border-port-border'}`}>
                  <img src={thumbUrl(filename)} alt="" loading="lazy" className="h-14 w-14 rounded object-cover" />
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => setGalleryOpen(true)} disabled={busy}
            className="min-h-[36px] inline-flex items-center gap-1 text-xs text-port-accent hover:text-white">
            <Images className="w-3.5 h-3.5" /> Pick from gallery
          </button>
        </div>
      )}
      <GalleryImagePicker open={galleryOpen} onClose={() => setGalleryOpen(false)} onSelect={(picked) => addReference(picked?.filename)} />
      <p className="text-[10px] text-gray-500">Instruction: {formatCount(instruction.length)} characters{preview?.sentPrompt ? ` · Full prompt: ${formatCount(preview.sentPrompt.length)} characters` : ''}</p>
      <ModelInputPreview preview={modelInputPreview} prompt={instruction} />
      <p className="text-[10px] leading-snug text-gray-500">
        Sends this image as the reference with your instruction to the default image render, keeping everything else.{references.length ? ' Added images go along as visual references; name them by number (image 2, image 3).' : ''} Creates a new image; the original is kept.
      </p>
    </form>
  );
}
