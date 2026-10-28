import { useState } from 'react';
import { Pencil } from 'lucide-react';
import toast from '../ui/Toast';
import { generateImage, previewImagePrompt } from '../../services/api';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import ModelInputPreview from './ModelInputPreview';
import { IMAGE_GEN_MODE } from '../../lib/imageGenBackends';

/**
 * One-step "change this about the image" action: sends the image as the
 * reference plus a short instruction through the default image render, no
 * prompt rewriting or form detour. The wrapper text is shown beside the input.
 */
export default function QuickImageEdit({ item, onDone, generateParams }) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const request = {
    ...(item.width && item.height ? { width: item.width, height: item.height } : {}),
    ...(generateParams || {}),
    prompt: instruction,
    quickEdit: true,
    referenceImageFiles: [item.filename],
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
      {preview?.reviewedReferenceImage && <img src={preview.reviewedReferenceImage} alt="Reference for this edit" className="max-h-32 max-w-full object-contain" />}
      <ModelInputPreview preview={modelInputPreview} prompt={instruction} />
      <p className="text-[10px] leading-snug text-gray-500">
        Sends this image as the reference with your instruction to the default image render, keeping everything else. Creates a new image; the original is kept.
      </p>
    </form>
  );
}
