import { useEffect, useState } from 'react';
import { ListPlus, Sparkles, Wand2, X } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels';
import { generateImage, generateVideo, refineMediaPrompt } from '../../services/api';

function getRenderConfig(item) {
  const raw = item?.raw || {};
  if (item?.kind === 'image') {
    return {
      mode: item.mode || 'local',
      modelId: item.modelId,
      width: item.width,
      height: item.height,
      steps: item.steps,
      guidance: item.guidance,
      cfgScale: raw.cfgScale ?? raw.cfg_scale,
      seed: item.seed,
      quantize: item.quantize,
      loraFilenames: raw.loraFilenames,
      loraScales: raw.loraScales,
    };
  }
  return {
    mode: item.mode || 'text',
    modelId: item.modelId,
    width: item.width,
    height: item.height,
    numFrames: item.numFrames,
    fps: item.fps,
    steps: raw.steps,
    // Nullish coalescing — a deliberate `0` guidanceScale is valid for some
    // video models and must survive the round-trip back into the queued payload.
    guidanceScale: raw.guidanceScale ?? raw.guidance,
    seed: raw.seed,
    tiling: raw.tiling,
    disableAudio: raw.disableAudio,
  };
}

// Refine→queue forces text-to-video; the source image/last-frame from the
// original render isn't carried into the modal, so image-to-video can't be
// reproduced from here without re-uploading.
function queuePayload(item, refinement) {
  const base = {
    ...getRenderConfig(item),
    prompt: refinement.prompt,
    negativePrompt: refinement.negativePrompt || undefined,
    ...(item.kind === 'video' ? { mode: 'text' } : {}),
  };
  return Object.fromEntries(Object.entries(base).filter(([, v]) => v != null && v !== ''));
}

export default function PromptRefineModal({ item, open, onClose }) {
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading: providersLoading,
  } = useProviderModels();
  const [feedback, setFeedback] = useState('');
  const [refinedPrompt, setRefinedPrompt] = useState('');
  const [refinedNegative, setRefinedNegative] = useState('');
  const [rationale, setRationale] = useState('');
  const [refining, setRefining] = useState(false);
  const [queueing, setQueueing] = useState(false);

  useEffect(() => {
    setFeedback('');
    setRefinedPrompt('');
    setRefinedNegative('');
    setRationale('');
  }, [open, item?.key]);

  const hasResult = refinedPrompt !== '' || rationale !== '';

  if (!open || !item) return null;

  const originalPrompt = item.prompt || '';
  const originalNegative = item.negativePrompt || '';
  const canRefine = feedback.trim() && selectedProviderId && !refining;
  const canQueue = hasResult && refinedPrompt.trim() && !queueing;

  // refineMediaPrompt + generateImage go through services/apiCore#request(),
  // which already toasts on non-2xx responses. Don't toast again from the
  // modal's catch on those paths — that'd produce duplicate notifications.
  // generateVideo uses raw fetch (multipart, see apiImageVideo.js) and does
  // NOT auto-toast, so the video catch still needs its own toast.
  const runRefine = async () => {
    if (!canRefine) return;
    setRefining(true);
    setRefinedPrompt('');
    setRefinedNegative('');
    setRationale('');
    try {
      const result = await refineMediaPrompt({
        kind: item.kind,
        prompt: originalPrompt,
        negativePrompt: originalNegative,
        feedback: feedback.trim(),
        providerId: selectedProviderId,
        model: selectedModel || undefined,
        renderConfig: getRenderConfig(item),
      });
      setRefinedPrompt(result.prompt || '');
      setRefinedNegative(result.negativePrompt || '');
      setRationale(result.rationale || '');
    } catch {
      // request() already toasted the server's error message.
    } finally {
      setRefining(false);
    }
  };

  const queueRender = async () => {
    if (!canQueue) return;
    setQueueing(true);
    try {
      const payload = queuePayload(item, { prompt: refinedPrompt.trim(), negativePrompt: refinedNegative.trim() });
      const result = item.kind === 'image'
        ? await generateImage(payload)
        : await generateVideo(payload);
      // external image-gen mode returns synchronously with the filename and
      // no queue position — the render already completed by the time this
      // resolves. Local / codex / video return a queued jobId+position.
      const isAlreadyDone = item.kind === 'image' && result?.mode === 'external';
      const message = isAlreadyDone
        ? 'Render complete'
        : result.position ? `Queued #${result.position}` : 'Render queued';
      toast.success(message);
      onClose();
    } catch (err) {
      // generateImage routes through request() which already toasts; only
      // surface a toast for the raw-fetch video path.
      if (item.kind === 'video') toast.error(err.message || 'Failed to queue render');
    } finally {
      setQueueing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4"
      // Stop the click before the underlying MediaLightbox backdrop sees it —
      // both layers wire onClick={onClose} on the backdrop, and without
      // stopPropagation a single backdrop click would dismiss the refine modal
      // AND close the lightbox underneath it.
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      role="presentation"
    >
      <section
        className="w-full max-w-3xl max-h-[90vh] overflow-hidden bg-port-card border border-port-border rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-refine-title"
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-port-border">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="w-4 h-4 text-port-accent shrink-0" />
            <h2 id="prompt-refine-title" className="text-sm font-semibold text-white">Refine Prompt</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div>
            <label htmlFor="prompt-refine-feedback" className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">
              Feedback
            </label>
            <textarea
              id="prompt-refine-feedback"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should change about this render?"
              rows={4}
              className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent resize-y"
            />
          </div>

          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            label="LLM Provider"
            disabled={providersLoading || refining}
          />

          {providers.length === 0 && !providersLoading && (
            <p className="text-xs text-port-warning">No enabled providers are configured.</p>
          )}

          <button
            type="button"
            onClick={runRefine}
            disabled={!canRefine}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
          >
            <Wand2 className="w-4 h-4" />
            {refining ? 'Refining...' : (hasResult ? 'Refine Prompt again' : 'Refine Prompt')}
          </button>

          {hasResult && (
            <div className="space-y-4">
              {rationale && (
                <p className="text-sm text-gray-300 bg-port-bg border border-port-border rounded-lg p-3">
                  {rationale}
                </p>
              )}

              <div>
                <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">New prompt</label>
                <textarea
                  value={refinedPrompt}
                  onChange={(e) => setRefinedPrompt(e.target.value)}
                  rows={6}
                  className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white focus:outline-none focus:border-port-accent resize-y"
                />
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">New negative prompt</label>
                <textarea
                  value={refinedNegative}
                  onChange={(e) => setRefinedNegative(e.target.value)}
                  rows={3}
                  className="w-full bg-port-bg border border-port-border rounded-lg p-3 text-sm text-white focus:outline-none focus:border-port-accent resize-y"
                />
              </div>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-port-border">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-port-border/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={queueRender}
            disabled={!canQueue}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-port-success text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
          >
            <ListPlus className="w-4 h-4" />
            {queueing ? 'Queueing...' : 'Queue Render'}
          </button>
        </footer>
      </section>
    </div>
  );
}
