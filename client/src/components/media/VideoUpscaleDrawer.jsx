/**
 * Video upscale method picker (issue #6510) — the disclosure step between the
 * gallery's Upscale button and the actual submit.
 *
 * Local methods, all 2×: `lanczos` (the historical ffmpeg pass, always
 * available), `ltx` (the LTX-2.5 generative adapter, gated on a supported
 * BYOV runtime plus a cached adapter — #6509's plan endpoint) and `realesrgan`
 * (the opt-in Real-ESRGAN runtime, #19985); plus the fal SeedVR2 and Topaz
 * cloud upscalers. Opening the drawer checks LTX readiness. SeedVR2 and
 * Real-ESRGAN plans load when selected, and Topaz requires an explicit estimate.
 * Upscale, install and download actions each require their own button press.
 *
 * Shared by VideoGen.jsx and MediaHistory.jsx — both pages own the item that
 * opens the drawer and get the finished entry back via `onUpscaled` for their
 * existing reactive local-state update (no refetch).
 */
import { useState, useEffect, useCallback } from 'react';
import { DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION, DEFAULT_REALESRGAN_MODEL } from '../../../../server/lib/videoGenRequestFields.js';
import { Loader2 } from 'lucide-react';
import Drawer from '../Drawer';
import toast from '../ui/Toast';
import { upscaleVideo, startTopazUpscale } from '../../services/apiImageVideo';
import FalSeedvr2UpscalePanel from './FalSeedvr2UpscalePanel';
import LtxUpscaleOption, { LtxUpscaleDetails } from './LtxUpscaleOption';
import RealesrganUpscalePanel from './RealesrganUpscalePanel';
import TopazUpscalePanel from './TopazUpscalePanel';
import useUpscalePlan from './useUpscalePlan';

