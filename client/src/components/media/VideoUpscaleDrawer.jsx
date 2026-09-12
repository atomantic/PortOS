/**
 * Video upscale method picker (issue #6510) — the disclosure step between the
 * gallery's Upscale button and the actual submit.
 *
 * Two methods, both 2×: `lanczos` (the historical ffmpeg pass, always
 * available) and `ltx` (the LTX-2.5 generative adapter, gated on a supported
 * BYOV runtime plus a cached adapter — #6509's plan endpoint). Opening the
 * drawer fetches ONLY the read-only plan (`GET .../plan?method=ltx`); nothing
 * is queued and no weight is pulled until the user presses Upscale.
 *
 * Shared by VideoGen.jsx and MediaHistory.jsx — both pages own the item that
 * opens the drawer and get the finished entry back via `onUpscaled` for their
 * existing reactive local-state update (no refetch).
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import Drawer from '../Drawer';
import toast from '../ui/Toast';
import { formatBytes } from '../../utils/formatters';
import { isHardwareAvailable, hardwareUnavailableReason } from '../../utils/systemCapabilities';
import { useSseProgress } from '../../hooks/useSseProgress';
import { upscaleVideo, getUpscalePlan, upscaleAdapterDownloadUrl } from '../../services/apiImageVideo';

export default function VideoUpscaleDrawer({ item, onClose, onUpscaled }) {
  const open = !!item;
  const itemId = item?.id ?? null;

  const [method, setMethod] = useState('lanczos');
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // Fresh state per open (and per item, in case a second card is picked
  // before the drawer fully unmounts) so a stale method/plan never carries
  // over onto a different clip.
  useEffect(() => {
    if (!open) return;
    setMethod('lanczos');
    setPlan(null);
    setPlanError(null);
    setDownloading(false);
  }, [open, itemId]);

  // The generative plan drives the radio's disabled state AND its disclosure
  // once picked, so fetch it as soon as the drawer opens rather than waiting
  // for the user to select "generative" first — otherwise there's no way to
  // show it disabled up front. Read-only: never queues a job, never pulls a
  // weight (#6509).
  useEffect(() => {
    if (!open || !itemId) return undefined;
    let cancelled = false;
    setPlanLoading(true);
    setPlanError(null);
    getUpscalePlan(itemId, 'ltx')
      .then((res) => { if (!cancelled) setPlan(res?.plan || null); })
      .catch((err) => { if (!cancelled) setPlanError(err.message || 'Could not check generative upscale readiness'); })
      .finally(() => { if (!cancelled) setPlanLoading(false); });
    return () => { cancelled = true; };
  }, [open, itemId]);

  const runtimeReady = plan?.runtime?.installed === true;
  const adapterReady = plan?.adapter?.cached === true;
  // The base checkpoint is a third readiness axis (#6512): the venv and the
  // 327 MB adapter can both be present while the ~68 GB LTX-2.5 pack is not,
  // and the runner is handed a resolved snapshot path rather than resolving
  // (and silently downloading) one itself. Without this the button would read
  // ready for a job the dispatch refuses.
  const baseModelReady = plan?.baseModel?.cached === true;
  // The host itself is a FOURTH axis (#6537): the machine can have the venv,
  // the adapter and the whole 68 GB pack and still sit below what the pack needs
  // of it (the CUDA pack asks for 64 GB of system memory). The dispatch refuses
  // that host, so offering the button would promise a job that fails. Read
  // through the shared helper, which already treats an absent annotation — a
  // plan from an older server — as compatible rather than newly disabling it.
  // Ordered ahead of the two "not downloaded" reasons because it outranks them:
  // downloading 72 GB onto a machine that cannot run it helps nobody.
  const hostReady = isHardwareAvailable(plan?.baseModel);
  const generativeReady = runtimeReady && hostReady && adapterReady && baseModelReady;
  const adapterMissing = !!plan && runtimeReady && hostReady && !adapterReady;
  const generativeDisabledReason = !plan
    ? null
    : !runtimeReady
      ? plan.runtime.reason
      : !hostReady
        ? hardwareUnavailableReason(plan.baseModel?.name || 'The LTX-2.5 pack', plan.baseModel?.hardwareCompatibility)
        : !adapterReady
          ? `The ${plan.adapter?.label || 'generative upscale'} adapter is not downloaded yet.`
          : !baseModelReady
            ? plan.baseModel?.reason || 'The LTX-2.5 model pack for this backend is not downloaded yet.'
            : null;

  // Inline adapter download (#6510 item 4) — the same provisioning surface
  // every IC-LoRA weight rides (#3100), just triggered from here instead of a
  // separate models page, since no such page manages this non-remix weight.
  const adapterKey = plan?.adapter?.key || null;
  const downloadUrl = downloading ? upscaleAdapterDownloadUrl(adapterKey) : null;
  const dl = useSseProgress(downloadUrl, { enabled: !!downloadUrl });

  // Supersession token for the post-download plan re-probe below.
  const planRequestRef = useRef(0);
  useEffect(() => {
    if (!downloading || !dl.latest) return;
    // A request-generation ref, not a `let active` flag: `downloading` is in this
    // effect's own dependency array, so the write below re-runs the effect
    // immediately and a lifetime-scoped flag would be flipped by its own
    // cleanup before the response landed. The re-run early-returns without
    // bumping, so the in-flight request stays current and only a genuinely
    // newer one supersedes it.
    if (dl.latest.type === 'complete') {
      const req = ++planRequestRef.current;
      setDownloading(false);
      // Re-probe so `adapter.cached` flips and the option re-enables.
      getUpscalePlan(itemId, 'ltx').then((res) => { if (req === planRequestRef.current) setPlan(res?.plan || null); }).catch(() => {});
    } else if (dl.latest.type === 'error') {
      setDownloading(false);
      toast.error(dl.latest.message || 'Adapter download failed');
    }
  }, [dl.latest, downloading, itemId]);

  const handleSubmit = useCallback(async () => {
    if (!itemId || submitting) return;
    if (method === 'ltx' && !generativeReady) return;
    setSubmitting(true);
    toast.loading(method === 'ltx' ? 'Upscaling 2× (generative)…' : 'Upscaling 2× — typically 10-30s…');
    const result = await upscaleVideo(itemId, { method, silent: true }).catch((err) => {
      toast.error(err.message || 'Upscale failed');
      return null;
    });
    setSubmitting(false);
    // The two methods answer with different keys because they finish at
    // different times (#6511): Lanczos runs inline and hands back the finished
    // row, while the generative pass is a multi-minute GPU render that answers
    // with the queued job and lands in history when it completes.
    if (result?.job) {
      toast.success('Queued — watch it in the render queue');
      onClose();
      return;
    }
    if (result?.video) {
      onUpscaled(result.video);
      toast.success('Upscaled 2×');
      onClose();
    }
  }, [itemId, method, submitting, generativeReady, onUpscaled, onClose]);

  const dlFrame = dl.latest;
  const dlPct = typeof dlFrame?.progress === 'number' ? Math.round(dlFrame.progress * 100) : null;

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

          <label
            htmlFor="upscale-method-ltx"
            className={`flex items-start gap-2 p-2 border rounded ${
              generativeReady ? 'border-port-border hover:border-port-accent/60 cursor-pointer' : 'border-port-border/50 opacity-80'
            }`}
          >
            <input
              type="radio"
              id="upscale-method-ltx"
              name="upscale-method"
              value="ltx"
              checked={method === 'ltx'}
              disabled={!generativeReady}
              onChange={() => setMethod('ltx')}
              className="mt-0.5"
              aria-describedby={generativeDisabledReason ? 'upscale-method-ltx-reason' : undefined}
            />
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-white">LTX-2.5 generative (synthesizes detail)</span>
              <span className="block text-[11px] text-gray-500">2× via a GPU model — adds detail rather than resizing pixels.</span>
              {planLoading && <span className="block text-[11px] text-gray-500 mt-1">Checking readiness…</span>}
              {planError && <span className="block text-[11px] text-port-error mt-1">{planError}</span>}
              {generativeDisabledReason && (
                <span id="upscale-method-ltx-reason" className="block text-[11px] text-port-warning mt-1">
                  {generativeDisabledReason}
                  {adapterMissing && (
                    <>
                      {' '}
                      {downloading ? (
                        <span className="text-gray-400">
                          {dlFrame?.type === 'verify' ? 'Verifying…' : 'Downloading…'}
                          {dlPct != null ? ` ${dlPct}%` : ''}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setDownloading(true)}
                          className="text-port-accent hover:text-white underline"
                        >
                          Download adapter{plan.adapter?.sizeBytes ? ` (${formatBytes(plan.adapter.sizeBytes)})` : ''}
                        </button>
                      )}
                    </>
                  )}
                </span>
              )}
            </span>
          </label>
        </fieldset>

        {method === 'ltx' && plan && (
          <div className="p-2 border border-port-border rounded space-y-1 text-[11px] text-gray-400">
            <p className="text-xs font-medium text-white">Before you submit</p>
            <p>Model: <span className="text-white">{plan.adapter?.label || 'LTX-2.5 Pixel Spatial Upscaler'}</span></p>
            <p>
              Target size:{' '}
              <span className="text-white">
                {plan.target?.width ?? '?'}×{plan.target?.height ?? '?'}
              </span>
              {plan.target?.frameCount ? `, ${plan.target.frameCount} frames` : ''}
            </p>
            {plan.alignment && plan.alignment.conforming === false && (
              <p>
                Padding: source pads to {plan.alignment.paddedSource?.width}×{plan.alignment.paddedSource?.height}
                {plan.alignment.padFrames ? `, +${plan.alignment.padFrames} frame(s)` : ''} to fit the model grid
                (cropped back off the output — nothing is trimmed).
              </p>
            )}
            <p className="text-port-warning">
              Details are synthesized, not pixel-faithfully refined — the result will not exactly match the source.
            </p>
          </div>
        )}

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
            disabled={submitting || (method === 'ltx' && !generativeReady)}
            className="px-3 py-1.5 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Upscale 2×
          </button>
        </div>
      </div>
    </Drawer>
  );
}
