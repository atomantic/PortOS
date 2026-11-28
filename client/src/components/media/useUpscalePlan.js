import { useCallback, useEffect, useRef, useState } from 'react';
import { useSseProgress } from '../../hooks/useSseProgress';
import { getUpscalePlan, quoteTopazUpscale, upscaleAdapterDownloadUrl } from '../../services/apiImageVideo';
import { hardwareUnavailableReason, isHardwareAvailable } from '../../utils/systemCapabilities';
import toast from '../ui/Toast';

function getLtxReadiness(plan) {
  const runtimeReady = plan?.runtime?.installed === true;
  const adapterReady = plan?.adapter?.cached === true;
  const baseModelReady = plan?.baseModel?.cached === true;
  // Older servers omit the hardware annotation. Check it ahead of download
  // requirements so an incompatible host isn't offered an unusable download.
  const hostReady = isHardwareAvailable(plan?.baseModel);
  const ready = runtimeReady && hostReady && adapterReady && baseModelReady;
  const adapterMissing = !!plan && runtimeReady && hostReady && !adapterReady;
  let reason = null;
  if (plan) {
    if (!runtimeReady) reason = plan.runtime.reason;
    else if (!hostReady) reason = hardwareUnavailableReason(plan.baseModel?.name || 'The LTX-2.5 pack', plan.baseModel?.hardwareCompatibility);
    else if (!adapterReady) reason = `The ${plan.adapter?.label || 'generative upscale'} adapter is not downloaded yet.`;
    else if (!baseModelReady) reason = plan.baseModel?.reason || 'The LTX-2.5 model pack for this backend is not downloaded yet.';
  }
  return { ready, adapterMissing, reason };
}

