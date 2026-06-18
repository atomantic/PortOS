import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSseProgress } from './useSseProgress.js';
import toast from '../components/ui/Toast';
import {
  getImageModelStatuses, getVideoModelStatuses,
  verifyImageModels, verifyVideoModels, repairImageModel, repairVideoModel,
  repairTextEncoder,
} from '../services/apiImageVideo.js';

// Sentinel `modelId` used to drive a text-encoder download instead of a model
// download. The video form passes this to `start()`; the URL builder below
// rewrites to the dedicated /text-encoder/download endpoint. Exported so
// callers and the hook agree on the magic string.
export const TEXT_ENCODER_DOWNLOAD_ID = '__text_encoder__';

const buildDownloadUrl = (kind, modelId) => {
  if (!modelId) return null;
  if (kind === 'video' && modelId === TEXT_ENCODER_DOWNLOAD_ID) {
    return '/api/video-gen/text-encoder/download';
  }
  return `/api/${kind}-gen/models/${encodeURIComponent(modelId)}/download`;
};

// Model download-status hook. Drives the inline "Available · 7.8 GB" /
// "Download (~8 GB)" badge next to the image/video gen model picker.
//
// `kind` selects the endpoint family ('image' | 'video'). `start(modelId)`
// opens an EventSource against the download endpoint. When the stream
// emits a terminal frame we automatically refetch /models/status so the
// badge flips to "Available" without the caller wiring that up.
export function useModelDownloadStatus({ kind = 'image' } = {}) {
  const [statuses, setStatuses] = useState(null);
  const [extra, setExtra] = useState({}); // video: { textEncoder: {...} }
  const [loading, setLoading] = useState(false);
  const [activeModelId, setActiveModelId] = useState(null);

  const fetchStatuses = useCallback(async () => {
    setLoading(true);
    // Best-effort: a failure leaves the badge in its loading state. The form
    // still works because lazy download is the existing fallback.
    const body = await (kind === 'video' ? getVideoModelStatuses() : getImageModelStatuses())
      .catch(() => null);
    if (body == null) {
      setStatuses([]);
      setExtra({});
    } else if (kind === 'video') {
      setStatuses(Array.isArray(body?.models) ? body.models : []);
      setExtra({ textEncoder: body?.textEncoder || null });
    } else {
      setStatuses(Array.isArray(body) ? body : []);
      setExtra({});
    }
    setLoading(false);
  }, [kind]);

  useEffect(() => { fetchStatuses(); }, [fetchStatuses]);

  // EventSource for the active download. `null` URL = idle (useSseProgress's
  // `enabled: false` cleanup tears the connection down on cancel).
  const downloadUrl = buildDownloadUrl(kind, activeModelId);
  const sse = useSseProgress(downloadUrl, { enabled: !!downloadUrl });

  // Refetch on natural stream close. useSseProgress flips `closed:true` once
  // per subscription and resets to false when the URL changes; that single
  // transition is the safe signal — no extra `wasClosed` ref needed.
  // A terminal error frame (gated repo, missing HF token, broken venv) is
  // routed to a toast here because the active-badge state vanishes the moment
  // we clear `activeModelId`; without this, the UI silently snaps back to the
  // Download button and the actionable server message is lost.
  useEffect(() => {
    if (sse.closed) {
      if (sse.latest?.type === 'error' && sse.latest?.message) {
        toast.error(sse.latest.message);
      }
      fetchStatuses();
      setActiveModelId(null);
    }
  }, [sse.closed, sse.latest, fetchStatuses]);

  const start = useCallback((modelId) => {
    setActiveModelId(modelId);
  }, []);

  // Force a deep integrity re-scan (per-file sha256). Returns the server's
  // result and refreshes the status list so the structural badge stays current.
  // `verifying` flips while in flight so the caller can disable the button.
  const [verifying, setVerifying] = useState(false);
  const verify = useCallback(async ({ modelId, deep = true } = {}) => {
    setVerifying(true);
    const fn = kind === 'video' ? verifyVideoModels : verifyImageModels;
    const result = await fn({ modelId, deep }).catch((err) => {
      toast.error(err?.message || 'Integrity scan failed');
      return null;
    });
    await fetchStatuses();
    setVerifying(false);
    return result;
  }, [kind, fetchStatuses]);

  // Repair = delete the flagged corrupt files, then re-download them through
  // the same SSE path the Download button uses (progress + auto status-refresh
  // on completion come for free). `repairing` gates the button while the
  // deletion request is in flight.
  const [repairing, setRepairing] = useState(false);
  const repair = useCallback(async (modelId, { deep = false } = {}) => {
    if (!modelId) return;
    setRepairing(true);
    // The shared text encoder isn't a model id, so its repair hits the scalar
    // /text-encoder/repair endpoint; the sentinel `start()` below already maps
    // to the dedicated /text-encoder/download SSE for the clean re-fetch.
    const isTextEncoder = kind === 'video' && modelId === TEXT_ENCODER_DOWNLOAD_ID;
    const run = isTextEncoder
      ? () => repairTextEncoder({ deep })
      : () => (kind === 'video' ? repairVideoModel : repairImageModel)(modelId, { deep });
    const result = await run().catch((err) => {
      toast.error(err?.message || 'Repair failed');
      return null;
    });
    setRepairing(false);
    if (result) start(modelId); // re-download clean copies via the existing SSE
    return result;
  }, [kind, start]);

  // Manual cancel: refetch directly because `sse.close()` followed by
  // setActiveModelId(null) clears the URL, which causes useSseProgress to
  // reset `closed → false` before the close-effect can observe `true`.
  // Without this direct refetch the badge would stay stuck on its pre-cancel
  // state until the next page mount.
  const cancel = useCallback(() => {
    sse.close();
    setActiveModelId(null);
    fetchStatuses();
  }, [sse, fetchStatuses]);

  // Memoize the active model's enriched status so a new SSE frame doesn't
  // hand a fresh object to every non-active model's badge (only the active
  // one re-renders). For inactive models we return the raw entry, which is
  // referentially stable across frames.
  const activeStatus = useMemo(() => {
    if (!activeModelId) return null;
    const list = Array.isArray(statuses) ? statuses : [];
    const entry = list.find((s) => s.id === activeModelId);
    if (!entry) return null;
    return { ...entry, downloading: true, progress: sse.latest };
  }, [activeModelId, statuses, sse.latest]);

  const getStatus = useCallback((modelId) => {
    if (modelId === activeModelId) return activeStatus;
    const list = Array.isArray(statuses) ? statuses : [];
    return list.find((s) => s.id === modelId) || null;
  }, [statuses, activeModelId, activeStatus]);

  return {
    statuses,
    extra,
    loading,
    refresh: fetchStatuses,
    start,
    cancel,
    verify,
    verifying,
    repair,
    repairing,
    getStatus,
    activeModelId,
    progress: sse.latest,
    downloading: !!activeModelId,
  };
}
