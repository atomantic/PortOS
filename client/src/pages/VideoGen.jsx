/**
 * Video Generation page (LTX models via mlx_video on macOS, diffusers on
 * Windows), with local, Grok, and federated render targets.
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
 *             audio track) — LTX, or MiniMax H3 Ref2VA with an image
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
 * the rendering. The durable server queue owns queued work; each render target
 * drains through its own lane.
 *
 * "Add to queue" submits immediately to the durable server queue. That is
 * important for mixed-target work: a Grok submission can start in its cloud
 * lane while a local render occupies the GPU lane, and a federated peer owns
 * the queue for the work it receives.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { isAudioToVideoRuntime, isMiniMaxH3Runtime } from '../lib/runnerFamilies';
import { appendTriggerWords } from '../lib/loraTriggers';
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
import ModelDisclosure from '../components/videoGen/ModelDisclosure';
import ModelRepairBanner from '../components/videoGen/ModelRepairBanner';
import LiveVideoStage from '../components/videoGen/LiveVideoStage';
import { resolveVideoStagePreview, VIDEO_STAGE_KIND } from '../lib/videoStagePreview';
import VideoGenGallery from '../components/videoGen/VideoGenGallery';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import MediaPreview from '../components/media/MediaPreview';
import StylePresetPicker from '../components/media/StylePresetPicker';
import UniverseStylePicker from '../components/media/UniverseStylePicker';
import PromptEnhancer from '../components/media/PromptEnhancer';
import PromptFromMedia from '../components/media/PromptFromMedia';
import { normalizeVideo } from '../components/media/normalize';
import {
  Film, Sparkles, Settings as SettingsIcon, RefreshCw, AlertTriangle,
  X, Type, Image as ImageIcon, GitBranch, ListPlus, Music, SlidersHorizontal,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import MediaJobsQueue from '../components/media/MediaJobsQueue';
import ModelSelect from '../components/ModelSelect';
import { FormField } from '../components/ui/FormField';
import AutoSizeTextarea from '../components/ui/AutoSizeTextarea';
import ModelDownloadBadge, { deriveSizeEstimate } from '../components/media/ModelDownloadBadge';
import { useModelDownloadStatus, TEXT_ENCODER_DOWNLOAD_ID, textEncoderDownloadId } from '../hooks/useModelDownloadStatus';
import TextEncoderPicker from '../components/videoGen/TextEncoderPicker';
import { useMediaJobSse } from '../hooks/useMediaJobSse';
import { useMediaCompletionRefresh } from '../hooks/useMediaCompletionRefresh';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import usePreviewRoute from '../hooks/usePreviewRoute';
import useMediaPreviewActions from '../hooks/useMediaPreviewActions';
import { useVideoGenForm } from '../hooks/useVideoGenForm.js';
import { useFederatedMediaTarget } from '../hooks/useFederatedMediaTarget';
import RemoteMediaTargetPicker from '../components/federatedMedia/RemoteMediaTargetPicker';
import {
  getVideoGenStatus, generateVideo, cancelVideoGen,
  listVideoHistory, deleteVideoHistoryItem, setVideoHidden,
  upscaleVideo,
  patchSettingsSlice,
  getActiveVideoJob,
  getSettings,
  getVideoGenRuntimeStatus,
  listLorasFull,
} from '../services/api';
import LoraPicker from '../components/imageGen/LoraPicker';
import { VIDEO_RESOLUTIONS, resolutionOptionsForModel } from '../lib/videoGenResolutions';
import { GROK_VIDEO_DURATIONS } from '../lib/grokVideoClip.js';
import ResolutionField from '../components/media/ResolutionField';
import { VIDEO_EDGE_BOUNDS, videoEdgeBoundsForModel, IC_LORA_MODES } from '../lib/videoGenParams.js';
import { finishTargetForRecord, isDeliveryVideoModel } from '../lib/videoFinish.js';
import { peerModelRequiresInput } from '../lib/federatedMediaReadiness.js';
import { readCachedVideoGenStatus, writeCachedVideoGenStatus } from '../lib/videoGenStatusCache.js';
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

  // Paint the model picker from the previous /status answer while the live
  // probe runs. The cached entry carries `stale: true` and holds nothing but
  // the model-shaping fields (see lib/videoGenStatusCache.js); connectivity UI
  // below gates on `statusFresh`.
  const [status, setStatus] = useState(readCachedVideoGenStatus);
  const [statusLoading, setStatusLoading] = useState(true);
  // Grok Build CLI video backend (#2859 phase 2) — surfaced only when the
  // user enabled Grok in Settings → Image Gen (one toggle covers image +
  // video). 'local' keeps every existing flow untouched.
  const [grokEnabled, setGrokEnabled] = useState(false);
  // The jobId of the render this tab's Generate button currently owns —
  // threaded into cancelVideoGen so cancellation is job-scoped.
  const activeJobIdRef = useRef(null);
  const [models, setModels] = useState(() => status?.models || []);
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

  // Federated render target (#4348). Picking a peer replaces the local runtime
  // outright — the clip is rendered there and imported back — so it feeds the
  // payload builder rather than sitting beside it.
  const remoteTarget = useFederatedMediaTarget('video');
  // Every field the form submits, plus the payload builder both submit paths
  // share. See client/src/hooks/useVideoGenForm.js.
  const {
    backend, isGrok, handleBackendChange, grokDuration, setGrokDuration,
    mode, handleModeChange,
    prompt, setPrompt, envelopedPrompt, negativePrompt, setNegativePrompt, stylePreset, setStylePreset,
    selectedUniverse, setSelectedUniverse, remixModelFallback,
    modelId, handleModelChange, currentModel, visibleModels,
    loraFamily, videoLoras, loraUnavailableHint,
    selectedLoras, setSelectedLoras,
    width, height, handleResolutionChange,
    numFrames, setNumFrames, fps, setFps, chunks, setChunks,
    chunkPrompts, setChunkPromptAt, chainingActive,
    contextFrames, setContextFrames,
    steps, setSteps, guidanceScale, setGuidanceScale, imageStrength, setImageStrength,
    i2vReferenceMode, setI2vReferenceMode, referenceModeSupported, effectiveImageStrength,

    speedProfileId, setSpeedProfileId,
    draftDecode, setDraftDecode,
    seed, setSeed, handleRandomSeed, tiling, setTiling,
    textEncoderId, setTextEncoderId, textEncoderOptions,
    disableAudio, setDisableAudio, noMusic, setNoMusic,
    sourceImageFile, sourceImageUpload, sourceUploadUrl,
    pickSourceImage, uploadSourceImage, clearSourceImage,
    lastImageFile, lastImageUpload, lastUploadUrl,
    pickLastImage, uploadLastImage, clearLastImage, lastFrameIsAdvisory,
    keyframesMode, keyframes, keyframesSupported, keyframesActive, keyframesError, keyframesBlocked,
    toggleKeyframesMode, addKeyframe, updateKeyframe, removeKeyframe,
    extendFromVideoId, extendingFrame, handleExtendPick, extendModeBlocked,
    setAudioDurationSec,
    audioFile, setAudioFile, a2vDurationError, a2vModeBlocked,
    icSpec, icModeActive, icLoraModeBlocked,
    icReferenceFile, icReferenceVideoId, icReferenceNames, icReferenceImageFiles,
    pickIcReferenceFile, pickIcReferenceVideoId,
    addIcReferenceImage, updateIcReferenceImage, removeIcReferenceImage,
    icStrength, setIcStrength, icSkipStage2, setIcSkipStage2,
    applyRemix, applyFinish, applyResumedParams, buildGeneratePayload,
  } = useVideoGenForm({
    models, status, availableLoras, grokEnabled,
    remoteSubmissionFields: remoteTarget.isRemote ? remoteTarget.submissionFields : null,
  });

  // Conditioning the selected peer model cannot take. The server refuses a job
  // holding any of it (MEDIA_PROVIDER_INPUT_UNSUPPORTED) rather than silently
  // rendering something else, so the form says so before the user commits.
  // Nothing is cleared on picking a peer: the inputs stay filled and intact
  // for a switch back to This instance.
  //
  // Start and end FRAMES now cross when the model advertises the role (ADR
  // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1) — but only
  // as a GALLERY pick. An UPLOAD is still staged in the multipart temp dir when
  // the federated branch runs, so it is not a path the uploader can read; the
  // remedy is to save it to the gallery first, which is what the message says.
  //
  // The rest stay refused, each for a recorded reason: LoRA weights are a MODEL
  // (rule 3), and keyframes / a clip to extend / IC-LoRA references / chained
  // chunks are multi-step CHAIN STATE this machine sequences (rule 4).
  const remoteUnsupportedInputs = useMemo(() => {
    if (!remoteTarget.isRemote) return null;
    const model = remoteTarget.model;
    const present = [
      ['the Grok backend', isGrok],
      // Each remaining pipeline semantic has its own input listed below, but the
      // mode can be set before that input is filled — so gate the mode too
      // rather than letting an a2v render reach the peer as plain text-to-video.
      [`${mode} mode`, ![undefined, 'text', 'image', 'fflf'].includes(mode)],
      ['a source image', !!sourceImageFile && !remoteTarget.acceptsInput('sourceImage')],
      ['an end frame', !!lastImageFile && !remoteTarget.acceptsInput('lastImage')],
      ['an uploaded frame (save it to the gallery first)', !!sourceImageUpload || !!lastImageUpload],
      ['keyframes', keyframesActive],
      ['a source clip to extend', !!extendFromVideoId],
      ['an audio track', !!audioFile],
      ['IC-LoRA references', !!icReferenceFile || !!icReferenceVideoId || icReferenceImageFiles.length > 0],
      ['LoRA weights', selectedLoras.length > 0],
      ['chained chunks', chunks > 1],
    ].filter(([, set]) => set).map(([label]) => label);
    if (present.length) {
      return `The selected peer model cannot take ${present.join(', ')} — clear it to render on this peer.`;
    }
    // An end frame alone would render a plain text-to-video clip with the frame
    // silently discarded — a valid-looking render of a different thing.
    if (lastImageFile && !sourceImageFile) {
      return 'A federated first-last-frame render needs both ends — add a start frame, or render on this instance.';
    }
    if (peerModelRequiresInput(model) && !sourceImageFile) {
      return `${model?.modelName || 'The selected peer model'} renders only from a source image — add a start frame, or pick a text-to-video model.`;
    }
    return null;
  }, [remoteTarget.isRemote, remoteTarget.model, remoteTarget.acceptsInput, isGrok, mode, sourceImageFile, sourceImageUpload,
    lastImageFile, lastImageUpload, keyframesActive, extendFromVideoId, audioFile, icReferenceFile,
    icReferenceVideoId, icReferenceImageFiles, selectedLoras, chunks]);
  // One reading for the Generate button, the enqueue guard and the caption.
  const remoteBlocked = remoteTarget.isRemote
    ? (remoteTarget.blockedReason || remoteUnsupportedInputs)
    : null;
  const localResolutionOptions = resolutionOptionsForModel(currentModel);
  const localResolutionBounds = videoEdgeBoundsForModel(currentModel);

  // Every gallery-image slot on this page (both frame panels, each multi-keyframe
  // row, each IC-LoRA reference row) opens the SAME GalleryImagePicker modal the
  // Image Gen i2i form uses — a searchable thumbnail grid over the whole gallery.
  // `null` = closed; otherwise `{ kind, index? }` records which slot the pick
  // lands in, since one modal serves every slot.
  const [galleryPicker, setGalleryPicker] = useState(null);
  const handleGalleryPick = (item) => {
    const filename = item?.filename;
    if (!filename || !galleryPicker) return;
    const { kind, index } = galleryPicker;
    if (kind === 'source') pickSourceImage(filename);
    else if (kind === 'last') pickLastImage(filename);
    else if (kind === 'keyframe') updateKeyframe(index, { file: filename });
    else if (kind === 'icReference') updateIcReferenceImage(index, filename);
  };

  const [history, setHistory] = useState([]);
  // `preview` is URL-driven via `usePreviewRoute(previewItems)` — declared
  // after `previewItems` below so the resolver can match against it.
  const [showHidden, setShowHidden] = useState(false);

  const refreshHistory = useCallback(() => {
    listVideoHistory().then((items) => setHistory(Array.isArray(items) ? items : [])).catch(() => {});
  }, []);
  useMediaCompletionRefresh({ onVideoCompleted: refreshHistory });
  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const { visibleHistory, hiddenHistory } = useMemo(() => ({
    visibleHistory: history.filter((v) => !v.hidden),
    hiddenHistory: history.filter((v) => v.hidden),
  }), [history]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { annotations, updateAnnotation, getCardProps } = useMediaAnnotations();
  // "Continue" is the same action here as on every other media surface (extract
  // the last frame, open the form on it with the source's prompt), so it comes
  // from the shared hook rather than a page-local copy. It takes the normalized
  // shape — gallery callers hand over raw history records, so they normalize.
  const { handleContinue } = useMediaPreviewActions();
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
  const galleryVisibleItems = useMemo(() => galleryVisible.map(normalizeVideo), [galleryVisible]);
  const galleryHiddenItems = useMemo(() => galleryHidden.map(normalizeVideo), [galleryHidden]);
  const previewItems = useMemo(() => [
    ...galleryVisibleItems,
    ...(showHidden ? galleryHiddenItems : []),
  ], [galleryVisibleItems, galleryHiddenItems, showHidden]);
  const [preview, setPreview] = usePreviewRoute(previewItems);

  const handleDeleteHistory = useCallback(async (item) => {
    const raw = item?.raw || item;
    await deleteVideoHistoryItem(raw.id, { silent: true }).catch((err) => toast.error(err.message || 'Delete failed'));
    setHistory((h) => h.filter((v) => v.id !== raw.id));
  }, []);
  const handlePromptSaved = useCallback((item, prompt) => {
    const id = item?.id || item?.raw?.id;
    if (!id) return;
    setHistory((h) => h.map((v) => v.id === id
      ? { ...v, prompt: prompt === '(no prompt)' ? '' : prompt }
      : v));
  }, []);
  const handleToggleHistoryHidden = useCallback(async (item) => {
    const raw = item?.raw || item;
    const nextHidden = !raw.hidden;
    setHistory((h) => h.map((v) => (v.id === raw.id ? { ...v, hidden: nextHidden } : v)));
    const result = await setVideoHidden(raw.id, nextHidden, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to update visibility');
      setHistory((h) => h.map((v) => (v.id === raw.id ? { ...v, hidden: !nextHidden } : v)));
      return null;
    });
    if (result) toast.success(nextHidden ? 'Video hidden' : 'Video unhidden');
  }, []);
  // Keep the single-flight guard outside render state so the handler remains
  // stable for memoized cards while ffmpeg processes one upscale at a time.
  const upscalingRef = useRef(false);
  const handleUpscaleHistory = useCallback(async (item) => {
    const raw = item?.raw || item;
    if (upscalingRef.current) return;
    upscalingRef.current = true;
    toast.loading('Upscaling 2× — typically 10-30s…');
    const result = await upscaleVideo(raw.id, { silent: true }).catch((err) => {
      toast.error(err.message || 'Upscale failed');
      return null;
    });
    upscalingRef.current = false;
    if (result?.video) {
      setHistory((h) => [result.video, ...h]);
      toast.success('Upscaled 2×');
    }
  }, []);

  // Remix a prior render: hand all its params back into the form (the hook
  // owns the field-by-field restore) and scroll the form back into view.
  const handleRemixVideo = useCallback((item) => {
    const raw = item?.raw || item;
    if (!raw) return;
    applyRemix(raw);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [applyRemix]);

  // Finish a draft (#3696): same restore as Remix, but switched to the delivery
  // model the draft's registry entry declares. Prefill only — the user presses
  // Generate themselves.
  const resolveFinishTarget = useCallback((raw) => finishTargetForRecord(raw, models), [models]);
  // A model the finish graph names as a DELIVERY target always decodes on its
  // own decoder — the server declines a draft request there outright (#5423) —
  // so the decode picker shows Full and says why instead of offering a choice
  // that would be silently dropped. `applyFinish` already resets the value when
  // Finish switches models; this keeps the control honest when the user picks
  // the delivery model by hand.
  const deliveryModelSelected = isDeliveryVideoModel(currentModel, models);
  const handleFinishVideo = useCallback((raw, target) => {
    if (!raw || !target) return;
    applyFinish(raw, target.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [applyFinish]);
  const handleContinueVideo = useCallback((item) => handleContinue(item), [handleContinue]);
  const handleToggleFavorites = useCallback(() => setFavoritesOnly((value) => !value), []);
  const handleToggleShowHidden = useCallback(() => setShowHidden((value) => !value), []);

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState(null);
  // Main-stage preview state (#4588). `renderGeometry` is the server's
  // RESOLVED width/height — the form's values are what we asked for, and
  // videoGen snaps both edges down to the model's grid. Transient runner frames
  // are intentionally ignored: they are not useful for judging a video render.
  // `lastRender` is this session's finished clip, so the stage hands off to it
  // instead of going blank when the render lands.
  const [renderGeometry, setRenderGeometry] = useState(null);
  const [lastRender, setLastRender] = useState(null);
  const { attach, eventSourceRef } = useMediaJobSse('video');
  // Hold the reject() of the in-flight runGeneration Promise so cancel can
  // settle it. Without this, handleCancel() closes the EventSource but the
  // outstanding Promise dangles forever.
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
        writeCachedVideoGenStatus(s);
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
      onRenderMeta: (msg) => setRenderGeometry({ width: msg.width, height: msg.height }),
      onStatus: (msg) => setStatusMsg(msg.message),
      onProgress: (msg) => {
        setProgress({ progress: msg.progress });
        // A bare tqdm percentage shouldn't blank the STATUS line that just
        // preceded it; only overwrite when the progress event carries text.
        if (msg.message) setStatusMsg(msg.message);
      },
      onComplete: (msg) => {
        setGenerating(false);
        setProgress({ progress: 1 });
        setStatusMsg('Complete');
        // Hand the stage off from the conditioning media to the finished clip.
        if (msg.result) setLastRender(msg.result);
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
  // the progress line next to Generate. Server holds the job's last SSE payload,
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
      // The in-flight render's own geometry, not the form's — a reload has to
      // size the stage by what the server resolved.
      if (job.render) setRenderGeometry({ width: job.render.width, height: job.render.height });
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
  const usesSharedTextEncoder = currentModel?.runtime === 'mlx_video' || currentModel?.runtime === 'ltx2';
  const textEncoderInfo = modelDownload.extra.textEncoder || null;
  const textEncoderStatus = textEncoderInfo
    ? (modelDownload.activeModelId === TEXT_ENCODER_DOWNLOAD_ID
      ? { ...textEncoderInfo, downloading: true, progress: modelDownload.progress }
      : textEncoderInfo)
    : null;
  // Substitutable prompt conditioner (#4081). A built-in option ships inside
  // the model's own weights, so only a substitute has a download of its own to
  // track — and only then can it gate Generate.
  const selectedTextEncoder = textEncoderOptions.find((option) => option.id === textEncoderId) || null;
  // Non-null exactly when the selection has a download of its own — a built-in
  // conditioner ships inside the model's weights. Doubles as the "needs
  // weights" predicate so there's one derivation, not two.
  const textEncoderOptionDownloadId = selectedTextEncoder && !selectedTextEncoder.builtIn
    ? textEncoderDownloadId(selectedTextEncoder.id)
    : null;
  const textEncoderOptionStatus = textEncoderOptionDownloadId
    ? modelDownload.getStatus(textEncoderOptionDownloadId)
    : null;
  // Choosing a substitute IS the request for its weights: it is unusable until
  // resident and Generate is gated on it either way, so `startWhenIdle` turns
  // the pick into the pull (it owns waiting for the cache verdict, skipping an
  // already-downloaded one, and queueing behind an active download).
  //
  // Wired to the PICKER's onChange alone, deliberately — a Remix, a resumed
  // render, and the snap-to-stock on a model change all reach `setTextEncoderId`
  // too, and a multi-GB pull must follow a click the user just made rather than
  // a state restore. Passing null for a built-in option clears any queued pull.
  const { startWhenIdle: startEncoderWhenIdle } = modelDownload;
  const handleTextEncoderChange = useCallback((id) => {
    setTextEncoderId(id);
    const option = textEncoderOptions.find((entry) => entry.id === id);
    startEncoderWhenIdle(option && !option.builtIn ? textEncoderDownloadId(id) : null);
  }, [setTextEncoderId, textEncoderOptions, startEncoderWhenIdle]);
  const icWeightStatus = icSpec ? modelDownload.getStatus(icSpec.mode) : null;
  const modelWeightsBlocked = !isGrok
    && (statusLoading || !modelId || !currentModel || modelDownload.loading
      || modelStatus === null || modelStatus?.cached === false);
  const textEncoderWeightsBlocked = !isGrok && usesSharedTextEncoder
    && (modelDownload.loading || textEncoderStatus === null || textEncoderStatus?.cached === false);
  const icWeightsBlocked = !isGrok && icModeActive
    && (modelDownload.loading || icWeightStatus === null || icWeightStatus?.cached === false);
  const textEncoderOptionBlocked = !isGrok && !!textEncoderOptionDownloadId
    && (modelDownload.loading || textEncoderOptionStatus === null || textEncoderOptionStatus?.cached === false);
  const weightsGateBlocked = modelWeightsBlocked || textEncoderWeightsBlocked
    || textEncoderOptionBlocked || icWeightsBlocked;
  const activeWeightErrorIds = [
    modelId,
    usesSharedTextEncoder ? TEXT_ENCODER_DOWNLOAD_ID : null,
    textEncoderOptionDownloadId,
    icModeActive ? icSpec?.mode : null,
  ].filter(Boolean);
  const activeWeightError = activeWeightErrorIds.includes(modelDownload.lastError?.modelId)
    ? modelDownload.lastError
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

  // A substituted conditioner is a separate pinned file, so it gets the same
  // treatment: the model-keyed and shared-encoder repairs above can't reach it,
  // and a corrupt one degrades the render rather than failing it.
  const textEncoderOptionIntegrity = textEncoderOptionStatus && !textEncoderOptionStatus.downloading
    ? textEncoderOptionStatus.integrity
    : null;
  const textEncoderOptionIntegrityBad = textEncoderOptionIntegrity?.status === 'bad';
  const textEncoderOptionIntegrityBadCount = textEncoderOptionIntegrityBad ? (textEncoderOptionIntegrity.badFiles || []).length : 0;
  const textEncoderOptionIntegrityKey = textEncoderOptionIntegrityBad
    ? `${textEncoderOptionDownloadId}:${(textEncoderOptionIntegrity.badFiles || []).map((f) => f.name).join(',')}`
    : null;
  const [dismissedTextEncoderOptionIntegrityKey, setDismissedTextEncoderOptionIntegrityKey] = useState(null);
  const showTextEncoderOptionIntegrityBanner = textEncoderOptionIntegrityBad
    && dismissedTextEncoderOptionIntegrityKey !== textEncoderOptionIntegrityKey
    && !modelDownload.downloading;

  // IC-LoRA weights are independent downloads too. Keep their corruption
  // recovery on the originating Video Gen surface instead of requiring a CLI
  // cache purge or leaving the user with a disabled Generate button.
  const icIntegrity = icWeightStatus && !icWeightStatus.downloading ? icWeightStatus.integrity : null;
  const icIntegrityBad = icIntegrity?.status === 'bad';
  const icIntegrityBadCount = icIntegrityBad ? (icIntegrity.badFiles || []).length : 0;
  const icIntegrityKey = icIntegrityBad
    ? `${icSpec?.mode}:${(icIntegrity.badFiles || []).map((file) => file.name).join(',')}`
    : null;
  const [dismissedIcIntegrityKey, setDismissedIcIntegrityKey] = useState(null);
  const showIcIntegrityBanner = icIntegrityBad
    && dismissedIcIntegrityKey !== icIntegrityKey && !modelDownload.downloading;

  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;

  // What the main stage shows right now (#4588). Memoized because the stage
  // holds a pending descriptor by signature — a fresh object identity on every
  // keystroke in the prompt box would otherwise churn its hold/return guard.
  // Geometry prefers the server's resolved edges and falls back to the form's
  // (a queued job, or a runtime that never reports them).
  const extendSource = useMemo(
    () => (extendFromVideoId ? history.find((v) => v.id === extendFromVideoId) || null : null),
    [extendFromVideoId, history],
  );
  const stage = useMemo(() => resolveVideoStagePreview({
    generating,
    width: renderGeometry?.width ?? width,
    height: renderGeometry?.height ?? height,
    result: lastRender,
    extendSource,
    sourceImageFile, sourceUploadUrl,
    lastImageFile, lastUploadUrl,
    keyframes: keyframesActive ? keyframes : null,
  }), [
    generating, renderGeometry, width, height, lastRender, extendSource,
    sourceImageFile, sourceUploadUrl, lastImageFile, lastUploadUrl, keyframesActive, keyframes,
  ]);
  const showStage = generating || stage.kind !== VIDEO_STAGE_KIND.EMPTY;

  // Run a single payload through the SSE pipeline. Returns a promise that
  // resolves when the job completes (or rejects on error / cancel). The
  // separate queue-submit path below deliberately does not attach SSE: the
  // shared MediaJobsQueue is the live view for work submitted in parallel.
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
    setError(null);
    // Stale-job isolation: the previous run's geometry must not be shown as if
    // it belonged to this one. `lastRender` deliberately survives so the stage
    // keeps the finished clip until this run produces something of its own.
    setRenderGeometry(null);

    const myToken = ++runTokenRef.current;
    const isCurrent = () => myToken === runTokenRef.current;

    // Wrap settle so the cancel ref is cleared exactly once when the Promise
    // transitions to a final state and stale rejects can't fire after a
    // successful complete.
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

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    if (generating) {
      if (canEnqueue) await handleEnqueue();
      return;
    }
    if (!canEnqueue) return;
    // A capacity window expires on the clock, so an enabled button can already
    // be pointing at a lapsed peer — re-derive at the moment of commit and say
    // so, rather than letting the peer reject a render already paid for.
    if (!verifyRemoteTarget()) return;
    await runGeneration(buildGeneratePayload()).catch(() => {});
  };

  const verifyRemoteTarget = () => {
    if (!remoteTarget.isRemote) return true;
    const fresh = remoteTarget.verify();
    if (!fresh.ok) { toast.error(fresh.message); return false; }
    return true;
  };

  const handleEnqueue = async () => {
    // Mirror the Generate guard — a BYOV runtime that isn't installed yet
    // would silently queue a doomed job that fails late in the worker with
    // VENV_MISSING, hiding the installer banner from the user. Block at
    // enqueue time so the only path forward is the install banner above.
    if (!canEnqueue) return;
    // A capacity window expires on the clock, so re-check the selected peer at
    // the moment this queued job is committed. The server then owns the job,
    // including any multipart uploads, and the appropriate lane can start it
    // without waiting for this tab's active SSE render.
    if (!verifyRemoteTarget()) return;
    await generateVideo(buildGeneratePayload())
      .then((data) => {
        const position = Number.isInteger(data?.position) ? ` (position ${data.position})` : '';
        toast.success(`Queued${position}`);
      })
      .catch((err) => toast.error(err.message || 'Failed to queue video'));
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
    // Settle the in-flight runGeneration Promise so callers waiting on the
    // active render do not retain a dangling promise after cancellation.
    if (runRejectRef.current) {
      const reject = runRejectRef.current;
      runRejectRef.current = null;
      reject(new Error('Cancelled'));
    }
  };

  // `status.connected` reflects the LEGACY mlx_video pythonPath health. BYOV
  // runtimes resolve their own venv inside the service
  // layer, so a missing legacy pythonPath must NOT block them — gate only on
  // `byovRuntimeMissing` for those models. Without this, a user who installed
  // ONLY a BYOV runtime via the modal would stay stuck behind a "not
  // configured" error from the unrelated legacy probe.
  // A cached entry says nothing about python health, so the connectivity UI
  // waits for the live probe rather than reporting the interpreter state of
  // whenever the last visit happened.
  const statusFresh = !!status && !status.stale;
  // The Model field renders as soon as there is anything to say — the list, or
  // the fact that it is still being probed. Only a finished probe that named no
  // model at all takes the field away.
  const modelsLoading = models.length === 0;
  const modelFieldVisible = !modelsLoading || statusLoading;
  const notConnected = statusFresh && status.connected === false && !needsByovProbe;

  // A federated render answers to the PEER’s readiness, not to this machine’s
  // runtime gates — none of the local probes below describe the hardware it
  // will actually run on.
  const canEnqueue = prompt.trim() && (remoteTarget.isRemote
    ? remoteBlocked === null
    : (isGrok || (!notConnected && !extendModeBlocked
      && !a2vModeBlocked && !icLoraModeBlocked && !byovGateBlocked
      && !weightsGateBlocked && !keyframesBlocked)));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        {statusFresh ? (
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
              status.connected
                ? 'border-port-success/40 bg-port-success/10 text-port-success'
                : 'border-port-error/40 bg-port-error/10 text-port-error'
            }`}
            title={status.pythonPath || 'Local Python'}
          >
            {status.connected ? (
              <><span className="w-2 h-2 rounded-full bg-port-success" /> {status.pythonVersion ? `Python ${status.pythonVersion}` : 'Python'}</>
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
            title="Refresh status" aria-label="Refresh status"
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

      {showStage && (
        <LiveVideoStage
          descriptor={stage}
          generating={generating}
          progressPct={progressPct}
          statusMsg={statusMsg}
          error={error}
          // Hold while the lightbox is open — the user is watching a clip there,
          // and swapping the stage under it is exactly the theft this guards.
          held={!!preview}
        />
      )}

      <RuntimeFingerprint runtime={status?.runtime} />

      {statusFresh && status.connected === false && (() => {
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
                <strong className="font-semibold">{byovStatus.label}</strong> {byovStatus.upgradeAvailable ? 'has an update available.' : "isn't installed yet."}
                {' '}PortOS can {byovStatus.upgradeAvailable ? 'upgrade' : 'fetch and install'} it from {byovStatus.installSourceLabel || byovStatus.repoUrl?.replace('https://', '')} on demand.
              </div>
              <button
                type="button"
                onClick={() => setInstallModalOpen(true)}
                disabled={generating}
                className="self-start sm:self-auto whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 disabled:opacity-50"
              >
                <Sparkles size={14} />
                {byovStatus.upgradeAvailable ? 'Upgrade' : 'Install'} {byovStatus.label}
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
              onRepair={() => {
                setDismissedIntegrityKey(integrityKey);
                modelDownload.repair(modelId);
              }}
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
          {/* A substituted conditioner is its own multi-GB file, so a corrupt
              one needs its own Repair path — neither the model-keyed banner nor
              the shared-encoder one above can reach it. Same failure mode as a
              corrupt model: the render completes and comes out garbled. */}
          {showTextEncoderOptionIntegrityBanner && (
            <ModelRepairBanner
              message={<>
                The <strong className="font-semibold">{selectedTextEncoder?.label}</strong> text encoder has {textEncoderOptionIntegrityBadCount || 'corrupt'} damaged file{textEncoderOptionIntegrityBadCount === 1 ? '' : 's'} — renders may come out garbled.
                Repair deletes the bad file{textEncoderOptionIntegrityBadCount === 1 ? '' : 's'} and re-downloads a clean copy.
              </>}
              repairLabel="Repair text encoder"
              onRepair={() => {
                setDismissedTextEncoderOptionIntegrityKey(textEncoderOptionIntegrityKey);
                modelDownload.repair(textEncoderOptionDownloadId);
              }}
              onDismiss={() => setDismissedTextEncoderOptionIntegrityKey(textEncoderOptionIntegrityKey)}
              disabled={modelDownload.repairing || modelDownload.downloading}
              repairing={modelDownload.repairing}
            />
          )}
          {showIcIntegrityBanner && (
            <ModelRepairBanner
              message={<>
                The <strong className="font-semibold">{icSpec?.label || 'IC-LoRA'}</strong> weight has {icIntegrityBadCount || 'corrupt'} damaged file{icIntegrityBadCount === 1 ? '' : 's'}.
                Repair deletes the bad file{icIntegrityBadCount === 1 ? '' : 's'} and re-downloads a clean copy.
              </>}
              repairLabel={`Repair ${icSpec?.label || 'IC-LoRA'}`}
              onRepair={() => { setDismissedIcIntegrityKey(icIntegrityKey); modelDownload.repair(icSpec.mode); }}
              onDismiss={() => setDismissedIcIntegrityKey(icIntegrityKey)}
              disabled={modelDownload.repairing || modelDownload.downloading}
              repairing={modelDownload.repairing}
            />
          )}
          <UniverseStylePicker
            value={selectedUniverse?.id || ''}
            onChange={setSelectedUniverse}
          />
          <StylePresetPicker
            value={stylePreset?.id || ''}
            onChange={setStylePreset}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormField label="Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <AutoSizeTextarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 min-h-[80px]"
                placeholder="Describe the video you want to generate..."
              />
            </FormField>
            <FormField label="Negative Prompt" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <AutoSizeTextarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                disabled={!isGrok && currentModel?.supportsNegativePrompt === false}
                rows={3}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 min-h-[80px]"
                placeholder={!isGrok && currentModel?.supportsNegativePrompt === false
                  ? 'This CFG-distilled model does not use a negative prompt.'
                  : 'What to avoid...'}
              />
            </FormField>
          </div>

          {/* Keep Enhance live while a render is in flight so the next clip
              can be composed and submitted to its server queue. Generate
              itself becomes Cancel. */}
          <PromptEnhancer
            kind="video"
            prompt={prompt}
            setPrompt={setPrompt}
            negativePrompt={negativePrompt}
            setNegativePrompt={setNegativePrompt}
            renderConfig={{ stylePreset: stylePreset?.id, mode, model: modelId }}
          />

          {mode === 'fflf' && keyframesSupported && (
            <KeyframePanel
              keyframesMode={keyframesMode}
              keyframesActive={keyframesActive}
              keyframes={keyframes}
              numFrames={numFrames}
              keyframesError={keyframesError}
              onToggleMode={toggleKeyframesMode}
              onAddKeyframe={addKeyframe}
              onBrowseKeyframe={(index) => setGalleryPicker({ kind: 'keyframe', index })}
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
                onBrowseGallery={() => setGalleryPicker({ kind: 'source' })}
                onUpload={uploadSourceImage}
                onClear={clearSourceImage}
                alt="Source"
                advisoryNote={mode === 'image' && i2vReferenceMode === 'inspire' ? {
                  text: 'Inspire — frame one is generated from this, not copied.',
                  title: 'Inspire conditions the opening frame loosely, so the clip carries this image\u2019s subject and style without reproducing its exact pixels. Switch Reference mode to Anchor under Advanced to make it frame one.',
                } : null}
                hint={mode === 'image' && currentModel && !referenceModeSupported ? {
                  text: 'This model anchors the reference — it becomes frame one exactly.',
                  title: 'Only LTX-2.5 carries a per-image conditioning strength, which is what a loose (Inspire) reference needs. Every other runtime pins the supplied image as frame one.',
                } : null}
              />
              {mode === 'fflf' && (
                <FramePanel
                  label="Last frame"
                  file={lastImageFile}
                  upload={lastImageUpload}
                  uploadUrl={lastUploadUrl}
                  onBrowseGallery={() => setGalleryPicker({ kind: 'last' })}
                  onUpload={uploadLastImage}
                  onClear={clearLastImage}
                  alt="End frame"
                  advisoryNote={lastFrameIsAdvisory ? {
                    text: 'Experimental — last frame is advisory.',
                    title: `FFLF backend support is experimental — the ${currentModel?.runtime || 'selected'} runtime conditions on the start frame only and treats the last frame as advisory.`,
                  } : null}
                  hint={{
                    text: 'Tip: use keyframes that share scene geometry — same camera, same subject. The model interpolates between them; unrelated images produce a visual cut.',
                    title: 'FFLF works best when the two frames depict the same scene with continuous geometry. Both runtimes (notapalindrome and dgrauet) benefit from this.',
                  }}
                />
              )}
            </div>
          )}

          {mode === 'a2v' && (
            <div className="grid gap-3 lg:grid-cols-2">
              <FramePanel
                label={currentModel?.requiresSourceImageForA2v ? 'Reference image (required)' : 'Reference image (optional)'}
                file={sourceImageFile}
                upload={sourceImageUpload}
                uploadUrl={sourceUploadUrl}
                onBrowseGallery={() => setGalleryPicker({ kind: 'source' })}
                onUpload={uploadSourceImage}
                onClear={clearSourceImage}
                alt="Audio-to-video reference"
                hint={{
                  text: 'This image establishes the subject, composition, and opening geometry.',
                  title: currentModel?.arbitraryLengthAudio === true
                    ? 'MiniMax H3 Ref2VA combines the image with each audio window. PortOS carries the prior window\'s last frame forward to keep long renders continuous.'
                    : 'LTX-2.5 conditions frame one on this image while the uploaded audio drives motion and synchronization.',
                }}
              />
              <AudioPanel
                audioFile={audioFile}
                numFrames={numFrames}
                fps={fps}
                hasCompatibleModel={visibleModels.length > 0}
                audioDurationDriven={currentModel?.audioDurationDriven === true}
                arbitraryLengthAudio={currentModel?.arbitraryLengthAudio === true}
                maxReferenceAudioSeconds={currentModel?.maxReferenceAudioSeconds}
                maxDurationSeconds={currentModel?.audioDurationDriven === true
                  && currentModel?.arbitraryLengthAudio !== true
                  && Number(currentModel?.maxNumFrames) > 0
                  ? Number(currentModel.maxNumFrames) / Number(fps)
                  : null}
                durationError={a2vDurationError}
                onDurationChange={setAudioDurationSec}
                onPick={setAudioFile}
                onClear={() => setAudioFile(null)}
              />
            </div>
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
              onAddReferenceImage={addIcReferenceImage}
              onBrowseReferenceImage={(index) => setGalleryPicker({ kind: 'icReference', index })}
              onRemoveReferenceImage={removeIcReferenceImage}
              icStrength={icStrength}
              icSkipStage2={icSkipStage2}
              width={width}
              height={height}
              weightStatus={icWeightStatus}
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

          <RemoteMediaTargetPicker
            target={remoteTarget}
            kind="video"
            localBlockedReason={remoteUnsupportedInputs}
          />

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
            {/* The peer advertises its own models; the local list would name
                none of them, and a stale selection here must not read as the
                model that rendered the clip. Locally the field holds its place
                through the probe rather than popping into the form late. */}
            {modelFieldVisible && !remoteTarget.isRemote && (
              <FormField className="col-span-2 sm:col-span-3" label="Model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
                <ModelSelect
                  models={visibleModels}
                  value={modelId}
                  onChange={(e) => handleModelChange(e.target.value)}
                  loading={modelsLoading}
                />
                {remixModelFallback && (
                  <p className="mt-1 text-[11px] text-port-accent leading-snug" role="status">
                    {remixModelFallback.sourceName} {remixModelFallback.samplerLocked && remixModelFallback.negativePromptUnsupported
                      ? 'has fixed sampler controls and no negative prompt'
                      : remixModelFallback.samplerLocked
                        ? 'has fixed sampler controls'
                        : 'does not support a negative prompt'}. This remix is using {remixModelFallback.targetName} so its negative prompt, Steps, and CFG Scale remain editable.
                  </p>
                )}
                {modelStatus && (
                  <ModelDownloadBadge
                    status={modelStatus}
                    onDownload={() => modelDownload.start(modelId)}
                    onCancel={modelDownload.cancel}
                    estimateLabel={deriveSizeEstimate(currentModel?.name)}
                  />
                )}
                {activeWeightError && (
                  <div className="mt-2 rounded-lg border border-port-error/40 bg-port-error/10 px-3 py-2 text-[11px] text-port-error">
                    <p>{activeWeightError.message}</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      <button type="button" onClick={openSettings} className="underline hover:text-white">
                        Open Hugging Face settings
                      </button>
                      {activeWeightError.repo && (
                        <a
                          href={`https://huggingface.co/${activeWeightError.repo}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline hover:text-white"
                        >
                          Open repository access page
                        </a>
                      )}
                    </div>
                  </div>
                )}
                {modelDownload.statusError && (
                  <div className="mt-2 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-[11px] text-port-warning flex flex-wrap items-center justify-between gap-2">
                    <span>{modelDownload.statusError}</span>
                    <button type="button" onClick={modelDownload.refresh} className="underline hover:text-white">
                      Retry cache check
                    </button>
                  </div>
                )}
                {/* Prompt conditioner. Sits with the Model field rather than in
                    the collapsed Advanced panel: a substitute is its own
                    multi-GB pull and gates Generate, so its badge has to be
                    visible at the moment it's picked. Renders nothing unless
                    the model offers a real choice. */}
                <TextEncoderPicker
                  options={textEncoderOptions}
                  value={textEncoderId}
                  onChange={handleTextEncoderChange}
                  status={textEncoderOptionStatus}
                  onDownload={() => modelDownload.start(textEncoderOptionDownloadId)}
                  queued={modelDownload.queuedModelId === textEncoderOptionDownloadId}
                  onCancel={modelDownload.cancel}
                  disabled={generating}
                />
                {usesSharedTextEncoder && textEncoderStatus && (textEncoderStatus.cached === false || textEncoderStatus.downloading) && (
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

            {/* Video LoRAs — only on runtimes with a compatible video family
                (loraFamily non-null) and when at least one matching LoRA is
                installed (videoLoras is the strict family subset; see hook). */}
            {loraFamily && videoLoras.length > 0 && (
              <div className="col-span-2 sm:col-span-3">
                <LoraPicker
                  availableLoras={videoLoras}
                  selected={selectedLoras}
                  onChange={setSelectedLoras}
                  currentRunnerFamily={loraFamily}
                  currentCompatKey={loraFamily}
                  // Shared with ImageGen: skips a word already present rather than
                  // re-appending it, and judges presence against the ENVELOPED prompt
                  // (style preset + no-music suffix) — the exact text the server
                  // weaves against, so the button and the hint agree with the render.
                  onAppendTrigger={(triggers) => setPrompt((p) => appendTriggerWords(p, triggers, envelopedPrompt))}
                  // Grok payloads carry no LoRAs and never reach the local weave, so
                  // the hint would promise an append that cannot happen. `null`
                  // (not `''`) is the picker's "host didn't opt in" signal.
                  prompt={isGrok ? null : envelopedPrompt}
                  disabled={generating}
                />
              </div>
            )}

            {/* LTX model that can't fuse LoRAs (quantized mlx_video — q4/q8) with
                compatible LoRAs on disk: explain the absence instead of hiding
                silently, and point at the models that CAN run them. */}
            {loraUnavailableHint && (
              <div className="col-span-2 sm:col-span-3 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning leading-snug">
                {loraUnavailableHint.kind === 'ltx' ? (
                  <>You have {loraUnavailableHint.count} LTX video LoRA{loraUnavailableHint.count === 1 ? '' : 's'} installed, but <strong className="font-semibold">{currentModel?.name}</strong> can't fuse LoRAs (its quantized <code>mlx_video</code> runtime isn't supported yet). Switch to the <strong className="font-semibold">LTX-2.3 Unified Beta</strong> (bf16) or an <strong className="font-semibold">LTX-2.3 dgrauet (Q4/Q8)</strong> model to use them.</>
                ) : (
                  <>You have {loraUnavailableHint.count} MiniMax H3 LoRA{loraUnavailableHint.count === 1 ? '' : 's'} installed, but this H3 runtime did not pass PortOS's quantization-aware LoRA probe. Repair the <strong className="font-semibold">MiniMax H3</strong> runtime from the model setup panel, then retry.</>
                )}
              </div>
            )}

            {/* Preset dropdown + free-form custom W×H for exact I2V sizing beyond
                the preset list. Most runners use the shared 64px grid; models
                such as H3 declare their native 32px grid and trained presets. */}
            <ResolutionField
              presets={localResolutionOptions}
              width={width}
              height={height}
              onChange={handleResolutionChange}
              {...localResolutionBounds}
              snapOnBlur
              note={isMiniMaxH3Runtime(currentModel?.runtime)
                ? 'H3 quality presets follow its trained 768px short-edge, area-capped canvas. Smaller custom sizes are off-distribution but useful for faster wiring tests; each edge snaps to 32px.'
                : 'Each edge 64–2048px; the server rounds each down to the nearest multiple of 64.'}
            />

          </div>
          )}

          {/* Provenance / licensing / policy scope for the selected backend +
              model (#3674). Territory and Community License live here as
              facts — they do not block download or generate. */}
          <ModelDisclosure
            backend={backend}
            backendDisclosures={status?.backendDisclosures}
            model={isGrok ? null : currentModel}
            systemMemoryGb={status?.systemMemoryGb}
          />

          {!isGrok && (
            <AdvancedParamsPanel
              mode={mode}
              currentModel={currentModel}
              numFrames={numFrames} onNumFramesChange={setNumFrames}
              chunks={chunks} onChunksChange={setChunks} keyframesActive={keyframesActive}
              chunkPrompts={chunkPrompts} onChunkPromptChange={setChunkPromptAt} chainingActive={chainingActive}
              contextFrames={contextFrames} onContextFramesChange={setContextFrames}
              fps={fps} onFpsChange={setFps}
              seed={seed} onSeedChange={setSeed} onRandomSeed={handleRandomSeed}
              steps={steps} onStepsChange={setSteps}
              guidanceScale={guidanceScale} onGuidanceScaleChange={setGuidanceScale}
              speedProfileId={speedProfileId} onSpeedProfileChange={setSpeedProfileId}
              draftDecode={draftDecode} onDraftDecodeChange={setDraftDecode}
              draftDecodeLocked={deliveryModelSelected}
              imageStrength={imageStrength} onImageStrengthChange={setImageStrength}
              i2vReferenceMode={i2vReferenceMode} onI2vReferenceModeChange={setI2vReferenceMode}
              effectiveImageStrength={effectiveImageStrength}
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
                disabled={!canEnqueue}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg min-h-[40px]"
                title={
                  // A federated render is gated on the peer, so none of the
                  // local runtime remedies below apply to it.
                  remoteBlocked ? remoteBlocked
                    : byovRuntimeMissing ? `${byovStatus?.label || byovRuntime} runtime is not installed — use the install banner above`
                    : byovGateBlocked ? `Checking ${byovRuntime} runtime status…`
                    : modelWeightsBlocked ? 'Download the selected model weights before generating'
                    : textEncoderWeightsBlocked ? 'Download the shared text encoder before generating'
                    : textEncoderOptionBlocked ? `Download the ${selectedTextEncoder?.label || 'selected'} text encoder before generating`
                    : icWeightsBlocked ? `Download the ${icSpec?.label || 'IC-LoRA'} weight before generating`
                    : extendModeBlocked ? 'Pick a prior render and wait for the last frame to extract before generating'
                    : a2vModeBlocked ? (a2vDurationError || (!isAudioToVideoRuntime(currentModel?.runtime)
                      ? 'a2v mode requires an audio-to-video model — pick one from the Model dropdown'
                      : !audioFile ? 'Pick an audio file before generating'
                        : 'Pick a reference image before generating with this model'))
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
              title={canEnqueue ? 'Submit this configuration to its server queue; local, Grok, and remote lanes run independently'
                : icWeightsBlocked ? `Download the ${icSpec?.label || 'IC-LoRA'} weight before queueing`
                  : weightsGateBlocked ? 'Finish required model downloads before queueing'
                    : 'Complete the required inputs before queueing'}
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

        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
          <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Prompt from media</h2>
          <PromptFromMedia
            kindDefault="both"
            applyKind="video"
            setPrompt={setPrompt}
            setNegativePrompt={setNegativePrompt}
            alwaysOpen
          />
        </div>
      </form>

      <MediaJobsQueue kind="video" />

      <VideoGenGallery
        galleryVisible={galleryVisibleItems}
        galleryHidden={galleryHiddenItems}
        favoritesOnly={favoritesOnly}
        showHidden={showHidden}
        onToggleFavorites={handleToggleFavorites}
        onToggleShowHidden={handleToggleShowHidden}
        onPreview={setPreview}
        onRemix={handleRemixVideo}
        onContinue={handleContinueVideo}
        onUpscale={handleUpscaleHistory}
        onDelete={handleDeleteHistory}
        onToggleHidden={handleToggleHistoryHidden}
        getCardProps={getCardProps}
        finishTargetFor={resolveFinishTarget}
        onFinish={handleFinishVideo}
      />

      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={previewItems}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onPromptSaved={handlePromptSaved}
        onContinue={handleContinue}
        onRemix={(item) => item?.raw && handleRemixVideo(item.raw)}
      />

      <GalleryImagePicker
        open={!!galleryPicker}
        onClose={() => setGalleryPicker(null)}
        onSelect={handleGalleryPick}
      />

      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings" size="lg">
        <ImageGenTab />
      </Drawer>

      <RuntimeInstallModal
        open={installModalOpen}
        runtime={byovRuntime}
        label={byovStatus?.label}
        streamMethod="POST"
        onClose={() => setInstallModalOpen(false)}
        onComplete={() => {
          refreshByovStatus();
          // The capability probe is part of /video-gen/status's model
          // decoration. Refresh it after install/repair so H3's LoRA picker
          // and warning react without a manual page reload.
          refreshStatus();
        }}
      />
    </div>
  );
}