export default function VideoUpscaleDrawer({
  item, onClose, onUpscaled, onQueued, musicVideo = null, defaultMethod = 'lanczos',
  defaultTargetResolution = DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION,
}) {
  const open = !!item;
  const itemId = item?.id ?? null;

  const initialMethod = defaultMethod === 'local-ltx25' ? 'ltx' : defaultMethod === 'fal-topaz' ? 'topaz' : defaultMethod;
  const [method, setMethod] = useState(initialMethod);
  const [targetResolution, setTargetResolution] = useState(defaultTargetResolution);
  const [realesrganModel, setRealesrganModel] = useState(DEFAULT_REALESRGAN_MODEL);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setMethod(initialMethod);
    setTargetResolution(defaultTargetResolution);
    setRealesrganModel(DEFAULT_REALESRGAN_MODEL);
  }, [open, itemId, initialMethod, defaultTargetResolution]);

  const { ltx, fal, realesrgan, topaz } = useUpscalePlan(open, itemId, method, {
    initialMethod, defaultTargetResolution, targetResolution, realesrganModel, musicVideo,
  });
  const { quote, quoting } = topaz;
  const methodUnavailable = (method === 'ltx' && !ltx.ready)
    || (method === 'fal-seedvr2' && !fal.ready)
    || (method === 'realesrgan' && !realesrgan.ready);

  const changeTargetResolution = (resolution) => {
    fal.clearPlan();
    setTargetResolution(resolution);
  };

  const shotTarget = musicVideo?.projectId;
  const sceneId = musicVideo?.sceneId;

  const handleSubmit = useCallback(async () => {
    if (!itemId || submitting || item?.upscaledFrom) return;
    if (methodUnavailable) return;
    setSubmitting(true);
    toast.loading(method === 'topaz'
      ? 'Queueing Topaz upscale…'
      : method === 'fal-seedvr2'
        ? `Queueing fal.ai SeedVR2 ${targetResolution} upscale…`
        : method === 'realesrgan'
          ? 'Queueing Real-ESRGAN 2× upscale…'
          : method === 'ltx'
            ? 'Upscaling 2× (generative)…'
            : 'Upscaling 2× — typically 10-30s…');
    const options = { silent: true, ...(shotTarget && sceneId ? { musicVideoProjectId: shotTarget, sceneId } : {}) };
    const result = await (method === 'topaz'
      ? startTopazUpscale(itemId, quote?.token, options)
      : upscaleVideo(itemId, {
        method,
        ...(method === 'fal-seedvr2' ? { targetResolution } : {}),
        ...(method === 'realesrgan' ? { realesrganModel } : {}),
        ...options,
      })).catch((err) => {
      toast.error(err.message || 'Upscale failed');
      return null;
    });
    setSubmitting(false);
    // The two methods answer with different keys because they finish at
    // different times (#6511): Lanczos runs inline and hands back the finished
    // row, while the generative pass is a multi-minute GPU render that answers
    // with the queued job and lands in history when it completes.
    if (result?.job) {
      onQueued?.(result.job);
      toast.success('Queued — watch it in the render queue');
      onClose();
      return;
    }
    if (result?.video) {
      if (result.scene) onUpscaled?.(result.video, result.scene);
      else onUpscaled?.(result.video);
      toast.success('Upscaled 2×');
      onClose();
    }
  }, [itemId, item?.upscaledFrom, method, quote, submitting, methodUnavailable, realesrganModel, shotTarget, sceneId, targetResolution, onUpscaled, onQueued, onClose]);

  return (
    <Drawer open={open} onClose={onClose} title="Upscale video" size="sm">
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium text-gray-400 mb-1">Method</legend>

          <label
            htmlFor="upscale-method-lanczos"
            className="flex items-start gap-2 p-2 border border-port-border rounded cursor-pointer hover:border-port-accent/60"
          >
            <input
              type="radio"
              id="upscale-method-lanczos"
              name="upscale-method"
              value="lanczos"
              checked={method === 'lanczos'}
              onChange={() => setMethod('lanczos')}
              className="mt-0.5"
            />
            <span>
              <span className="block text-sm text-white">Lanczos (fast, pixel-faithful)</span>
              <span className="block text-[11px] text-gray-500">2× resize, ~10-30s, no model download.</span>
            </span>
          </label>

          <LtxUpscaleOption selected={method === 'ltx'} onSelect={() => setMethod('ltx')} readiness={ltx} />

          <label htmlFor="upscale-method-realesrgan" className="flex items-start gap-2 p-2 border border-port-border rounded cursor-pointer hover:border-port-accent/60">
            <input type="radio" id="upscale-method-realesrgan" name="upscale-method" value="realesrgan" checked={method === 'realesrgan'} onChange={() => setMethod('realesrgan')} className="mt-0.5" />
            <span><span className="block text-sm text-white">Real-ESRGAN (local GPU, opt-in)</span>
              <span className="block text-[11px] text-gray-500">2× frame-by-frame enhancement on this machine. Keeps the frame rate, frame count and audio. One-time install.</span></span>
          </label>

          <label htmlFor="upscale-method-fal-seedvr2" className="flex items-start gap-2 p-2 border border-port-border rounded cursor-pointer hover:border-port-accent/60">
            <input type="radio" id="upscale-method-fal-seedvr2" name="upscale-method" value="fal-seedvr2" checked={method === 'fal-seedvr2'} onChange={() => setMethod('fal-seedvr2')} className="mt-0.5" />
            <span><span className="block text-sm text-white">SeedVR2 cloud (fal.ai, paid)</span>
              <span className="block text-[11px] text-gray-500">Diffusion upscale billed per output megapixel across all frames.</span></span>
          </label>

          <label htmlFor="upscale-method-topaz" className="flex items-start gap-2 p-2 border border-port-border rounded cursor-pointer hover:border-port-accent/60">
            <input type="radio" id="upscale-method-topaz" name="upscale-method" value="topaz" checked={method === 'topaz'} onChange={() => setMethod('topaz')} className="mt-0.5" />
            <span><span className="block text-sm text-white">Topaz Labs cloud (paid)</span>
              <span className="block text-[11px] text-gray-500">Sends this video to Topaz after you start the job.</span></span>
          </label>
        </fieldset>

        {method === 'fal-seedvr2' && (
          <FalSeedvr2UpscalePanel
            targetResolution={targetResolution}
            onTargetResolutionChange={changeTargetResolution}
            musicVideo={musicVideo}
            readiness={fal}
          />
        )}
        {method === 'realesrgan' && (
          <RealesrganUpscalePanel model={realesrganModel} onModelChange={setRealesrganModel} readiness={realesrgan} />
        )}
        {method === 'topaz' && <TopazUpscalePanel estimate={topaz} />}
        {method === 'ltx' && ltx.plan && <LtxUpscaleDetails plan={ltx.plan} />}

        {item?.upscaledFrom && <p role="alert" className="text-xs text-port-warning">This clip is already upscaled. Select the original take to use a different method.</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-port-border text-gray-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !!item?.upscaledFrom || methodUnavailable || (method === 'topaz' && (!quote || quoting))}
            className="px-3 py-1.5 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {method === 'topaz' ? 'Start Topaz upscale' : method === 'fal-seedvr2' ? 'Start SeedVR2 upscale' : method === 'realesrgan' ? 'Start Real-ESRGAN upscale' : 'Upscale 2×'}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
