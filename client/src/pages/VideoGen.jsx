/**
 * Video Generation page (LTX models via mlx_video on macOS, diffusers on
 * Windows). Local-only — there is no external A1111 equivalent for video.
 *
 * Accepts a source image either via direct upload or via the
 * `?sourceImageFile=` query param so the Image Gen page can pipe a generation
 * straight into video.
 *
 * Modes (UI state, also forwarded to the backend as `mode`):
 *   - text:   pure text-to-video
 *   - image:  image-to-video (one source image, current I2V behavior)
 *   - fflf:   first frame + last frame (two images — backend support is
 *             experimental; mlx_video only supports a single conditioning
 *             frame, so when both are provided the last is ignored)
 *   - extend: pick a previous render → its last frame becomes the source
 *             image for a new image-to-video generation
 *   - a2v:    audio-to-video (uploaded WAV/MP3 drives the video's motion +
 *             audio track) — dgrauet/ltx2 runtime only
 *   - ic-*:   IC-LoRA remix modes (issue #3100) — a reference clip drives the
 *             render through ICLoraPipeline with a per-mode IC-LoRA fused into
 *             Stage 1. Today: `ic-control` (structure/motion from a depth/pose/
 *             edge clip) and `ic-colorize` (color restored onto a B&W clip).
 *             dgrauet/ltx2 runtime only; the mode list comes from
 *             IC_LORA_MODES in lib/videoGenParams.js.
 *
 * Form state, the URL-param prefill paths, the mode/backend transitions, and
 * `buildGeneratePayload()` live in `useVideoGenForm` (issue #3291) — this page
 * owns the fetching (status/models/history/gallery), the SSE run pipeline, the
 * batch queue, and the rendering.
 *
 * Batch queue: client-side serial executor. The form's "Add to queue" button
 * appends a job to the queue (preserving the current params). When no job is
 * actively generating, the head of the queue is dequeued and submitted via
 * the same generate path as the inline button — so SSE progress, history
 * refresh, and error handling are all reused.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import LocalSetupPanel from '../components/settings/LocalSetupPanel';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import FramePanel from '../components/videoGen/FramePanel';
import KeyframePanel from '../components/videoGen/KeyframePanel';
import AudioPanel from '../components/videoGen/AudioPanel';
import ExtendPanel from '../components/videoGen/ExtendPanel';
import IcLoraPanel from '../components/videoGen/IcLoraPanel';
import AdvancedParamsPanel from '../components/videoGen/AdvancedParamsPanel';
import RuntimeFingerprint from '../components/videoGen/RuntimeFingerprint';
import ModelRepairBanner from '../components/videoGen/ModelRepairBanner';
import VideoPreviewPanel from '../components/videoGen/VideoPreviewPanel';
import VideoGenGallery from '../components/videoGen/VideoGenGallery';
import MediaPreview from '../components/media/MediaPreview';
import StylePresetPicker from '../components/media/StylePresetPicker';
import { normalizeVideo } from '../components/media/normalize';
import {
  Film, Sparkles, Settings as SettingsIcon, RefreshCw, AlertTriangle,
  X, Type, Image as ImageIcon, GitBranch, ListPlus, Music, SlidersHorizontal,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import BatchQueuePanel from '../components/media/BatchQueuePanel';
import MediaJobsQueue from '../components/media/MediaJobsQueue';
import ModelSelect from '../components/ModelSelect';
import { FormField } from '../components/ui/FormField';
import ModelDownloadBadge, { deriveSizeEstimate } from '../components/media/ModelDownloadBadge';
import { useModelDownloadStatus, TEXT_ENCODER_DOWNLOAD_ID } from '../hooks/useModelDownloadStatus';
import { useMediaJobSse } from '../hooks/useMediaJobSse';
import { useMediaCompletionRefresh } from '../hooks/useMediaCompletionRefresh';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import usePreviewRoute from '../hooks/usePreviewRoute';
import { useVideoGenQueue } from '../hooks/useVideoGenQueue.js';
import { useVideoGenForm } from '../hooks/useVideoGenForm.js';
import {
  getVideoGenStatus, generateVideo, cancelVideoGen,
  listVideoHistory, deleteVideoHistoryItem, setVideoHidden, extractLastFrame,
  upscaleVideo,
  listImageGallery,
  patchSettingsSlice,
  getActiveVideoJob,
  getSettings,
  getVideoGenRuntimeStatus,
  listLorasFull,
} from '../services/api';
import LoraPicker from '../components/imageGen/LoraPicker';
import { VIDEO_RESOLUTIONS } from '../lib/videoGenResolutions';
import { GROK_VIDEO_DURATIONS, GROK_VIDEO_DEFAULT_DURATION } from '../lib/grokVideoClip.js';
import ResolutionField from '../components/media/ResolutionField';
import { VIDEO_EDGE_BOUNDS, IC_LORA_MODES } from '../lib/videoGenParams.js';

const MODES = [
  { id: 'text',   label: 'Text',   icon: Type,       desc: 'Text-to-video' },
  { id: 'image',  label: 'Image',  icon: ImageIcon,  desc: 'Image-to-video (start frame)' },
  { id: 'fflf',   label: 'FFLF',   icon: GitBranch,  desc: 'First frame + last frame' },
  { id: 'extend', label: 'Extend', icon: Film,       desc: 'Continue from a prior render' },
  { id: 'a2v',    label: 'Audio',  icon: Music,      desc: 'Audio-to-video (audio drives motion + sync)' },
  // IC-LoRA remix modes (issue #3100) — derived from the registry so a new
  // remix mode appears in the mode bar automatically.
  ...IC_LORA_MODES.map((m) => ({ id: m.mode, label: m.label, icon: SlidersHorizontal, desc: m.description })),
];

export default function VideoGen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsOpen = searchParams.get('settings') === '1';
  const openSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('settings', '1'); return n; });
  const closeSettings = () => {
    setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('settings'); return n; });
    // The drawer hosts the Grok enable toggle — re-read it so the
    // Local/Grok backend switch appears/disappears without a reload.
    refreshGrokEnabled();
  };

  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  // Grok Build CLI video backend (#2859 phase 2) — surfaced only when the
  // user enabled Grok in Settings → Image Gen (one toggle covers image +
  // video). 'local' keeps every existing flow untouched.
  const [grokEnabled, setGrokEnabled] = useState(false);
  // The jobId of the render this tab's Generate button currently owns —
  // threaded into cancelVideoGen so cancellation is job-scoped.
  const activeJobIdRef = useRef(null);
  const [models, setModels] = useState([]);
  const refreshGrokEnabled = useCallback(() => {
    getSettings({ silent: true })
      .then((sv) => setGrokEnabled(sv?.imageGen?.grok?.enabled === true))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshGrokEnabled(); }, [refreshGrokEnabled]);

  // Installed LoRA library — the picker filters this to the current model's
  // video family. Silent: a failure just hides the picker.
  const [availableLoras, setAvailableLoras] = useState([]);
  useEffect(() => { listLorasFull().then((l) => setAvailableLoras(Array.isArray(l) ? l : [])).catch(() => {}); }, []);

  // Every field the form submits, plus the payload builder both submit paths
  // share. See client/src/hooks/useVideoGenForm.js.
  const {
    backend, isGrok, handleBackendChange, grokDuration, setGrokDuration,
    mode, handleModeChange,
    prompt, setPrompt, negativePrompt, setNegativePrompt, stylePreset, setStylePreset,
    modelId, handleModelChange, currentModel, visibleModels,
    loraFamily, videoLoras, installedVideoLoras, showLtxLoraUnsupportedHint,
    selectedLoras, setSelectedLoras,
    width, height, handleResolutionChange,
    numFrames, setNumFrames, fps, setFps, chunks, setChunks,
    steps, setSteps, guidanceScale, setGuidanceScale, imageStrength, setImageStrength,
    seed, setSeed, handleRandomSeed, tiling, setTiling,
    disableAudio, setDisableAudio, noMusic, setNoMusic,
    sourceImageFile, sourceImageUpload, sourceUploadUrl,
    pickSourceImage, uploadSourceImage, clearSourceImage,
    lastImageFile, lastImageUpload, lastUploadUrl,
    pickLastImage, uploadLastImage, clearLastImage,
    keyframesMode, keyframes, keyframesSupported, keyframesActive, keyframesError, keyframesBlocked,
    toggleKeyframesMode, addKeyframe, updateKeyframe, removeKeyframe,
    extendFromVideoId, extendingFrame, handleExtendPick, extendModeBlocked,
    audioFile, setAudioFile, a2vModeBlocked,
    icSpec, icModeActive, icLoraModeBlocked,
    icReferenceFile, icReferenceVideoId, icReferenceNames, icReferenceImageFiles,
    pickIcReferenceFile, pickIcReferenceVideoId,
    addIcReferenceImage, updateIcReferenceImage, removeIcReferenceImage,
    icStrength, setIcStrength, icSkipStage2, setIcSkipStage2,
    applyRemix, applyResumedParams, buildGeneratePayload,
  } = useVideoGenForm({ models, status, availableLoras, grokEnabled });

  // Image gallery — used by both the start and end frame pickers so the
  // user can pull from any prior render in either slot.
  const [imageGallery, setImageGallery] = useState([]);
  // Visible gallery options, shared by every gallery <select> (the frame
  // panels and each multi-keyframe row) so the filter+slice runs once per
  // gallery change rather than once per picker per render.
  const visibleGallery = useMemo(
    () => imageGallery.filter((img) => !img.hidden).slice(0, 50),
    [imageGallery],
  );

  const [history, setHistory] = useState([]);
  // `preview` is URL-driven via `usePreviewRoute(previewItems)` — declared
  // after `previewItems` below so the resolver can match against it.
  const [showHidden, setShowHidden] = useState(false);
  const navigate = useNavigate();

  const refreshHistory = useCallback(() => {
    listVideoHistory().then((items) => setHistory(Array.isArray(items) ? items : [])).catch(() => {});
  }, []);
  useMediaCompletionRefresh({ onVideoCompleted: refreshHistory });
  useEffect(() => { refreshHistory(); }, [refreshHistory]);
  useEffect(() => { listImageGallery().then(setImageGallery).catch(() => {}); }, []);

  const { visibleHistory, hiddenHistory } = useMemo(() => ({
    visibleHistory: history.filter((v) => !v.hidden),
    hiddenHistory: history.filter((v) => v.hidden),
  }), [history]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { annotations, updateAnnotation, getCardProps } = useMediaAnnotations();
  // Gallery sections respect the favorites filter; the extend-mode dropdown
  // (which reads visibleHistory directly) intentionally does not, since
  // hiding non-favorites from the "pick a previous video" picker would
  // surprise the user.
  const { galleryVisible, galleryHidden } = useMemo(() => {
    if (!favoritesOnly) return { galleryVisible: visibleHistory, galleryHidden: hiddenHistory };
    // Normalize to derive the canonical item.key rather than hand-building
    // `video:${v.id}` — the kind/ref convention lives in normalize.js.
    const isStarred = (v) => !!annotations[normalizeVideo(v).key]?.starred;
    return { galleryVisible: visibleHistory.filter(isStarred), galleryHidden: hiddenHistory.filter(isStarred) };
  }, [visibleHistory, hiddenHistory, favoritesOnly, annotations]);
  const previewItems = useMemo(() => [
    ...galleryVisible.map(normalizeVideo),
    ...(showHidden ? galleryHidden.map(normalizeVideo) : []),
  ], [galleryVisible, galleryHidden, showHidden]);
  const [preview, setPreview] = usePreviewRoute(previewItems);

  const handleDeleteHistory = async (item) => {
    await deleteVideoHistoryItem(item.id, { silent: true }).catch((err) => toast.error(err.message || 'Delete failed'));
    setHistory((h) => h.filter((v) => v.id !== item.id));
  };
  const handleToggleHistoryHidden = async (item) => {
    const nextHidden = !item.hidden;
    setHistory((h) => h.map((v) => (v.id === item.id ? { ...v, hidden: nextHidden } : v)));
    const result = await setVideoHidden(item.id, nextHidden, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to update visibility');
      setHistory((h) => h.map((v) => (v.id === item.id ? { ...v, hidden: !nextHidden } : v)));
      return null;
    });
    if (result) toast.success(nextHidden ? 'Video hidden' : 'Video unhidden');
  };
  // Track which history item is being upscaled so the same MediaCard's
  // "Upscale" button disables and shows a "working" state. Storing the id
  // (not a boolean) lets us also surface the spinner on the right tile when
  // the user fires multiple upscales in succession; only one runs at a time
  // because ffmpeg is single-flight on the server.
  const [upscalingId, setUpscalingId] = useState(null);
  const handleUpscaleHistory = async (item) => {
    if (upscalingId) return;
    setUpscalingId(item.id);
    toast.loading('Upscaling 2× — typically 10-30s…');
    const result = await upscaleVideo(item.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Upscale failed');
      return null;
    });
    setUpscalingId(null);
    if (result?.video) {
      setHistory((h) => [result.video, ...h]);
      toast.success('Upscaled 2×');
    }
  };

  const handleContinueHistory = async (item) => {
    const { filename } = await extractLastFrame(item.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return {};
    });
    if (!filename) return;
    const params = new URLSearchParams({ sourceImageFile: filename });
    if (item?.width) params.set('w', String(item.width));
    if (item?.height) params.set('h', String(item.height));
    navigate(`/media/video?${params.toString()}`);
  };

  // Remix a prior render: hand all its params back into the form (the hook
  // owns the field-by-field restore) and scroll the form back into view.
  const handleRemixVideo = (item) => {
    if (!item) return;
    applyRemix(item);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const { attach, eventSourceRef } = useMediaJobSse('video');
  // Hold the reject() of the in-flight runGeneration Promise so cancel can
  // settle it. Without this, handleCancel() closes the EventSource but the
  // outstanding Promise dangles forever — and the queue worker's .finally()
  // never runs, leaving runningQueueId stuck and freezing further dequeue.
  const runRejectRef = useRef(null);
  // Per-run abort token. Bumped at the start of each runGeneration() and
  // again on cancel; runGeneration captures the value at start and bails
  // when the token has moved on (e.g. POST resolves after cancel).
  const runTokenRef = useRef(0);

  const refreshStatus = useCallback(() => {
    setStatusLoading(true);
    getVideoGenStatus()
      .then((s) => {
        setStatus(s);
        setModels(s.models || []);
      })
      .catch(() => setStatus({ connected: false, reason: 'Status check failed' }))
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    refreshStatus();
    return () => eventSourceRef.current?.close();
  }, [refreshStatus, eventSourceRef]);

  // SSE subscriber shared by the in-flight POST path and the mount-time
  // resume path. `withToast: false` on resume suppresses the success/error
  // toast — the user already saw it the first time and a page reload
  // shouldn't replay it.
  const attachJobEvents = (jobId, { isCurrent = () => true, settleResolve = () => {}, settleReject = () => {}, withToast = true } = {}) => {
    return attach(jobId, {
      isCurrent,
      onQueued: (msg) => setStatusMsg(typeof msg.position === 'number' ? `Queued (position ${msg.position})` : 'Queued'),
      onStarted: () => setStatusMsg('Starting render…'),
      onStatus: (msg) => setStatusMsg(msg.message),
      onProgress: (msg) => {
        setProgress({ progress: msg.progress });
        // A bare tqdm percentage shouldn't blank the STATUS line that just
        // preceded it; only overwrite when the progress event carries text.
        if (msg.message) setStatusMsg(msg.message);
      },
      onComplete: (msg) => {
        setResult(msg.result);
        setGenerating(false);
        setProgress({ progress: 1 });
        setStatusMsg('Complete');
        if (withToast) toast.success('Video generated');
        refreshHistory();
        return msg.result;
      },
      onError: (msg) => {
        setError(msg.error);
        setGenerating(false);
        if (withToast) toast.error(msg.error);
        return new Error(msg.error);
      },
      onCanceled: (msg) => {
        setGenerating(false);
        setStatusMsg(msg.reason || 'Canceled');
        if (withToast) toast(msg.reason || 'Render canceled');
        return new Error(msg.reason || 'Canceled');
      },
      onConnectionError: () => {
        setError('Lost connection to server');
        setGenerating(false);
      },
    }).then(settleResolve, settleReject);
  };

  // Resume an in-flight (or queued) render so a page reload doesn't lose
  // the preview/progress display. Server holds the job's last SSE payload,
  // so re-attaching replays the most recent status/progress immediately.
  // Mirrors the ImageGen `getActiveImageJob` mount path.
  useEffect(() => {
    getActiveVideoJob().then((data) => {
      const job = data?.activeJob;
      if (!job?.jobId) return;
      // Bail if the user already started a render in this tab. `generating`
      // would be stale here (effect deps are []), so gate on the live ref:
      // runTokenRef is bumped at the top of every runGeneration() and stays
      // > 0 for the session afterward. eventSourceRef is also checked as a
      // belt-and-suspenders signal for the in-flight POST window before
      // attachJobEvents runs.
      if (runTokenRef.current > 0 || eventSourceRef.current) return;
      applyResumedParams(job.params || {});
      setGenerating(true);
      // Skip a forced setProgress(0) here — attachJobEvents will replay the
      // server's last SSE payload synchronously after EventSource open, and
      // a job mid-render would otherwise visibly flash 0% before jumping
      // back to its real progress.
      setStatusMsg(job.status === 'queued'
        ? (typeof job.position === 'number' ? `Queued (position ${job.position})` : 'Queued')
        : 'Resuming…');
      const myToken = ++runTokenRef.current;
      const isCurrent = () => myToken === runTokenRef.current;
      attachJobEvents(job.jobId, { isCurrent, withToast: false });
    }).catch(() => {});
  }, []);

  const handleSavePythonPath = useCallback(async (path) => {
    await patchSettingsSlice('imageGen.local', { pythonPath: path || undefined }, { silent: true })
      .then(() => refreshStatus())
      .catch((err) => toast.error(`Failed to save: ${err.message}`));
  }, [refreshStatus]);

  // Probe the per-runtime status BEFORE the user hits Generate — without
  // this they'd see the buildArgs-time "venv not found" 500 with no good way
  // to recover. The set of "BYOV" runtimes comes from /status server-side so
  // it can't drift from the server's BYOV_RUNTIME_INFO map.
  const [byovStatus, setByovStatus] = useState(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const byovRuntime = currentModel?.runtime;
  const needsByovProbe = byovRuntime && (status?.byovRuntimes || []).includes(byovRuntime);
  const refreshByovStatus = useCallback((signal) => {
    if (!needsByovProbe) { setByovStatus(null); return Promise.resolve(); }
    return getVideoGenRuntimeStatus(byovRuntime, { signal })
      .then((s) => { if (s) setByovStatus(s); })
      .catch(() => {});
  }, [byovRuntime, needsByovProbe]);
  useEffect(() => {
    if (!needsByovProbe) { setByovStatus(null); return; }
    const controller = new AbortController();
    refreshByovStatus(controller.signal);
    return () => controller.abort();
  }, [needsByovProbe, refreshByovStatus]);
  const byovRuntimeMissing = !!byovStatus && byovStatus.installed === false;
  // While the runtime-status probe is in flight (`needsByovProbe` is true but
  // we haven't received a response yet), `byovStatus` is null and
  // `byovRuntimeMissing` reads false — without this guard the user could
  // submit during that window and hit a venv-missing 500 before the install
  // banner appears. Gate Generate / Enqueue on the broader "BYOV not yet
  // confirmed ready" instead. The banner itself still keys on `byovRuntimeMissing`
  // (we don't want to flash "isn't installed yet" copy before we know).
  const byovGateBlocked = needsByovProbe && (byovStatus === null || byovStatus.installed === false);

  // Inline cache-status badge for the picked video model + the active text
  // encoder (a separate ~7-25 GB HF pull). Drives the "Available" / "Download"
  // affordance under the Model select, so users learn about the multi-GB
  // pull before hitting Render.
  const modelDownload = useModelDownloadStatus({ kind: 'video' });
  const modelStatus = modelId ? modelDownload.getStatus(modelId) : null;
  const textEncoderInfo = modelDownload.extra.textEncoder || null;
  const textEncoderStatus = textEncoderInfo
    ? (modelDownload.activeModelId === TEXT_ENCODER_DOWNLOAD_ID
      ? { ...textEncoderInfo, downloading: true, progress: modelDownload.progress }
      : textEncoderInfo)
    : null;

  // Weight-integrity (issue #1324). A corrupt/truncated model decodes to
  // garbled "mosaic" video that a clean re-download fixes; surface a Repair
  // banner keyed on the cheap structural check the status poll already ran so
  // the user can delete + re-fetch the bad files instead of debugging a render.
  const modelIntegrity = modelStatus && !modelStatus.downloading ? modelStatus.integrity : null;
  const integrityBad = modelIntegrity?.status === 'bad';
  const integrityBadCount = integrityBad ? (modelIntegrity.badFiles || []).length : 0;
  const integrityKey = integrityBad ? `${modelId}:${(modelIntegrity.badFiles || []).map((f) => f.name).join(',')}` : null;
  const [dismissedIntegrityKey, setDismissedIntegrityKey] = useState(null);
  const showIntegrityBanner = integrityBad && dismissedIntegrityKey !== integrityKey && !modelDownload.downloading;

  // Text-encoder integrity. The shared Gemma encoder is a separate HF repo, so a
  // corrupt encoder needs its own Repair banner — the model-keyed repair above
  // can't reach it (it isn't a listVideoModels() entry). Local-path encoders
  // report `integrity: null`, so this only fires for a damaged HF-cached encoder.
  const encoderIntegrity = textEncoderStatus && !textEncoderStatus.downloading ? textEncoderStatus.integrity : null;
  const encoderIntegrityBad = encoderIntegrity?.status === 'bad';
  const encoderIntegrityBadCount = encoderIntegrityBad ? (encoderIntegrity.badFiles || []).length : 0;
  const encoderIntegrityKey = encoderIntegrityBad ? `text-encoder:${(encoderIntegrity.badFiles || []).map((f) => f.name).join(',')}` : null;
  const [dismissedEncoderIntegrityKey, setDismissedEncoderIntegrityKey] = useState(null);
  const showEncoderIntegrityBanner = encoderIntegrityBad && dismissedEncoderIntegrityKey !== encoderIntegrityKey && !modelDownload.downloading;

  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;

  // Explicit px sizing — maxWidth + maxHeight + aspectRatio together resolves
  // inconsistently across browsers for mixed orientations.
  const previewBudget = 420;
  const previewRatio = (width > 0 && height > 0) ? width / height : 16 / 9;
  const previewWidth = previewRatio >= 1 ? previewBudget : Math.round(previewBudget * previewRatio);
  const previewHeight = previewRatio >= 1 ? Math.round(previewBudget / previewRatio) : previewBudget;

  // Run a single payload through the SSE pipeline. Returns a promise that
  // resolves when the job completes (or rejects on error / cancel). Shared
  // by the inline submit and the queue worker.
  //
  // Per-run abort token: the user can press Cancel during the brief window
  // between generateVideo() POST and its `.then()` resolving with a jobId.
  // Without a guard, the late `.then()` would still open an EventSource and
  // start applying SSE updates for a job the UI considers cancelled, AND
  // could clobber a queue item that's already advanced. handleCancel bumps
  // runTokenRef; runGeneration captures the token at start and ignores the
  // POST response (and any SSE messages) when the token no longer matches.
  const runGeneration = (payload) => new Promise((resolve, reject) => {
    // A new run owns no job yet — clear the previous run's id so a Cancel
    // racing the POST can't target a stale (completed) job.
    activeJobIdRef.current = null;
    setGenerating(true);
    setProgress({ progress: 0 });
    setStatusMsg('Starting...');
    setResult(null);
    setError(null);

    const myToken = ++runTokenRef.current;
    const isCurrent = () => myToken === runTokenRef.current;

    // Wrap settle so the cancel ref is cleared exactly once when the Promise
    // transitions to a final state — guarantees the queue worker's .finally()
    // always runs and stale rejects can't fire after a successful complete.
    const settleResolve = (value) => { runRejectRef.current = null; activeJobIdRef.current = null; resolve(value); };
    const settleReject = (err) => { runRejectRef.current = null; activeJobIdRef.current = null; reject(err); };
    runRejectRef.current = settleReject;

    generateVideo(payload).then((data) => {
      // The user cancelled while we were waiting for the POST to return —
      // don't open an EventSource at all, and don't touch any state. The
      // earlier handleCancel() already settled the Promise via runRejectRef.
      const jobId = data.jobId || data.generationId;
      if (!isCurrent()) {
        // The user cancelled while this POST was in flight — the job was
        // still created server-side, so cancel it by id now (handleCancel
        // couldn't: it had no id yet, and an unscoped cancel could have
        // killed an unrelated parallel render instead).
        if (jobId) cancelVideoGen(jobId).catch(() => {});
        return;
      }
      // Remember which job this run owns — with the cloud lane, video
      // renders are no longer single-flight, so Cancel must target exactly
      // this job instead of "the first running video" (which could be an
      // unrelated local or grok render).
      activeJobIdRef.current = jobId;
      attachJobEvents(jobId, { isCurrent, settleResolve, settleReject, withToast: true });
    }).catch((err) => {
      if (!isCurrent()) return;
      setError(err.message || 'Video generation failed');
      setGenerating(false);
      toast.error(err.message || 'Video generation failed');
      settleReject(err);
    });
  });

  // Client-side serial batch queue. Owns the queue state + worker effect;
  // the page supplies `generating` (parks the worker) and `runGeneration`
  // (runs one payload through the SSE pipeline).
  const {
    queue, enqueue, removeFromQueue, clearFinishedQueue, cancelRunning,
  } = useVideoGenQueue({ generating, runGeneration });

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    // Mirror the inline submit-button's disabled rules: blank prompt,
    // already generating, backend disconnected, or extend mode not ready.
    // Without these guards the user could press Enter in the prompt
    // textarea and fire a request the disabled button would otherwise
    // have prevented.
    if (!prompt.trim() || generating || (!isGrok && (notConnected || extendModeBlocked || a2vModeBlocked || icLoraModeBlocked || byovGateBlocked || keyframesBlocked))) return;
    await runGeneration(buildGeneratePayload()).catch(() => {});
  };

  const handleEnqueue = () => {
    // Mirror the Generate guard — a BYOV runtime that isn't installed yet
    // would silently queue a doomed job that fails late in the worker with
    // VENV_MISSING, hiding the installer banner from the user. Block at
    // enqueue time so the only path forward is the install banner above.
    if (!prompt.trim() || (!isGrok && (notConnected || extendModeBlocked || a2vModeBlocked || icLoraModeBlocked || byovGateBlocked || keyframesBlocked))) return;
    // useVideoGenQueue strips the File blobs into `_blobs` and snapshots the
    // rest as a stable summary for the queue UI.
    enqueue(buildGeneratePayload());
  };

  const handleCancel = async () => {
    // Bump the run token FIRST so any late `.then()` from the in-flight
    // generateVideo() POST sees a stale token and bails before opening an
    // EventSource for a job we've already declared cancelled.
    runTokenRef.current += 1;
    eventSourceRef.current?.close();
    // Only cancel by id. When the id isn't known yet (Cancel raced the
    // generation POST), skip the server call entirely — the POST's stale-
    // token branch cancels the freshly-created job by id when it lands.
    // An unscoped cancel here could kill an unrelated parallel render.
    if (activeJobIdRef.current) {
      await cancelVideoGen(activeJobIdRef.current).catch(() => {});
      activeJobIdRef.current = null;
    }
    setGenerating(false);
    setStatusMsg('Cancelled');
    // Settle the in-flight runGeneration Promise so the queue worker's
    // .finally() releases runningQueueId and the next pending item can run.
    // Without this the Promise would dangle and the worker would stay parked.
    if (runRejectRef.current) {
      const reject = runRejectRef.current;
      runRejectRef.current = null;
      reject(new Error('Cancelled'));
    }
    // Mark the running queue item errored + release the slot so the next
    // pending item can dispatch (no-op when nothing's queued).
    cancelRunning();
  };

  // `status.connected` reflects the LEGACY mlx_video pythonPath health. BYOV
  // runtimes (ltx2/wan22/hunyuan) resolve their own venv inside the service
  // layer, so a missing legacy pythonPath must NOT block them — gate only on
  // `byovRuntimeMissing` for those models. Without this, a user who installed
  // ONLY a BYOV runtime via the modal would stay stuck behind a "not
  // configured" error from the unrelated legacy probe.
  const notConnected = !!status && status.connected === false && !needsByovProbe;

  const canEnqueue = prompt.trim() && (isGrok || (!notConnected && !extendModeBlocked && !a2vModeBlocked && !byovGateBlocked && !keyframesBlocked));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        {status ? (
          <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
            status.connected
              ? 'border-port-success/40 bg-port-success/10 text-port-success'
              : 'border-port-error/40 bg-port-error/10 text-port-error'
          }`}>
            {status.connected ? (
              <><span className="w-2 h-2 rounded-full bg-port-success" /> {status.pythonPath || 'local Python'}</>
            ) : (
              <>
                <AlertTriangle className="w-3 h-3" />
                {status.reason || 'Local Python not configured — set one up below'}
              </>
            )}
          </span>
        ) : (
          <span className="text-gray-500">Checking…</span>
        )}
        <div className="flex items-center gap-1">
          <button
            onClick={refreshStatus}
            disabled={statusLoading}
            className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
            title="Refresh status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={openSettings}
            className="flex items-center gap-1.5 px-2 py-1 text-gray-300 hover:text-white border border-port-border rounded hover:bg-port-border/50"
            title="Video Gen settings"
          >
            <SettingsIcon className="w-3.5 h-3.5" /> Settings
          </button>
        </div>
      </div>

      <RuntimeFingerprint runtime={status?.runtime} />

      {status && status.connected === false && (() => {
        const missingCount = status.missingPackages?.length || 0;
        const hasPath = !!status.pythonPath;
        return (
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="mb-3">
              <h3 className="text-sm font-medium text-gray-200">
                {hasPath ? 'Install missing Python packages' : 'Set up Local Python'}
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {hasPath
                  ? `Your Python is selected (${status.pythonPath}), but ${missingCount} required ${missingCount === 1 ? "package isn't" : "packages aren't"} installed. Click "Install" below — PortOS will pip-install them into this interpreter.`
                  : 'Pick a Python 3.10+ interpreter — PortOS auto-detects venvs and conda installs and can install missing packages directly.'}
              </p>
            </div>
            <LocalSetupPanel
              pythonPath={status.pythonPath || ''}
              onPythonPathChange={handleSavePythonPath}
              onPackagesChanged={refreshStatus}
            />
          </div>
        );
      })()}

      {/* Backend switch — shown only when the user enabled Grok in Settings →
          Image Gen. Grok's image_to_video supports text (image-first) and
          image modes only, so switching to it snaps an unsupported mode back
          to the nearest one. */}
      {grokEnabled && (
        <div className="bg-port-card border border-port-border rounded-xl p-1 flex gap-1" role="group" aria-label="Video generation backend">
          {[{ id: 'local', label: 'Local' }, { id: 'grok', label: 'Grok' }].map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={backend === id}
              onClick={() => handleBackendChange(id)}
              className={`flex-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                backend === id ? 'bg-port-accent text-white shadow' : 'text-gray-400 hover:text-white hover:bg-port-border/40'
              }`}
              title={id === 'grok' ? 'Render via the Grok Build CLI (image_gen → image_to_video). Counts against your Grok plan.' : 'Render on this machine with the local runtimes.'}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Mode switch — segmented control above the form. Sets state that
          both the form rendering and the submit payload react to.
          Implemented as plain toggle buttons with `aria-pressed` rather than
          WAI-ARIA Tabs, since the mode-specific inputs aren't structured as
          tabpanels and we don't implement roving-tabindex/arrow-key focus. */}
      <div className="bg-port-card border border-port-border rounded-xl p-1 flex flex-wrap gap-1" role="group" aria-label="Video generation mode">
        {(isGrok ? MODES.filter((m) => m.id === 'text' || m.id === 'image') : MODES).map(({ id, label, icon: Icon, desc }) => {
          const active = mode === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => handleModeChange(id)}
              className={`flex-1 min-w-[120px] flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                active
                  ? 'bg-port-accent text-white shadow'
                  : 'text-gray-400 hover:text-white hover:bg-port-border/40'
              }`}
              title={desc}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      <form onSubmit={handleGenerate} className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
          {!isGrok && byovRuntimeMissing && (
            <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <strong className="font-semibold">{byovStatus.label}</strong> isn't installed yet.
                PortOS can fetch and install it from {byovStatus.repoUrl?.replace('https://', '')} (~5-15 min, multi-GB on first run).
              </div>
              <button
                type="button"
                onClick={() => setInstallModalOpen(true)}
                disabled={generating}
                className="self-start sm:self-auto whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 disabled:opacity-50"
              >
                <Sparkles size={14} />
                Install {byovStatus.label}
              </button>
            </div>
          )}
          {showIntegrityBanner && (
            <ModelRepairBanner
              message={<>
                <strong className="font-semibold">{currentModel?.name || modelId}</strong> has {integrityBadCount || 'corrupt'} damaged weight file{integrityBadCount === 1 ? '' : 's'} — renders may come out garbled.
                Repair deletes the bad file{integrityBadCount === 1 ? '' : 's'} and re-downloads clean copies.
              </>}
              repairLabel="Repair model"
              onRepair={() => { setDismissedIntegrityKey(integrityKey); modelDownload.repair(modelId); }}
              onDismiss={() => setDismissedIntegrityKey(integrityKey)}
              disabled={modelDownload.repairing || modelDownload.downloading}
              repairing={modelDownload.repairing}
            />
          )}
          {showEncoderIntegrityBanner && (
            <ModelRepairBanner
              message={<>
                The shared <strong className="font-semibold">text encoder</strong> ({textEncoderStatus?.repo}) has {encoderIntegrityBadCount || 'corrupt'} damaged weight file{encoderIntegrityBadCount === 1 ? '' : 's'} — renders may come out garbled.
                Repair deletes the bad file{encoderIntegrityBadCount === 1 ? '' : 's'} and re-downloads clean copies.
              </>}
              repairLabel="Repair encoder"
              onRepair={() => { setDismissedEncoderIntegrityKey(encoderIntegrityKey); modelDownload.repair(TEXT_ENCODER_DOWNLOAD_ID); }}
              onDismiss={() => setDismissedEncoderIntegrityKey(encoderIntegrityKey)}
              disabled={modelDownload.repairing || modelDownload.downloading}
              repairing={modelDownload.repairing}
            />
          )}
          <StylePresetPicker
            value={stylePreset?.id || ''}
            onChange={setStylePreset}
            disabled={generating}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormField label="Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
                placeholder="Describe the video you want to generate..."
              />
            </FormField>
            <FormField label="Negative Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <textarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                rows={3}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
                placeholder="What to avoid..."
              />
            </FormField>
          </div>

          {mode === 'fflf' && keyframesSupported && (
            <KeyframePanel
              keyframesMode={keyframesMode}
              keyframesActive={keyframesActive}
              keyframes={keyframes}
              numFrames={numFrames}
              visibleGallery={visibleGallery}
              keyframesError={keyframesError}
              onToggleMode={toggleKeyframesMode}
              onAddKeyframe={addKeyframe}
              onUpdateKeyframe={updateKeyframe}
              onRemoveKeyframe={removeKeyframe}
            />
          )}

          {(mode === 'image' || (mode === 'fflf' && !keyframesActive)) && (
            <div className={`grid gap-2 ${mode === 'fflf' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
              <FramePanel
                label={mode === 'fflf' ? 'First frame' : 'Source image'}
                file={sourceImageFile}
                upload={sourceImageUpload}
                uploadUrl={sourceUploadUrl}
                visibleGallery={visibleGallery}
                onPickGallery={pickSourceImage}
                onUpload={uploadSourceImage}
                onClear={clearSourceImage}
                alt="Source"
              />
              {mode === 'fflf' && (
                <FramePanel
                  label="Last frame"
                  file={lastImageFile}
                  upload={lastImageUpload}
                  uploadUrl={lastUploadUrl}
                  visibleGallery={visibleGallery}
                  onPickGallery={pickLastImage}
                  onUpload={uploadLastImage}
                  onClear={clearLastImage}
                  alt="End frame"
                  advisoryNote={{
                    text: 'Experimental — last frame is advisory.',
                    title: 'FFLF backend support is experimental — LTX/mlx_video uses the start frame and treats the last frame as advisory.',
                  }}
                  hint={{
                    text: 'Tip: use keyframes that share scene geometry — same camera, same subject. The model interpolates between them; unrelated images produce a visual cut.',
                    title: 'FFLF works best when the two frames depict the same scene with continuous geometry. Both runtimes (notapalindrome and dgrauet) benefit from this.',
                  }}
                />
              )}
            </div>
          )}

          {mode === 'a2v' && (
            <AudioPanel
              audioFile={audioFile}
              numFrames={numFrames}
              fps={fps}
              hasCompatibleModel={visibleModels.length > 0}
              onPick={setAudioFile}
              onClear={() => setAudioFile(null)}
            />
          )}

          {mode === 'extend' && (
            <ExtendPanel
              extendFromVideoId={extendFromVideoId}
              extendingFrame={extendingFrame}
              sourceImageFile={sourceImageFile}
              visibleHistory={visibleHistory}
              onPick={handleExtendPick}
            />
          )}

          {icModeActive && (
            <IcLoraPanel
              spec={icSpec}
              referenceFile={icReferenceFile}
              referenceVideoId={icReferenceVideoId}
              inFlightReferenceNames={icReferenceNames}
              visibleHistory={visibleHistory}
              referenceImageFiles={icReferenceImageFiles}
              visibleGallery={visibleGallery}
              onAddReferenceImage={addIcReferenceImage}
              onUpdateReferenceImage={updateIcReferenceImage}
              onRemoveReferenceImage={removeIcReferenceImage}
              icStrength={icStrength}
              icSkipStage2={icSkipStage2}
              width={width}
              height={height}
              weightStatus={modelDownload.getStatus(icSpec.mode)}
              hasCompatibleModel={visibleModels.length > 0}
              onPickFile={pickIcReferenceFile}
              onClearFile={() => pickIcReferenceFile(null)}
              onPickHistory={pickIcReferenceVideoId}
              onStrengthChange={setIcStrength}
              onSkipStage2Change={setIcSkipStage2}
              onDownloadWeight={() => modelDownload.start(icSpec.mode)}
              onCancelWeightDownload={modelDownload.cancel}
            />
          )}

          {isGrok ? (
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Clip length" labelClassName="block text-xs font-medium text-gray-400 mb-1">
                <select
                  value={grokDuration}
                  onChange={(e) => setGrokDuration(Number(e.target.value))}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                >
                  {GROK_VIDEO_DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
                </select>
              </FormField>
              <ResolutionField
                presets={VIDEO_RESOLUTIONS}
                width={width}
                height={height}
                onChange={handleResolutionChange}
                {...VIDEO_EDGE_BOUNDS}
                snapOnBlur
                note="Grok maps the size to its closest supported aspect ratio — exact pixel dimensions are chosen by the model."
              />
              <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
                Grok generates a base image first (or animates your source image in Image mode), then renders motion with its
                <code className="text-gray-400"> image_to_video </code> tool. Model, frames, and seed are chosen by Grok; renders count against your Grok plan.
              </p>
            </div>
          ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {models.length > 0 && (
              <FormField className="col-span-2 sm:col-span-3" label="Model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
                <ModelSelect
                  models={visibleModels}
                  value={modelId}
                  onChange={(e) => handleModelChange(e.target.value)}
                />
                {modelStatus && (
                  <ModelDownloadBadge
                    status={modelStatus}
                    onDownload={() => modelDownload.start(modelId)}
                    onCancel={modelDownload.cancel}
                    estimateLabel={deriveSizeEstimate(currentModel?.name)}
                  />
                )}
                {textEncoderStatus && (textEncoderStatus.cached === false || textEncoderStatus.downloading) && (
                  <div className="mt-1">
                    <p className="text-[10px] text-gray-500">Text encoder ({textEncoderStatus.repo}) is also required:</p>
                    <ModelDownloadBadge
                      status={textEncoderStatus}
                      onDownload={() => modelDownload.start(TEXT_ENCODER_DOWNLOAD_ID)}
                      onCancel={modelDownload.cancel}
                    />
                  </div>
                )}
              </FormField>
            )}

            {/* Video LoRAs — only on ltx2-runtime models (loraFamily non-null)
                and only when at least one video-family LoRA is installed
                (videoLoras is the strict ltx-video subset; see the hook). */}
            {loraFamily && videoLoras.length > 0 && (
              <div className="col-span-2 sm:col-span-3">
                <LoraPicker
                  availableLoras={videoLoras}
                  selected={selectedLoras}
                  onChange={setSelectedLoras}
                  currentRunnerFamily={loraFamily}
                  currentCompatKey={loraFamily}
                  onAppendTrigger={(triggers) => setPrompt((p) => {
                    const add = triggers.join(', ');
                    return p && p.trim() ? `${p}, ${add}` : add;
                  })}
                  disabled={generating}
                />
              </div>
            )}

            {/* LTX model that can't fuse LoRAs (quantized mlx_video — q4/q8) with
                compatible LoRAs on disk: explain the absence instead of hiding
                silently, and point at the models that CAN run them. */}
            {showLtxLoraUnsupportedHint && (
              <div className="col-span-2 sm:col-span-3 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning leading-snug">
                You have {installedVideoLoras.length} LTX video LoRA{installedVideoLoras.length === 1 ? '' : 's'} installed, but <strong className="font-semibold">{currentModel?.name}</strong> can't fuse LoRAs (its quantized <code>mlx_video</code> runtime isn't supported yet). Switch to the <strong className="font-semibold">LTX-2.3 Unified Beta</strong> (bf16) or an <strong className="font-semibold">LTX-2.3 dgrauet (Q4/Q8)</strong> model to use them.
              </div>
            )}

            {/* Preset dropdown + free-form custom W×H for exact I2V sizing beyond
                the preset list. The server accepts 64..2048 and rounds each dim
                DOWN to the 64-grid, so an off-grid size renders at the next-lower
                multiple of 64 — ResolutionField's blur-snap reflects that. */}
            <ResolutionField
              presets={VIDEO_RESOLUTIONS}
              width={width}
              height={height}
              onChange={handleResolutionChange}
              {...VIDEO_EDGE_BOUNDS}
              snapOnBlur
              note="Each edge 64–2048px; the server rounds each down to the nearest multiple of 64."
            />

          </div>
          )}

          {/* Sampler/output knobs live behind a closed-by-default disclosure so
              Generate stays above the fold — the sibling /media/image tab keeps
              only Model + Resolution inline for the same reason (issue #3279). */}
          {!isGrok && (
            <AdvancedParamsPanel
              mode={mode}
              currentModel={currentModel}
              numFrames={numFrames} onNumFramesChange={setNumFrames}
              chunks={chunks} onChunksChange={setChunks} keyframesActive={keyframesActive}
              fps={fps} onFpsChange={setFps}
              seed={seed} onSeedChange={setSeed} onRandomSeed={handleRandomSeed}
              steps={steps} onStepsChange={setSteps}
              guidanceScale={guidanceScale} onGuidanceScaleChange={setGuidanceScale}
              imageStrength={imageStrength} onImageStrengthChange={setImageStrength}
              tiling={tiling} onTilingChange={setTiling}
              disableAudio={disableAudio} onDisableAudioChange={setDisableAudio}
              noMusic={noMusic} onNoMusicChange={setNoMusic}
            />
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {generating ? (
              <button
                type="button"
                onClick={handleCancel}
                className="flex items-center gap-2 px-4 py-2 bg-port-error hover:bg-port-error/80 text-white text-sm font-medium rounded-lg min-h-[40px]"
              >
                <X className="w-4 h-4" /> Cancel
              </button>
            ) : (
              <button
                type="submit"
                disabled={!prompt.trim() || (!isGrok && (notConnected || extendModeBlocked || a2vModeBlocked || icLoraModeBlocked || byovGateBlocked || keyframesBlocked))}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg min-h-[40px]"
                title={
                  byovRuntimeMissing ? `${byovStatus?.label || byovRuntime} runtime is not installed — use the install banner above`
                    : byovGateBlocked ? `Checking ${byovRuntime} runtime status…`
                    : extendModeBlocked ? 'Pick a prior render and wait for the last frame to extract before generating'
                    : a2vModeBlocked ? (currentModel?.runtime !== 'ltx2'
                      ? 'a2v mode requires an ltx2-runtime model — pick one from the Model dropdown'
                      : 'Pick an audio file before generating')
                    : keyframesBlocked ? keyframesError
                    : undefined
                }
              >
                <Sparkles className="w-4 h-4" /> Generate
              </button>
            )}
            <button
              type="button"
              onClick={handleEnqueue}
              disabled={!canEnqueue}
              className="flex items-center gap-2 px-4 py-2 border border-port-border text-gray-200 hover:text-white hover:bg-port-border/40 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium rounded-lg min-h-[40px]"
              title="Add this configuration to the batch queue"
            >
              <ListPlus className="w-4 h-4" /> Add to queue
            </button>
            {progressPct != null && <span className="text-xs text-port-accent">{progressPct}%</span>}
            {(generating || error) && (
              <span className={`text-xs truncate ${error ? 'text-port-error' : 'text-gray-400'}`}>
                {error || statusMsg || 'Working...'}
              </span>
            )}
          </div>
        </div>

        <VideoPreviewPanel
          result={result}
          generating={generating}
          statusMsg={statusMsg}
          progressPct={progressPct}
          previewWidth={previewWidth}
          previewHeight={previewHeight}
        />
      </form>

      <BatchQueuePanel
        queue={queue}
        onRemove={removeFromQueue}
        onClear={clearFinishedQueue}
        summarize={(item) => (
          <>
            <span className="uppercase mr-2">{item.params.backend === 'grok' ? `grok ${item.params.mode}` : item.params.mode}</span>
            {item.params.width}×{item.params.height} · {item.params.backend === 'grok' ? `${item.params.grokDuration || GROK_VIDEO_DEFAULT_DURATION}s` : `${item.params.numFrames}f`}
          </>
        )}
      />

      <MediaJobsQueue kind="video" />

      <VideoGenGallery
        galleryVisible={galleryVisible}
        galleryHidden={galleryHidden}
        favoritesOnly={favoritesOnly}
        showHidden={showHidden}
        onToggleFavorites={() => setFavoritesOnly((v) => !v)}
        onToggleShowHidden={() => setShowHidden((s) => !s)}
        onPreview={setPreview}
        onContinue={handleContinueHistory}
        onUpscale={handleUpscaleHistory}
        onDelete={handleDeleteHistory}
        onToggleHidden={handleToggleHistoryHidden}
        getCardProps={getCardProps}
      />

      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={previewItems}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onContinue={(item) => handleContinueHistory(item.raw)}
        onRemix={(item) => item?.raw && handleRemixVideo(item.raw)}
      />

      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings" size="lg">
        <ImageGenTab />
      </Drawer>

      <RuntimeInstallModal
        open={installModalOpen}
        runtime={byovRuntime}
        label={byovStatus?.label}
        onClose={() => setInstallModalOpen(false)}
        onComplete={() => refreshByovStatus()}
      />
    </div>
  );
}
