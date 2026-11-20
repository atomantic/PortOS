import { useEffect, useId, useState } from 'react';
import { Clapperboard, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { extendVideoHistoryItem, getVideoHistoryItem } from '../../services/apiImageVideo.js';
import { falExtendModel } from '../../lib/falVideoModels.js';
import { formatUsd } from '../../utils/formatters.js';

// One history lookup per clip: the offer depends on the model the clip was rendered with.
const modelByClip = new Map();
const clipModel = (assetId) => {
  if (!modelByClip.has(assetId)) {
    modelByClip.set(assetId, getVideoHistoryItem(assetId, { silent: true }).then((row) => row?.modelId ?? null).catch(() => {
      modelByClip.delete(assetId);
      return null;
    }));
  }
  return modelByClip.get(assetId);
};

/**
 * "Extend this clip" on a video take (#16150): offered only when the clip's recorded model declares an extend
 * endpoint. The director writes the prompt, previews the exact request and price, then sends it; the result
 * arrives as an unselected child take on this shot.
 */
export default function TakeExtend({ projectId, scene, take, busy = false }) {
  const [model, setModel] = useState(null);
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [plan, setPlan] = useState(null);
  const [working, setWorking] = useState(false);
  const promptId = useId();

  useEffect(() => {
    let live = true;
    clipModel(take.assetId).then((modelId) => { if (live) setModel(falExtendModel(modelId)); });
    return () => { live = false; };
  }, [take.assetId]);

  if (!model) return null;
  const target = { projectId, sceneId: scene.sceneId, takeId: take.takeId };
  const call = async (dryRun) => {
    setWorking(true);
    const result = await extendVideoHistoryItem(take.assetId, { prompt, dryRun, musicVideo: target }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not extend this clip');
      return null;
    });
    setWorking(false);
    return result;
  };
  const preview = async () => { const result = await call(true); if (result) setPlan(result); };
  const send = async () => {
    const result = await call(false);
    if (!result) return;
    toast.success('Extending the clip. It arrives here as a new take.');
    setOpen(false);
    setPlan(null);
    setPrompt('');
  };

  if (!open) {
    return (
      <button type="button" disabled={busy} onClick={() => setOpen(true)}
        className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 text-[10px] pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50"
        title={`Continue this clip with ${model.label}. The result is a new take; nothing is selected for you.`}>
        <Clapperboard size={11} aria-hidden="true" /> Extend this clip
      </button>
    );
  }
  return (
    <div className="space-y-1 rounded border border-port-border bg-port-bg p-1 text-[10px]">
      <label htmlFor={promptId} className="block text-port-text-muted">What happens next ({model.label})</label>
      <textarea id={promptId} value={prompt} rows={3} maxLength={20000}
        onChange={(e) => { setPrompt(e.target.value); setPlan(null); }}
        className="w-full rounded border border-port-border bg-port-card px-1 py-0.5 text-[11px]" />
      {plan && (
        <div className="space-y-1">
          <p>{plan.seconds}s at {plan.resolution}, about {plan.estimatedCostUsd == null ? 'an unknown price' : formatUsd(plan.estimatedCostUsd)}</p>
          <details>
            <summary className="cursor-pointer">Show full request</summary>
            <pre className="whitespace-pre-wrap break-words">{JSON.stringify(plan.body, null, 2)}</pre>
          </details>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        <button type="button" disabled={working || !prompt.trim()} onClick={preview}
          className="inline-flex items-center gap-0.5 rounded bg-port-border px-1.5 py-0.5 pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50">
          {working && <Loader2 size={11} className="animate-spin" aria-hidden="true" />} Preview price
        </button>
        <button type="button" disabled={working || !plan} onClick={send}
          className="rounded bg-port-accent/20 px-1.5 py-0.5 text-port-accent pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0 disabled:opacity-50">
          Send for {plan ? (plan.estimatedCostUsd == null ? 'unknown price' : formatUsd(plan.estimatedCostUsd)) : 'preview first'}
        </button>
        <button type="button" onClick={() => { setOpen(false); setPlan(null); }}
          className="rounded bg-port-border px-1.5 py-0.5 pointer-coarse:min-h-11 min-h-[32px] sm:min-h-0">Cancel</button>
      </div>
    </div>
  );
}
