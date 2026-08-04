/**
 * Corrective reference-image modal for ONE canon entry (character/place/object).
 *
 * Pick or upload a single gallery image, run vision analysis against the
 * entry's CURRENT descriptor text (unlike VisionDescribeModal's "Describe",
 * this corrects rather than describing blind), review the proposed
 * replacement, then Apply: the reviewed text overwrites the entry's
 * descriptor field AND the image is pinned as the entry's `primaryImageRef`
 * — assigning it as that noun's style/reference image so subsequent renders
 * seed from it.
 */
import { useState } from 'react';
import { ImagePlus, Loader2, Sparkles, X } from 'lucide-react';
import Modal from '../ui/Modal';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import VisionProviderPicker from './VisionProviderPicker';
import { KIND_NOUN } from './VisionDescribeModal';
import toast from '../ui/Toast';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { correctEntityFromImage, applyCanonImageCorrection } from '../../services/apiUniverseBuilder';

export default function CorrectiveReferenceModal({
  open, kind, entryName, universeId, entryId, onApplied, onClose,
}) {
  const [image, setImage] = useState(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [context, setContext] = useState('');
  const [vision, setVision] = useState({ providerId: '', model: '', hasProviders: false });
  const [analysis, setAnalysis] = useState(null);
  const [proposedText, setProposedText] = useState('');

  const noun = KIND_NOUN[kind] || 'subject';
  const subject = entryName ? `"${entryName}"` : `this ${noun}`;

  const reset = () => {
    setImage(null);
    setContext('');
    setAnalysis(null);
    setProposedText('');
    setVision({ providerId: '', model: '', hasProviders: false });
  };
  const close = () => {
    if (analyzing || applying) return;
    reset();
    onClose?.();
  };

  const [analyze, analyzing] = useAsyncAction(async () => {
    if (!image?.filename || !vision.model) return null;
    const result = await correctEntityFromImage(universeId, kind, entryId, {
      image: image.filename,
      name: entryName || undefined,
      context: context.trim() || undefined,
      providerId: vision.providerId || undefined,
      model: vision.model,
    }, { silent: true });
    if (result.locked) {
      toast.error(`${subject} is locked — unlock it before applying a corrective reference`);
      return null;
    }
    setAnalysis(result);
    setProposedText(result.proposedDescription || '');
    return result;
  }, { errorMessage: 'Correction analysis failed' });

  const [apply, applying] = useAsyncAction(async () => {
    if (!analysis || !proposedText.trim() || !image?.filename) return null;
    const result = await applyCanonImageCorrection(universeId, kind, entryId, {
      description: proposedText.trim(),
      imageFilename: image.filename,
    }, { silent: true });
    toast.success(`Corrected ${subject} and pinned the reference image`);
    onApplied?.(result);
    close();
    return result;
  }, { errorMessage: 'Applying correction failed' });

  return (
    <Modal open={open} onClose={close} size="lg" closeOnBackdrop={!analyzing && !applying} usePortal ariaLabel={`Corrective reference for ${subject}`}>
      <div className="bg-port-card border border-port-border rounded-lg shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-port-border">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Sparkles size={14} className="text-port-accent" />
            Corrective reference for {subject}
          </h3>
          <button type="button" onClick={close} disabled={analyzing || applying} className="text-gray-500 hover:text-white disabled:opacity-50 min-h-[44px] min-w-[44px] flex items-center justify-center" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4 overflow-y-auto">
          <p className="text-xs text-gray-500">
            Upload or pick one image that shows what this {noun} actually looks like. A vision model compares it
            against the current description and proposes a correction; applying it also pins the image as this{' '}
            {noun}&apos;s reference image for future renders.
          </p>

          <div>
            {image ? (
              <button type="button" onClick={() => { setImage(null); setAnalysis(null); }} className="block" title="Choose another image">
                <img
                  src={image.preview || `/data/images/${encodeURIComponent(image.filename)}`}
                  alt="Selected corrective reference"
                  className="h-32 w-32 rounded-lg border border-port-border object-cover"
                />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setGalleryOpen(true)}
                className="flex h-32 w-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-port-border text-xs text-gray-400 hover:border-port-accent hover:text-white"
              >
                <ImagePlus size={24} />
                Upload or choose image
              </button>
            )}
          </div>

          <VisionProviderPicker label="Vision model for correction" onChange={setVision} />

          <div>
            <label htmlFor="corrective-reference-context" className="block text-xs text-gray-500 mb-1">
              Known context (optional)
            </label>
            <input
              id="corrective-reference-context"
              type="text"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={`Anything the image doesn't make obvious about this ${noun}`}
              maxLength={2000}
              className="w-full px-2 py-1.5 text-xs bg-port-bg border border-port-border rounded text-gray-200"
            />
          </div>

          {!analysis ? (
            <button
              type="button"
              onClick={analyze}
              disabled={analyzing || !image?.filename || !vision.model}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
            >
              {analyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {analyzing ? 'Analyzing…' : 'Analyze image'}
            </button>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Current description</div>
                  <p className="rounded border border-port-border p-2 text-xs text-gray-400 whitespace-pre-wrap min-h-[4rem]">
                    {analysis.currentDescription || 'None yet'}
                  </p>
                </div>
                <div>
                  <label htmlFor="corrective-reference-proposed" className="text-[11px] uppercase tracking-wide text-port-accent mb-1 block">
                    Proposed correction (edit before applying if you like)
                  </label>
                  <textarea
                    id="corrective-reference-proposed"
                    value={proposedText}
                    onChange={(e) => setProposedText(e.target.value)}
                    rows={6}
                    maxLength={2000}
                    className="w-full rounded border border-port-accent/30 p-2 text-xs text-gray-200 whitespace-pre-wrap bg-port-bg"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={apply}
                disabled={applying || !proposedText.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:bg-port-accent/90"
              >
                {applying ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {applying ? 'Applying…' : 'Apply correction + set as reference'}
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-port-border">
          <button type="button" onClick={close} disabled={analyzing || applying} className="px-3 py-1.5 rounded border border-port-border text-gray-300 text-sm hover:text-white disabled:opacity-50">
            Close
          </button>
        </div>
      </div>

      <GalleryImagePicker
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        allowUpload
        onSelect={(item) => {
          if (!item?.filename) return;
          setImage({ filename: item.filename, preview: item.previewUrl });
          setAnalysis(null);
        }}
      />
    </Modal>
  );
}