export default function useUpscalePlan(open, itemId, method, {
  initialMethod, defaultTargetResolution, targetResolution, realesrganModel, musicVideo,
}) {
  const [plan, setPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [falPlan, setFalPlan] = useState(null);
  const [falPlanLoading, setFalPlanLoading] = useState(false);
  const [falPlanError, setFalPlanError] = useState(null);
  const [realesrganPlan, setRealesrganPlan] = useState(null);
  const [realesrganPlanLoading, setRealesrganPlanLoading] = useState(false);
  const [realesrganPlanError, setRealesrganPlanError] = useState(null);
  const [topazModel, setTopazModel] = useState('proteus');
  const [quote, setQuote] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [downloadItemId, setDownloadItemId] = useState(null);
  const downloading = open && downloadItemId === itemId;
  const planRequestRef = useRef(0);
  const quoteIdentityRef = useRef({ itemId, open, generation: 0 });
  if (quoteIdentityRef.current.itemId !== itemId || quoteIdentityRef.current.open !== open) {
    quoteIdentityRef.current = { itemId, open, generation: quoteIdentityRef.current.generation + 1 };
  }

  // Reset plans and pending requests on the same identity change as the form.
  useEffect(() => {
    ++planRequestRef.current;
    setPlan(null);
    setPlanError(null);
    setFalPlan(null);
    setFalPlanError(null);
    setFalPlanLoading(false);
    setRealesrganPlan(null);
    setRealesrganPlanError(null);
    setRealesrganPlanLoading(false);
    setTopazModel('proteus');
    setQuote(null);
    setQuoteError(null);
    setQuoting(false);
    setDownloadItemId(null);
  }, [open, itemId, initialMethod, defaultTargetResolution]);

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

  useEffect(() => {
    if (!open || !itemId || method !== 'fal-seedvr2') return undefined;
    let cancelled = false;
    setFalPlanLoading(true);
    setFalPlanError(null);
    setFalPlan(null);
    getUpscalePlan(itemId, 'fal-seedvr2', { targetResolution })
      .then((res) => { if (!cancelled) setFalPlan(res?.plan || null); })
      .catch((err) => { if (!cancelled) setFalPlanError(err.message || 'Could not check fal.ai SeedVR2 readiness'); })
      .finally(() => { if (!cancelled) setFalPlanLoading(false); });
    return () => { cancelled = true; };
  }, [open, itemId, method, targetResolution]);

  // Read-only like the others: the plan stats the Real-ESRGAN install and its
  // receipt, and never downloads; only the Install button below does (#19985).
  // Keyed by weights, so switching the picker re-reads that weight's readiness.
  useEffect(() => {
    if (!open || !itemId || method !== 'realesrgan' || realesrganPlan?.runtime?.model?.id === realesrganModel) return undefined;
    let cancelled = false;
    setRealesrganPlanLoading(true);
    setRealesrganPlanError(null);
    getUpscalePlan(itemId, 'realesrgan', { realesrganModel })
      .then((res) => { if (!cancelled) setRealesrganPlan(res?.plan || null); })
      .catch((err) => { if (!cancelled) setRealesrganPlanError(err.message || 'Could not check Real-ESRGAN readiness'); })
      .finally(() => { if (!cancelled) setRealesrganPlanLoading(false); });
    return () => { cancelled = true; };
  }, [open, itemId, method, realesrganModel, realesrganPlan]);
  const refreshRealesrganPlan = useCallback(() => setRealesrganPlan(null), []);

  const falSeedvr2Ready = falPlan?.runtime?.installed === true && falPlan?.alreadyUpscaled !== true
    && falPlan?.targetResolution === targetResolution && (musicVideo == null || falPlan.estimatedCostUsd != null);
  const realesrganRuntime = realesrganPlan?.runtime?.model?.id === realesrganModel ? realesrganPlan.runtime : null;
  const realesrganReady = realesrganRuntime?.installed === true && realesrganPlan?.alreadyUpscaled !== true;

  // Inline adapter download (#6510 item 4) — the same provisioning surface
  // every IC-LoRA weight rides (#3100), just triggered from here instead of a
  // separate models page, since no such page manages this non-remix weight.
  const adapterKey = plan?.adapter?.key || null;
  const downloadUrl = downloading ? upscaleAdapterDownloadUrl(adapterKey) : null;
  const dl = useSseProgress(downloadUrl, { enabled: !!downloadUrl, method: 'POST' });

  useEffect(() => {
    if (!downloading || !dl.closed || !dl.latest) return;
    // A request-generation ref, not a `let active` flag: `downloading` is in this
    // effect's own dependency array, so the write below re-runs the effect
    // immediately and a lifetime-scoped flag would be flipped by its own
    // cleanup before the response landed. The re-run early-returns without
    // bumping, so the in-flight request stays current and only a genuinely
    // newer one supersedes it.
    if (dl.latest.type === 'complete') {
      const req = ++planRequestRef.current;
      setDownloadItemId(null);
      // Re-probe so `adapter.cached` flips and the option re-enables.
      getUpscalePlan(itemId, 'ltx').then((res) => { if (req === planRequestRef.current) setPlan(res?.plan || null); }).catch(() => {});
    } else if (dl.latest.type === 'error') {
      setDownloadItemId(null);
      toast.error(dl.latest.message || 'Adapter download failed');
    }
  }, [dl.closed, dl.latest, downloading, itemId]);

  const getQuote = async () => {
    setQuoting(true);
    setQuote(null);
    setQuoteError(null);
    const requestId = ++planRequestRef.current;
    const identity = quoteIdentityRef.current.generation;
    const current = () => requestId === planRequestRef.current && identity === quoteIdentityRef.current.generation;
    await quoteTopazUpscale(itemId, topazModel, { silent: true })
      .then(result => { if (current()) setQuote(result.quote); })
      .catch(error => { if (current()) setQuoteError(error.message || 'Could not get a Topaz estimate'); });
    if (current()) setQuoting(false);
  };

  const changeTopazModel = (model) => {
    setTopazModel(model);
    setQuote(null);
    setQuoteError(null);
    ++planRequestRef.current;
    setQuoting(false);
  };

  return {
    ltx: {
      plan,
      loading: planLoading,
      error: planError,
      ...getLtxReadiness(plan),
      downloading,
      downloadFrame: dl.latest,
      downloadAdapter: () => setDownloadItemId(itemId),
    },
    fal: {
      plan: falPlan,
      loading: falPlanLoading,
      error: falPlanError,
      ready: falSeedvr2Ready,
      clearPlan: () => setFalPlan(null),
    },
    realesrgan: {
      plan: realesrganPlan,
      loading: realesrganPlanLoading,
      error: realesrganPlanError,
      ready: realesrganReady,
      runtime: realesrganRuntime,
      refreshPlan: refreshRealesrganPlan,
    },
    topaz: { model: topazModel, changeModel: changeTopazModel, quote, quoteError, quoting, getQuote },
  };
}
