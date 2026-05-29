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
 *
 * Batch queue: client-side serial executor. The form's "Add to queue" button
 * appends a job to the queue (preserving the current params). When no job is
 * actively generating, the head of the queue is dequeued and submitted via
 * the same generate path as the inline button — so SSE progress, history
 * refresh, and error handling are all reused.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import LocalSetupPanel from '../components/settings/LocalSetupPanel';
import RuntimeInstallModal from '../components/videoGen/RuntimeInstallModal';
import MediaCard from '../components/media/MediaCard';
import MediaPreview from '../components/media/MediaPreview';
import StylePresetPicker from '../components/media/StylePresetPicker';
import { normalizeVideo } from '../components/media/normalize';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import {
  Film, Sparkles, Settings as SettingsIcon, RefreshCw, AlertTriangle,
  Dice5, X, Upload, Type, Image as ImageIcon, GitBranch, ListPlus, Music,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import BatchQueuePanel from '../components/media/BatchQueuePanel';
import MediaJobsQueue from '../components/media/MediaJobsQueue';
import FavoritesFilterChip from '../components/media/FavoritesFilterChip';
import ModelSelect from '../components/ModelSelect';
import ModelDownloadBadge, { deriveSizeEstimate } from '../components/media/ModelDownloadBadge';
import { useModelDownloadStatus, TEXT_ENCODER_DOWNLOAD_ID } from '../hooks/useModelDownloadStatus';
import { useMediaCompletionRefresh } from '../hooks/useMediaCompletionRefresh';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import usePreviewRoute from '../hooks/usePreviewRoute';
import {
  getVideoGenStatus, generateVideo, cancelVideoGen,
  listVideoHistory, deleteVideoHistoryItem, setVideoHidden, extractLastFrame,
  upscaleVideo,
  listImageGallery,
  getSettings, updateSettings,
  getActiveVideoJob,
} from '../services/api';
import { randomSeed, safeParseJSON } from '../lib/genUtils';
import { VIDEO_RESOLUTIONS } from '../lib/videoGenResolutions';
import { VIDEO_TILING_OPTIONS, VIDEO_TILING_ENUM_SET } from '../lib/videoTilingOptions';
import { resolveResolutionLabel } from '../lib/imageGenResolutions';

// Values follow LTX-2's 8k+1 latent boundary so the model doesn't silently
// snap. 241 = 10s @ 24fps is the comfortable single-pass ceiling on 48 GB
// at standard widths; the higher options (265–481) push past that and may
// swap or OOM at 1280×704. For reliable clips longer than ~10s, use Extend
// mode (renders past a source video, conditioning on its full latent) —
// see the hint under the Frames dropdown.
const FRAME_OPTIONS = [25, 49, 73, 97, 121, 145, 169, 193, 217, 241, 265, 313, 361, 481];
const FPS_OPTIONS = [16, 24, 30];

const MODES = [
  { id: 'text',   label: 'Text',   icon: Type,       desc: 'Text-to-video' },
  { id: 'image',  label: 'Image',  icon: ImageIcon,  desc: 'Image-to-video (start frame)' },
  { id: 'fflf',   label: 'FFLF',   icon: GitBranch,  desc: 'First frame + last frame' },
  { id: 'extend', label: 'Extend', icon: Film,       desc: 'Continue from a prior render' },
  { id: 'a2v',    label: 'Audio',  icon: Music,      desc: 'Audio-to-video (audio drives motion + sync)' },
];

const newQueueId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const videoModelMemoryGb = (model) => {
  const explicit = Number(model?.memoryGb);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(model?.name || '').match(/~\s*(\d+(?:\.\d+)?)\s*GB/i);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

// Mode-compatibility predicate for the Model dropdown. a2v requires the
// ltx2 runtime (dgrauet's pipeline) — the legacy mlx_video pipeline has no
// audio-conditioned mode, and Wan/Hunyuan don't either. Server enforces the
// same rule in routes/videoGen.js (A2V_REQUIRES_LTX2); filtering client-side
// keeps the dropdown honest so the user can't pick a doomed model.
const isModelAllowedForMode = (model, mode) => {
  if (!model) return false;
  if (mode === 'a2v') return model.runtime === 'ltx2';
  return true;
};

const ImagePreview = ({ src, alt, label }) => (
  <div className="space-y-1">
    <img src={src} alt={alt} className="w-full max-h-48 object-contain rounded border border-port-border bg-port-bg" />
    <div className="text-[11px] text-gray-500 truncate">{label}</div>
  </div>
);

export default function VideoGen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const incomingSourceImage = searchParams.get('sourceImageFile');
  const incomingPrompt = searchParams.get('prompt');
  const incomingNegativePrompt = searchParams.get('negativePrompt');
  const incomingWidth = searchParams.get('w');
  const incomingHeight = searchParams.get('h');
  const settingsOpen = searchParams.get('settings') === '1';
  const openSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('settings', '1'); return n; });
  const closeSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('settings'); return n; });

  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [models, setModels] = useState([]);

  const [mode, setMode] = useState(incomingSourceImage ? 'image' : 'text');
  const [prompt, setPrompt] = useState(incomingPrompt || '');
  const [negativePrompt, setNegativePrompt] = useState(incomingNegativePrompt || '');
  const [stylePreset, setStylePreset] = useState(null);
  const [modelId, setModelId] = useState('');
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(512);
  const [numFrames, setNumFrames] = useState(121);
  const [fps, setFps] = useState(24);
  const [chunks, setChunks] = useState(1);
  const [steps, setSteps] = useState('');
  const [guidanceScale, setGuidanceScale] = useState('');
  const [imageStrength, setImageStrength] = useState('');
  const [seed, setSeed] = useState('');
  const [tiling, setTiling] = useState('auto');
  const [disableAudio, setDisableAudio] = useState(false);
  // "No music" appends a soundscape constraint at submit time. LTX-2
  // conditions audio on prompt text — adding "no music, no soundtrack"
  // pushes the model toward ambient/diegetic sound (footsteps, room tone)
  // and away from generated background music, which is hard to remove
  // cleanly in post. Source: phosphene LTX-2 prompting guide.
  const [noMusic, setNoMusic] = useState(false);
  const [sourceImageFile, setSourceImageFile] = useState(incomingSourceImage || null);
  const [sourceImageUpload, setSourceImageUpload] = useState(null);
  const [lastImageFile, setLastImageFile] = useState(null);
  const [lastImageUpload, setLastImageUpload] = useState(null);
  const [extendFromVideoId, setExtendFromVideoId] = useState('');
  const [extendingFrame, setExtendingFrame] = useState(false);
  // a2v mode — direct audio upload only (no gallery for audio yet). The File
  // is sent as multipart field name 'audioFile'; the server stages it under
  // data/uploads, then the python helper passes it to AudioToVideoPipeline.
  const [audioFile, setAudioFile] = useState(null);

  // Image gallery — used by both the start and end frame pickers so the
  // user can pull from any prior render in either slot.
  const [imageGallery, setImageGallery] = useState([]);

  // Re-sync when ImageGen pipes a new image via ?sourceImageFile=...
  useEffect(() => {
    if (incomingSourceImage) {
      setSourceImageFile(incomingSourceImage);
      setSourceImageUpload(null);
      setMode((m) => (m === 'text' ? 'image' : m));
    }
  }, [incomingSourceImage]);
  useEffect(() => {
    if (incomingPrompt) setPrompt(incomingPrompt);
  }, [incomingPrompt]);
  useEffect(() => {
    if (incomingNegativePrompt) setNegativePrompt(incomingNegativePrompt);
  }, [incomingNegativePrompt]);
  // When "Continue" pipes a video's last frame here, also sync the resolution
  // so the new render matches the source. Width/height get rounded to the
  // model's 64-pixel grid server-side, so off-grid sources still work.
  useEffect(() => {
    const w = Number(incomingWidth);
    const h = Number(incomingHeight);
    if (Number.isFinite(w) && w > 0) setWidth(w);
    if (Number.isFinite(h) && h > 0) setHeight(h);
  }, [incomingWidth, incomingHeight]);

  // Remix payload from MediaPreview (?modelId=…&numFrames=…&seed=…). Populate
  // form state once on mount, then strip the params so a hot-reload or back-
  // nav doesn't re-clobber edits the user has made since. Mirrors the
  // ImageGen remix-prefill effect.
  //
  // Gating: presence of any remix-only key (modelId / numFrames / fps / seed
  // / steps / guidanceScale / tiling / disableAudio) marks the URL as a Remix
  // bundle — the Continue and SendToVideo paths set sourceImageFile +/-
  // prompt/w/h but never the remix-only keys, so they keep their URL state.
  // When it IS a remix, we ALSO strip prompt/negativePrompt/w/h from the URL.
  // Note: prompt/negativePrompt are captured by initial useState (lines above);
  // w/h are NOT in initial state (defaults are 768×512) and are instead applied
  // by the separate incomingWidth/incomingHeight effect on first render —
  // which runs BEFORE this strip-pass since effects fire in declaration order.
  // The result is the same one-shot consumption, just via two effects.
  useEffect(() => {
    const remixGateKeys = ['modelId', 'numFrames', 'fps', 'seed', 'steps', 'guidanceScale', 'tiling', 'disableAudio'];
    const present = remixGateKeys.filter((k) => searchParams.get(k) != null);
    if (present.length === 0) return;
    const get = (k) => searchParams.get(k);
    if (get('modelId')) setModelId(get('modelId'));
    const nf = Number(get('numFrames'));
    if (Number.isFinite(nf) && nf > 0) setNumFrames(nf);
    const f = Number(get('fps'));
    if (Number.isFinite(f) && f > 0) setFps(f);
    if (get('seed') != null) setSeed(get('seed'));
    if (get('steps')) setSteps(get('steps'));
    // guidanceScale=0 is a meaningful value (CFG off); test for presence,
    // not truthiness, so "0" round-trips through Remix correctly.
    if (get('guidanceScale') != null && get('guidanceScale') !== '') setGuidanceScale(get('guidanceScale'));
    // tiling: URL params are user-controlled; only accept values defined in
    // VIDEO_TILING_OPTIONS so a hand-edited URL or stale link can't push the
    // <select> into an invalid state and 400 the next POST.
    const urlTiling = get('tiling');
    if (urlTiling && VIDEO_TILING_ENUM_SET.has(urlTiling)) setTiling(urlTiling);
    // disableAudio is a boolean; accept the common encodings a hand-edited URL
    // might carry ('1' from our own Remix builder, 'true' from a manual share).
    // Anything else (absent, '0', 'false', garbage) means "default off".
    const audioParam = (get('disableAudio') || '').toLowerCase();
    setDisableAudio(audioParam === '1' || audioParam === 'true');
    const stripKeys = [...remixGateKeys, 'prompt', 'negativePrompt', 'w', 'h'];
    setSearchParams((prev) => {
      const n = new URLSearchParams(prev);
      stripKeys.forEach((k) => n.delete(k));
      return n;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [history, setHistory] = useState([]);
  // `preview` is URL-driven via `usePreviewRoute(previewItems)` — declared
  // after `previewItems` below so the resolver can match against it.
  const [showHidden, setShowHidden] = useState(false);
  const navigate = useNavigate();

  // Object URLs for the currently-selected upload Files so we can render
  // real previews before the files ever hit the server. Revoked on change /
  // unmount so the blobs are released.
  const [sourceUploadUrl, setSourceUploadUrl] = useState(null);
  useEffect(() => {
    if (!(sourceImageUpload instanceof File)) { setSourceUploadUrl(null); return; }
    const url = URL.createObjectURL(sourceImageUpload);
    setSourceUploadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [sourceImageUpload]);
  const [lastUploadUrl, setLastUploadUrl] = useState(null);
  useEffect(() => {
    if (!(lastImageUpload instanceof File)) { setLastUploadUrl(null); return; }
    const url = URL.createObjectURL(lastImageUpload);
    setLastUploadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [lastImageUpload]);

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
    await deleteVideoHistoryItem(item.id).catch((err) => toast.error(err.message || 'Delete failed'));
    setHistory((h) => h.filter((v) => v.id !== item.id));
  };
  const handleToggleHistoryHidden = async (item) => {
    const nextHidden = !item.hidden;
    setHistory((h) => h.map((v) => (v.id === item.id ? { ...v, hidden: nextHidden } : v)));
    const result = await setVideoHidden(item.id, nextHidden).catch((err) => {
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
    const result = await upscaleVideo(item.id).catch((err) => {
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
    const { filename } = await extractLastFrame(item.id).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return {};
    });
    if (!filename) return;
    const params = new URLSearchParams({ sourceImageFile: filename });
    if (item?.width) params.set('w', String(item.width));
    if (item?.height) params.set('h', String(item.height));
    navigate(`/media/video?${params.toString()}`);
  };

  // Remix a prior render: hand all its params back into the form so the user
  // can iterate (tweak the prompt, swap seeds, etc.) without re-typing.
  // Mirrors ImageGen.handleRemix — in-page state set so the form jumps to
  // the new values without a navigation. The `item` is the raw video sidecar
  // (not the normalized MediaPreview shape).
  const handleRemixVideo = (item) => {
    if (!item) return;
    setStylePreset(null);
    // prompt: always set explicitly. Legacy entries can be missing `prompt`
    // (normalizeVideo surfaces them as '(no prompt)') — clear the form instead
    // of leaving whatever the user previously typed, matching the
    // useMediaPreviewActions.handleRemix '(no prompt)' filter.
    const nextPrompt = item.prompt && item.prompt !== '(no prompt)' ? item.prompt : '';
    setPrompt(nextPrompt);
    // negativePrompt: always set explicitly so remixing a clip with no
    // negative prompt clears any value the user previously typed. Skipping the
    // else-branch would leave stale form text and break the "round-trip
    // original settings" expectation.
    const neg = item.negativePrompt || item.negative_prompt || '';
    setNegativePrompt(neg);
    // Set modelId unconditionally when present. If models hasn't loaded yet
    // (race on initial mount), this avoids dropping the value silently — the
    // post-load validation effect (`Validate modelId once models are loaded`)
    // will fall back to defaultModel if the id doesn't end up in the catalog.
    if (item.modelId) setModelId(item.modelId);
    if (item.width) setWidth(item.width);
    if (item.height) setHeight(item.height);
    if (item.numFrames) setNumFrames(item.numFrames);
    if (item.fps) setFps(item.fps);
    if (item.seed != null) setSeed(String(item.seed));
    // steps/guidanceScale: always set explicitly. Legacy entries (created
    // before these were persisted) lack these fields — clear the form to the
    // empty-string sentinel rather than leaving the prior render's value
    // behind. The form treats '' as "use model default" so this is the
    // faithful round-trip for missing fields.
    setSteps(item.steps != null && item.steps !== '' ? String(item.steps) : '');
    const guidance = item.guidanceScale ?? item.guidance_scale ?? item.guidance;
    setGuidanceScale(guidance != null && guidance !== '' ? String(guidance) : '');
    // tiling must match the VIDEO_TILING_OPTIONS enum. Legacy sidecars sometimes
    // store a boolean here — silently ignore unknown values so the <select>
    // stays valid and the next POST doesn't 400.
    if (typeof item.tiling === 'string' && VIDEO_TILING_ENUM_SET.has(item.tiling)) setTiling(item.tiling);
    // disableAudio: always set explicitly (true/false) so the toggle reliably
    // matches the remixed render. Skipping the false branch would leave the
    // toggle stuck ON when the user remixes a clip that had audio enabled.
    const disableAudio = item.disableAudio ?? item.disable_audio;
    setDisableAudio(disableAudio === true);
    // Reset to text-to-video mode and clear any stale conditioning inputs from
    // image / fflf / extend / a2v modes. Without this, clicking Remix while
    // currently in (e.g.) image mode would carry the old source image into the
    // next submit even though Remix is meant to faithfully reproduce the prior
    // (text-to-video) render. Cross-page Remix already lands the user in text
    // mode because /media/video without `sourceImageFile` defaults that way.
    setMode('text');
    setSourceImageFile(null);
    setSourceImageUpload(null);
    setLastImageFile(null);
    setLastImageUpload(null);
    setExtendFromVideoId('');
    setAudioFile(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);
  // Hold the reject() of the in-flight runGeneration Promise so cancel can
  // settle it. Without this, handleCancel() closes the EventSource but the
  // outstanding Promise dangles forever — and the queue worker's .finally()
  // never runs, leaving runningQueueId stuck and freezing further dequeue.
  const runRejectRef = useRef(null);
  // Tracks the last stale modelId we already toasted about so the
  // validateModelId effect fires the "original model gone" toast exactly once
  // per unique stale id, even if the effect re-runs (e.g. models list updates).
  const staleModelToastRef = useRef(null);
  // Per-run abort token. Bumped at the start of each runGeneration() and
  // again on cancel; runGeneration captures the value at start and bails
  // when the token has moved on (e.g. POST resolves after cancel).
  const runTokenRef = useRef(0);

  // Batch queue. Each item snapshots the params at enqueue time so the user
  // can keep editing the form while jobs are in flight without affecting the
  // queued ones. The active generation is held in `generating`/`progress`;
  // `runningQueueId` (if set) marks which queued item it represents.
  const [queue, setQueue] = useState([]);
  const [runningQueueId, setRunningQueueId] = useState(null);

  const refreshStatus = useCallback(() => {
    setStatusLoading(true);
    getVideoGenStatus()
      .then((s) => {
        setStatus(s);
        setModels(s.models || []);
        if (s.defaultModel) setModelId((prev) => prev || s.defaultModel);
      })
      .catch(() => setStatus({ connected: false, reason: 'Status check failed' }))
      .finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    refreshStatus();
    return () => eventSourceRef.current?.close();
  }, [refreshStatus]);

  // SSE subscriber shared by the in-flight POST path and the mount-time
  // resume path. `withToast: false` on resume suppresses the success/error
  // toast — the user already saw it the first time and a page reload
  // shouldn't replay it.
  const attachJobEvents = (jobId, { isCurrent = () => true, settleResolve = () => {}, settleReject = () => {}, withToast = true } = {}) => {
    const es = new EventSource(`/api/video-gen/${jobId}/events`);
    eventSourceRef.current = es;
    es.onmessage = (ev) => {
      if (!isCurrent()) { es.close(); return; }
      const msg = safeParseJSON(ev.data);
      if (!msg) return;
      if (msg.type === 'queued') {
        setStatusMsg(typeof msg.position === 'number' ? `Queued (position ${msg.position})` : 'Queued');
      }
      if (msg.type === 'started') setStatusMsg('Starting render…');
      if (msg.type === 'status') setStatusMsg(msg.message);
      if (msg.type === 'progress') {
        setProgress({ progress: msg.progress });
        // A bare tqdm percentage shouldn't blank the STATUS line that just
        // preceded it; only overwrite when the progress event carries text.
        if (msg.message) setStatusMsg(msg.message);
      }
      if (msg.type === 'complete') {
        setResult(msg.result);
        setGenerating(false);
        setProgress({ progress: 1 });
        setStatusMsg('Complete');
        es.close();
        if (withToast) toast.success('Video generated');
        refreshHistory();
        settleResolve(msg.result);
      }
      if (msg.type === 'error') {
        setError(msg.error);
        setGenerating(false);
        es.close();
        if (withToast) toast.error(msg.error);
        settleReject(new Error(msg.error));
      }
      if (msg.type === 'canceled') {
        setGenerating(false);
        setStatusMsg(msg.reason || 'Canceled');
        es.close();
        if (withToast) toast(msg.reason || 'Render canceled');
        settleReject(new Error(msg.reason || 'Canceled'));
      }
    };
    es.onerror = () => {
      if (!isCurrent()) { es.close(); return; }
      setError('Lost connection to server');
      setGenerating(false);
      es.close();
      settleReject(new Error('Lost connection to server'));
    };
    return es;
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
      const p = job.params || {};
      if (p.prompt) setPrompt(p.prompt);
      if (p.negativePrompt) setNegativePrompt(p.negativePrompt);
      if (p.modelId) setModelId(p.modelId);
      if (p.width) setWidth(p.width);
      if (p.height) setHeight(p.height);
      if (p.numFrames) setNumFrames(p.numFrames);
      if (p.fps) setFps(p.fps);
      if (p.steps != null) setSteps(String(p.steps));
      if (p.guidanceScale != null) setGuidanceScale(String(p.guidanceScale));
      if (p.seed != null) setSeed(String(p.seed));
      if (p.tiling) setTiling(p.tiling);
      if (typeof p.disableAudio === 'boolean') setDisableAudio(p.disableAudio);
      if (p.mode) setMode(p.mode);
      if (p.chunks && p.chunks > 1) setChunks(p.chunks);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Settings PUT shallow-merges top-level keys, so the full imageGen slice
  // must round-trip — otherwise mode/external/codex/expose get clobbered.
  const handleSavePythonPath = useCallback(async (path) => {
    const current = await getSettings({ silent: true }).catch(() => ({}));
    const imageGen = current?.imageGen || {};
    await updateSettings(
      {
        imageGen: {
          ...imageGen,
          local: { ...(imageGen.local || {}), pythonPath: path || undefined },
        },
      },
      { silent: true },
    )
      .then(() => refreshStatus())
      .catch((err) => toast.error(`Failed to save: ${err.message}`));
  }, [refreshStatus]);

  // Models filtered to the current mode's compatibility. Drives the
  // <ModelSelect> options and the auto-select fallback so the user can't
  // land on a model the server will reject.
  const visibleModels = useMemo(
    () => models.filter((m) => isModelAllowedForMode(m, mode)),
    [models, mode],
  );

  // Validate `modelId` once models are loaded. Two failure modes covered:
  //  1. A Remix URL (or hand-edited link) carries a `modelId` that no longer
  //     exists in the catalog — <ModelSelect> shows nothing and `currentModel`
  //     is undefined, which then breaks resolution suggestions and submit.
  //  2. The picked model exists but isn't compatible with the current mode
  //     (e.g. switching into a2v while an mlx_video model is selected). The
  //     server would 400 on submit; we proactively swap to a compatible model.
  // a2v fallback preference: highest-memory model that fits this machine
  // (leaving headroom for the OS + text encoder) > the largest if none fit.
  // Other modes: status.defaultModel (if compatible) > first compatible model.
  useEffect(() => {
    if (!modelId || models.length === 0) return;
    const current = models.find((m) => m.id === modelId);
    const currentCompatible = current && isModelAllowedForMode(current, mode);
    if (currentCompatible) return;
    let fallback = '';
    if (mode === 'a2v') {
      // Reserve ~16 GB headroom for the OS + text encoder + working set.
      // Anything that fits within `systemMemoryGb - reserveGb` is "runnable"
      // on this machine; among those, pick the largest (highest quality).
      // If nothing fits (constrained box), fall back to the smallest model
      // so the user can at least try, and the install banner / OOM surfaces
      // the real constraint instead of a silent dropdown change.
      const reserveGb = 16;
      // typeof === 'number' (not `status?.systemMemoryGb ? ...`) so a server
      // legitimately reporting a tiny number (0 GB after rounding on a
      // sub-GB box) flows through the `fits` check and lands on the
      // smallest model. The truthiness shortcut would collapse 0 with
      // "absent" and pick the LARGEST model on a tiny machine.
      const budget = typeof status?.systemMemoryGb === 'number'
        ? Math.max(0, status.systemMemoryGb - reserveGb)
        : Number.POSITIVE_INFINITY;
      const sortedDesc = [...visibleModels].sort(
        (a, b) => videoModelMemoryGb(b) - videoModelMemoryGb(a),
      );
      const fits = sortedDesc.find((m) => videoModelMemoryGb(m) <= budget);
      fallback = (fits || sortedDesc[sortedDesc.length - 1])?.id || '';
    } else {
      const defaultModel = models.find((m) => m.id === status?.defaultModel);
      if (defaultModel && isModelAllowedForMode(defaultModel, mode)) {
        fallback = defaultModel.id;
      } else {
        fallback = visibleModels[0]?.id || status?.defaultModel || models[0]?.id || '';
      }
    }
    if (!fallback || fallback === modelId) return;
    // Toast only for the stale-id case (model removed from catalog). The
    // mode-incompatibility swap is expected behavior after a mode change —
    // no need to surface it. Name the destination model so users on a2v
    // don't think they landed on `status.defaultModel` (they may not have —
    // a2v picks the largest-fits model, which is often a dgrauet entry).
    if (!current && staleModelToastRef.current !== modelId) {
      staleModelToastRef.current = modelId;
      const fallbackName = models.find((m) => m.id === fallback)?.name || fallback;
      toast(`Original model "${modelId}" is no longer available — switched to "${fallbackName}"`);
    }
    setModelId(fallback);
  }, [modelId, models, status?.defaultModel, status?.systemMemoryGb, mode, visibleModels]);

  const currentModel = models.find((m) => m.id === modelId);

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
    return fetch(`/api/video-gen/setup/runtime-status?runtime=${encodeURIComponent(byovRuntime)}`, { signal })
      .then((r) => r.ok ? r.json() : null)
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

  const { matched: matchedResolution, label: resolutionLabel } = resolveResolutionLabel(VIDEO_RESOLUTIONS, width, height);
  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;

  // Explicit px sizing — maxWidth + maxHeight + aspectRatio together resolves
  // inconsistently across browsers for mixed orientations.
  const previewBudget = 420;
  const previewRatio = (width > 0 && height > 0) ? width / height : 16 / 9;
  const previewWidth = previewRatio >= 1 ? previewBudget : Math.round(previewBudget * previewRatio);
  const previewHeight = previewRatio >= 1 ? Math.round(previewBudget / previewRatio) : previewBudget;

  const handleResolutionChange = (e) => {
    const r = VIDEO_RESOLUTIONS.find((r) => r.label === e.target.value);
    if (r) { setWidth(r.w); setHeight(r.h); }
  };
  const handleRandomSeed = () => setSeed(randomSeed());

  const clearSourceImage = () => {
    setSourceImageFile(null);
    setSourceImageUpload(null);
    if (incomingSourceImage) {
      const next = new URLSearchParams(searchParams);
      next.delete('sourceImageFile');
      setSearchParams(next, { replace: true });
    }
  };
  const clearLastImage = () => {
    setLastImageFile(null);
    setLastImageUpload(null);
  };

  // Switching mode resets the now-irrelevant fields so a stale choice from
  // a prior mode can't sneak into the next generation. (Prompt/seed/etc.
  // carry over because they apply to all modes.)
  const handleModeChange = (next) => {
    setMode(next);
    // Audio is only meaningful in a2v mode — drop it on every other switch
    // so a stale upload from a prior pick doesn't sneak into a non-a2v post.
    if (next !== 'a2v') setAudioFile(null);
    if (next === 'text') {
      clearSourceImage();
      clearLastImage();
      setExtendFromVideoId('');
    } else if (next === 'image') {
      clearLastImage();
      setExtendFromVideoId('');
    } else if (next === 'fflf') {
      setExtendFromVideoId('');
    } else if (next === 'extend') {
      clearLastImage();
      // Drop any source image carried over from a prior mode — extend will
      // populate sourceImageFile fresh from the picked video's last frame
      // via handleExtendPick. Without this, switching from image/fflf into
      // extend leaves a stale source that gets silently submitted alongside
      // an empty extendFromVideoId.
      clearSourceImage();
    } else if (next === 'a2v') {
      // a2v takes audio only — buildGeneratePayload omits sourceImageFile +
      // sourceImage in this mode, so dropping them here keeps state honest
      // (no stale image survives in the form to imply it's being used).
      // The python helper supports an optional first-frame image, but the
      // UI doesn't expose it yet (see PR description "Out of scope"). Once
      // we add a gallery-pick path for the first frame, restore the source-
      // image state pass-through here.
      clearSourceImage();
      clearLastImage();
      setExtendFromVideoId('');
      // disableAudio strips the output audio track — in a2v mode that would
      // remove the user's uploaded audio, defeating the mode entirely.
      // noMusic appends a prompt constraint for text-conditioned audio gen;
      // a2v uses uploaded audio so the constraint is meaningless there too.
      setDisableAudio(false);
      setNoMusic(false);
      setChunks(1);
      // Auto-select to a compatible ltx2-runtime model is handled by the
      // modelId-validation effect, which re-runs on every mode change.
    }
  };

  // Extend mode: the user picks a prior video; we extract its last frame
  // (lazily — only when picked, since extraction shells out to ffmpeg) and
  // use that as the source image for image-to-video.
  //
  // The pick token guards against a slow-then-fast race: if the user picks
  // video A, then quickly switches to video B, A's extract response could
  // arrive after B's and overwrite sourceImageFile with the wrong frame.
  // Capture the token at request time and only apply the result when it
  // still matches the latest pick.
  const extendPickTokenRef = useRef(0);
  const handleExtendPick = async (videoId) => {
    // Bumping the token cancels any in-flight extract from a prior pick:
    // the awaited promise still resolves, but the result-application block
    // sees the mismatch and bails. Clearing the spinner here too means a
    // fast-clear (`videoId === ''`) doesn't strand the "Extracting…" UI
    // when an earlier extract is mid-flight.
    const token = ++extendPickTokenRef.current;
    setExtendFromVideoId(videoId);
    if (!videoId) {
      clearSourceImage();
      setExtendingFrame(false);
      return;
    }
    // ltx2 runtime: native ExtendPipeline conditions on the entire source
    // video's latent, so we DON'T need a last-frame PNG. Skip the ffmpeg
    // extract roundtrip — the route resolves the video id to a disk path
    // server-side. Saves ~1s per pick + avoids the i2v fallback when the
    // extract fails.
    if (currentModel?.runtime === 'ltx2') {
      setExtendingFrame(false);
      return;
    }
    setExtendingFrame(true);
    const res = await extractLastFrame(videoId).catch((err) => {
      toast.error(err.message || 'Failed to extract last frame');
      return null;
    });
    // Stale completion: a newer pick (or clear) is now authoritative. Do
    // nothing — the newer call already set/will set the spinner correctly,
    // and the clear-path above resets it on empty pick. Touching it from
    // the stale request could prematurely hide "Extracting…" while the
    // current pick (B) is still in flight after a fast pick A → pick B.
    if (token !== extendPickTokenRef.current) return;
    setExtendingFrame(false);
    if (res?.filename) {
      setSourceImageFile(res.filename);
      setSourceImageUpload(null);
    }
  };

  // Snapshot the current form into a generate-payload. Used both by the
  // inline Generate button and by enqueue, so the two paths stay in lockstep.
  const buildGeneratePayload = () => {
    const composed = composeStyledPrompt(prompt, negativePrompt, stylePreset);
    // Append "no music, no soundtrack" only when the toggle is on AND audio
    // generation is itself active — there's no point steering audio output
    // when audio is disabled outright. Idempotent: if the user already
    // typed "no music" we avoid double-appending.
    const promptOut = (noMusic && !disableAudio && !/no music/i.test(composed.prompt))
      ? `${composed.prompt}\n\nno music, no soundtrack`
      : composed.prompt;
    return {
      prompt: promptOut,
      negativePrompt: composed.negativePrompt,
      modelId,
      width, height,
      numFrames,
      fps,
      steps: steps || '',
      guidanceScale: guidanceScale || '',
      seed: seed || '',
      tiling,
      disableAudio: disableAudio ? 'true' : 'false',
      mode,
      imageStrength: imageStrength || '',
      // ltx2-extend bypasses the last-frame i2v path: we send the source
      // video's history id directly so the server resolves it to a disk
      // path and routes through ExtendPipeline. Legacy extend (mlx_video)
      // still uses sourceImageFile populated from extractLastFrame.
      sourceImageFile: (mode === 'image' || mode === 'fflf'
        || (mode === 'extend' && currentModel?.runtime !== 'ltx2'))
        ? (sourceImageFile || '') : '',
      sourceImage: (mode === 'image' || mode === 'fflf') ? (sourceImageUpload || '') : '',
      lastImageFile: mode === 'fflf' ? (lastImageFile || '') : '',
      lastImage: mode === 'fflf' ? (lastImageUpload || '') : '',
      extendFromVideoId: (mode === 'extend' && currentModel?.runtime === 'ltx2')
        ? (extendFromVideoId || '') : '',
      // Audio File goes through under the multipart field 'audioFile'. Server
      // routes it to the durable uploads dir and into the a2v helper.
      audioFile: mode === 'a2v' ? (audioFile || '') : '',
      chunks: mode !== 'a2v' && chunks > 1 ? chunks : '',
    };
  };

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
    const settleResolve = (value) => { runRejectRef.current = null; resolve(value); };
    const settleReject = (err) => { runRejectRef.current = null; reject(err); };
    runRejectRef.current = settleReject;

    generateVideo(payload).then((data) => {
      // The user cancelled while we were waiting for the POST to return —
      // don't open an EventSource at all, and don't touch any state. The
      // earlier handleCancel() already settled the Promise via runRejectRef.
      if (!isCurrent()) return;
      const jobId = data.jobId || data.generationId;
      attachJobEvents(jobId, { isCurrent, settleResolve, settleReject, withToast: true });
    }).catch((err) => {
      if (!isCurrent()) return;
      setError(err.message || 'Video generation failed');
      setGenerating(false);
      toast.error(err.message || 'Video generation failed');
      settleReject(err);
    });
  });

  // In Extend mode the source image is populated asynchronously after the
  // user picks a prior video — until that extraction lands, sourceImageFile
  // is empty and the request would silently fall back to T2V while still
  // sending mode='extend'. Block submit/enqueue until the extend frame is
  // actually ready (and unblocks the disabled state on the buttons too).
  // ltx2-extend doesn't need a frame extraction — the route resolves the
  // video id directly. Block only on extendFromVideoId being unset (and on
  // legacy runtime, also wait for the extracted frame).
  const extendModeBlocked = mode === 'extend' && (
    !extendFromVideoId
    || (currentModel?.runtime !== 'ltx2' && (extendingFrame || !sourceImageFile))
  );
  // a2v requires an audio upload AND an ltx2-runtime model — the legacy
  // mlx_video runtime has no audio-conditioned pipeline. Block submit when
  // either is missing so the request fails the form, not the worker.
  const a2vModeBlocked = mode === 'a2v' && (!audioFile || currentModel?.runtime !== 'ltx2');

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    // Mirror the inline submit-button's disabled rules: blank prompt,
    // already generating, backend disconnected, or extend mode not ready.
    // Without these guards the user could press Enter in the prompt
    // textarea and fire a request the disabled button would otherwise
    // have prevented.
    if (!prompt.trim() || generating || notConnected || extendModeBlocked || a2vModeBlocked || byovGateBlocked) return;
    await runGeneration(buildGeneratePayload()).catch(() => {});
  };

  const handleEnqueue = () => {
    // Mirror the Generate guard — a BYOV runtime that isn't installed yet
    // would silently queue a doomed job that fails late in the worker with
    // VENV_MISSING, hiding the installer banner from the user. Block at
    // enqueue time so the only path forward is the install banner above.
    if (!prompt.trim() || notConnected || extendModeBlocked || a2vModeBlocked || byovGateBlocked) return;
    const payload = buildGeneratePayload();
    // Strip File blobs for snapshot — re-using a File across multiple queued
    // submissions is fine, but we need a stable JSON-ish summary for the
    // queue UI display. Hold the Files in `_blobs` separately.
    const { sourceImage, lastImage, audioFile: audioBlob, ...summary } = payload;
    setQueue((q) => [...q, {
      id: newQueueId(),
      status: 'pending',
      params: summary,
      _blobs: {
        sourceImage: sourceImage instanceof File ? sourceImage : null,
        lastImage: lastImage instanceof File ? lastImage : null,
        audioFile: audioBlob instanceof File ? audioBlob : null,
      },
      enqueuedAt: Date.now(),
    }]);
    toast.success('Added to queue');
  };

  const removeFromQueue = (id) => {
    setQueue((q) => q.filter((item) => item.id !== id || item.status === 'running'));
  };
  // Drops both successful and errored items — the panel surfaces this as
  // "Clear finished" so the label matches the behavior.
  const clearFinishedQueue = () => {
    setQueue((q) => q.filter((item) => item.status !== 'complete' && item.status !== 'error'));
  };

  // Queue worker — pumps the head of the queue when nothing's running.
  // Runs as an effect so it picks up any newly-enqueued item even while
  // the user is interacting with the form.
  //
  // BUSY backoff: the server's `cancel()` keeps `activeProcess` set until
  // the SIGKILL'd child actually exits (up to ~8s), so a freshly-cancelled
  // item leaving the running slot here will often hit a 409 VIDEO_GEN_BUSY
  // when the worker tries to dispatch the next pending item. Treat that as
  // "not yet" (return the item to pending) instead of marking it errored.
  useEffect(() => {
    if (generating || runningQueueId) return;
    const next = queue.find((item) => item.status === 'pending');
    if (!next) return;
    setRunningQueueId(next.id);
    setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'running', startedAt: Date.now() } : item));
    const payload = { ...next.params };
    if (next._blobs?.sourceImage) payload.sourceImage = next._blobs.sourceImage;
    if (next._blobs?.lastImage) payload.lastImage = next._blobs.lastImage;
    if (next._blobs?.audioFile) payload.audioFile = next._blobs.audioFile;
    let busyRetry = false;
    let busyRetryTimer = null;
    runGeneration(payload).then((res) => {
      setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'complete', result: res } : item));
    }).catch((err) => {
      const isBusy = /already in progress|VIDEO_GEN_BUSY|409/i.test(err?.message || '');
      if (isBusy) {
        // Bounce the item back to pending after a short delay so the worker
        // re-tries once the server's previous child has finished cleaning up.
        busyRetry = true;
        setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'pending', startedAt: undefined } : item));
        busyRetryTimer = setTimeout(() => setRunningQueueId((curr) => (curr === next.id ? null : curr)), 1500);
        return;
      }
      setQueue((q) => q.map((item) => item.id === next.id ? { ...item, status: 'error', error: err.message } : item));
    }).finally(() => {
      // For the BUSY branch the timeout above releases the slot — releasing
      // it here too would let the worker immediately re-fire and hit the
      // same 409 before the server's old child has exited.
      if (!busyRetry) setRunningQueueId(null);
    });
    // Effect cleanup: cancel a pending BUSY-retry setTimeout when the
    // component unmounts (or before this effect re-runs). Without this, an
    // unmount during the 1.5s BUSY backoff would fire setRunningQueueId on
    // a torn-down component (React warning + leaked state).
    return () => { if (busyRetryTimer) clearTimeout(busyRetryTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, generating, runningQueueId]);

  const handleCancel = async () => {
    // Bump the run token FIRST so any late `.then()` from the in-flight
    // generateVideo() POST sees a stale token and bails before opening an
    // EventSource for a job we've already declared cancelled.
    runTokenRef.current += 1;
    eventSourceRef.current?.close();
    await cancelVideoGen().catch(() => {});
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
    if (runningQueueId) {
      setQueue((q) => q.map((item) => item.id === runningQueueId ? { ...item, status: 'error', error: 'Cancelled' } : item));
      setRunningQueueId(null);
    }
  };

  // `status.connected` reflects the LEGACY mlx_video pythonPath health. BYOV
  // runtimes (ltx2/wan22/hunyuan) resolve their own venv inside the service
  // layer, so a missing legacy pythonPath must NOT block them — gate only on
  // `byovRuntimeMissing` for those models. Without this, a user who installed
  // ONLY a BYOV runtime via the modal would stay stuck behind a "not
  // configured" error from the unrelated legacy probe.
  const notConnected = !!status && status.connected === false && !needsByovProbe;
  const canEnqueue = prompt.trim() && !notConnected && !extendModeBlocked && !a2vModeBlocked && !byovGateBlocked;

  // Symmetric frame picker for the FFLF + image modes. Each slot accepts
  // EITHER a gallery filename OR a fresh upload; the preview renders
  // whichever is currently set, and clearing either one snaps the slot back
  // to the dual upload+gallery picker. Defined inline because it closes
  // over imageGallery and the per-slot state — extracting it as a real
  // component would mean prop-drilling 6+ values for no real reuse.
  const renderFramePanel = ({
    label,
    file,
    upload,
    uploadUrl,
    onPickGallery,
    onUpload,
    onClear,
    alt,
    advisoryNote,
    hint,
  }) => {
    // Clear button shows as soon as the user picks anything (state-only).
    // Preview gates on `uploadUrl` instead of the raw `upload` File because
    // the object URL is generated in a useEffect — without this, the render
    // between "user picked a file" and "useEffect ran" would mount an
    // <img src={null}> for one frame.
    const hasSelection = !!(file || upload);
    const canPreview = !!(file || uploadUrl);
    return (
      <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-gray-400">{label}</span>
          {hasSelection && (
            <button type="button" onClick={onClear} className="text-[11px] text-port-error hover:underline">Clear</button>
          )}
        </div>
        {canPreview ? (
          <ImagePreview
            src={file ? `/data/images/${file}` : uploadUrl}
            alt={alt}
            label={file || upload?.name}
          />
        ) : (
          <div className="space-y-1.5">
            <select
              value=""
              onChange={(e) => onPickGallery(e.target.value || null)}
              aria-label={`${label} — pick from gallery`}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
            >
              <option value="">Pick from gallery…</option>
              {imageGallery.filter((img) => !img.hidden).slice(0, 50).map((img) => (
                <option key={img.filename} value={img.filename}>{img.filename}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer hover:text-white">
              <Upload className="w-3.5 h-3.5" />
              <span className="truncate">Upload an image</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => onUpload(e.target.files?.[0] || null)}
                className="hidden"
              />
            </label>
          </div>
        )}
        {advisoryNote && (
          <p className="text-[10px] text-gray-500 leading-snug" title={advisoryNote.title}>
            {advisoryNote.text}
          </p>
        )}
        {hint && (
          <p className="text-[10px] text-port-accent/80 leading-snug" title={hint.title}>
            {hint.text}
          </p>
        )}
      </div>
    );
  };

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

      {/* Mode switch — segmented control above the form. Sets state that
          both the form rendering and the submit payload react to.
          Implemented as plain toggle buttons with `aria-pressed` rather than
          WAI-ARIA Tabs, since the mode-specific inputs aren't structured as
          tabpanels and we don't implement roving-tabindex/arrow-key focus. */}
      <div className="bg-port-card border border-port-border rounded-xl p-1 flex flex-wrap gap-1" role="group" aria-label="Video generation mode">
        {MODES.map(({ id, label, icon: Icon, desc }) => {
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
          {byovRuntimeMissing && (
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
          <StylePresetPicker
            value={stylePreset?.id || ''}
            onChange={setStylePreset}
            disabled={generating}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
                placeholder="Describe the video you want to generate..."
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Negative Prompt</label>
              <textarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                rows={3}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
                placeholder="What to avoid..."
              />
            </div>
          </div>

          {(mode === 'image' || mode === 'fflf') && (
            <div className={`grid gap-2 ${mode === 'fflf' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
              {renderFramePanel({
                label: mode === 'fflf' ? 'First frame' : 'Source image',
                file: sourceImageFile,
                upload: sourceImageUpload,
                uploadUrl: sourceUploadUrl,
                onPickGallery: (filename) => {
                  // Switching to a gallery pick must drop any pending upload
                  // and the deep-link URL param; otherwise the next render
                  // would still POST the stale upload (req.files wins) while
                  // the preview shows the gallery image.
                  setSourceImageUpload(null);
                  if (incomingSourceImage) {
                    const next = new URLSearchParams(searchParams);
                    next.delete('sourceImageFile');
                    setSearchParams(next, { replace: true });
                  }
                  setSourceImageFile(filename);
                },
                onUpload: (file) => {
                  // Clear any gallery pick + URL param when an upload is
                  // chosen — otherwise the preview keeps rendering the old
                  // gallery image while the POST sends the upload.
                  if (file && (sourceImageFile || incomingSourceImage)) clearSourceImage();
                  setSourceImageUpload(file);
                },
                onClear: clearSourceImage,
                alt: 'Source',
              })}
              {mode === 'fflf' && renderFramePanel({
                label: 'Last frame',
                file: lastImageFile,
                upload: lastImageUpload,
                uploadUrl: lastUploadUrl,
                onPickGallery: (filename) => {
                  setLastImageUpload(null);
                  setLastImageFile(filename);
                },
                onUpload: (file) => {
                  if (file && lastImageFile) setLastImageFile(null);
                  setLastImageUpload(file);
                },
                onClear: clearLastImage,
                alt: 'End frame',
                advisoryNote: {
                  text: 'Experimental — last frame is advisory.',
                  title: 'FFLF backend support is experimental — LTX/mlx_video uses the start frame and treats the last frame as advisory.',
                },
                hint: {
                  text: 'Tip: use keyframes that share scene geometry — same camera, same subject. The model interpolates between them; unrelated images produce a visual cut.',
                  title: 'FFLF works best when the two frames depict the same scene with continuous geometry. Both runtimes (notapalindrome and dgrauet) benefit from this.',
                },
              })}
            </div>
          )}

          {mode === 'a2v' && (
            <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-gray-400">Audio (drives motion + sync)</span>
                {audioFile && (
                  <button type="button" onClick={() => setAudioFile(null)} className="text-[11px] text-port-error hover:underline">Clear</button>
                )}
              </div>
              {audioFile ? (
                <div className="flex items-center gap-2 text-[11px] text-gray-300">
                  <Music className="w-3.5 h-3.5 text-port-accent" />
                  <span className="truncate" title={audioFile.name}>{audioFile.name}</span>
                  <span className="text-gray-500">{(audioFile.size / 1024 / 1024).toFixed(2)} MB</span>
                </div>
              ) : (
                <label className="flex items-center gap-2 text-[11px] text-gray-400 cursor-pointer hover:text-white">
                  <Upload className="w-3.5 h-3.5" />
                  <span className="truncate">Upload audio (WAV / MP3 / M4A)</span>
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(e) => setAudioFile(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                </label>
              )}
              <p className="text-[10px] text-gray-500 leading-snug">
                Audio length should match {`${(numFrames / fps).toFixed(1)}s`} (frames ÷ fps). Longer clips are trimmed to fit; shorter clips fail.
              </p>
              {visibleModels.length === 0 && (
                <p className="text-[11px] text-port-warning">
                  a2v requires an ltx2-runtime model, but none are installed. Add a dgrauet entry to{' '}
                  <code>data/media-models.json</code> (or restore <code>ltx23_dgrauet_q4</code> / <code>_q8</code>{' '}
                  from the built-in defaults), then provision the runtime via{' '}
                  <code>INSTALL_LTX2=1 bash scripts/setup-image-video.sh</code>.
                </p>
              )}
            </div>
          )}

          {mode === 'extend' && (
            <div className="border border-port-border/50 rounded-lg p-2 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium text-gray-400">Continue from a prior render</span>
                {extendFromVideoId && (
                  <button type="button" onClick={() => handleExtendPick('')} className="text-[11px] text-port-error hover:underline">Clear</button>
                )}
              </div>
              <select
                value={extendFromVideoId}
                disabled={extendingFrame}
                onChange={(e) => handleExtendPick(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                <option value="">Pick a previous video…</option>
                {visibleHistory.slice(0, 50).map((v) => (
                  <option key={v.id} value={v.id}>
                    {(v.prompt || v.filename || v.id).slice(0, 80)}
                  </option>
                ))}
              </select>
              {extendingFrame && (
                <span className="text-[11px] text-gray-500">Extracting last frame…</span>
              )}
              {sourceImageFile && extendFromVideoId && !extendingFrame && (
                <ImagePreview
                  src={`/data/images/${sourceImageFile}`}
                  alt="Last frame"
                  label={`Starts from: ${sourceImageFile}`}
                />
              )}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {models.length > 0 && (
              <div className="col-span-2 sm:col-span-3">
                <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
                <ModelSelect
                  models={visibleModels}
                  value={modelId}
                  onChange={(e) => { setModelId(e.target.value); setSteps(''); setGuidanceScale(''); }}
                />
                {modelStatus && (
                  <ModelDownloadBadge
                    status={modelStatus}
                    onDownload={() => modelDownload.start(modelId)}
                    onCancel={modelDownload.cancel}
                    estimateLabel={deriveSizeEstimate(currentModel?.name)}
                  />
                )}
                {textEncoderStatus && textEncoderStatus.cached === false && (
                  <div className="mt-1">
                    <p className="text-[10px] text-gray-500">Text encoder ({textEncoderStatus.repo}) is also required:</p>
                    <ModelDownloadBadge
                      status={textEncoderStatus}
                      onDownload={() => modelDownload.start(TEXT_ENCODER_DOWNLOAD_ID)}
                      onCancel={modelDownload.cancel}
                    />
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Resolution</label>
              <select
                value={resolutionLabel}
                onChange={handleResolutionChange}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {!matchedResolution && (
                  <option value={resolutionLabel}>{`${width}×${height} (custom)`}</option>
                )}
                {VIDEO_RESOLUTIONS.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Frames</label>
              <select
                value={numFrames}
                onChange={(e) => setNumFrames(Number(e.target.value))}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {FRAME_OPTIONS.map((f) => <option key={f} value={f}>{f} ({(f / fps).toFixed(1)}s @ {fps}fps)</option>)}
              </select>
              {numFrames > 241 && (
                <p className="text-[10px] text-gray-500 leading-snug mt-1">
                  Past 241 frames a single-pass render may swap or OOM at 48 GB. For reliable longer clips, render up to ~10s and then use <strong>Extend</strong> on the result — it conditions on the source's full latent rather than a single last frame.
                </p>
              )}
            </div>

            {mode !== 'a2v' && (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1" title="Chain N renders end-to-end. Each chunk's last frame seeds the next, then they're stitched into one clip. Wall time scales linearly with chunks.">
                  Chunks
                </label>
                <select
                  value={chunks}
                  onChange={(e) => setChunks(Number(e.target.value))}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '1 (single)' : `${n} (~${((n * numFrames) / fps).toFixed(0)}s total)`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">FPS</label>
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  placeholder="Random"
                  className="flex-1 bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={handleRandomSeed}
                  className="p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
                  title="Randomize seed"
                >
                  <Dice5 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                Steps {currentModel?.steps && `(default: ${currentModel.steps})`}
              </label>
              <input
                type="number" min={1} max={150}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                placeholder={String(currentModel?.steps || 25)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                CFG Scale {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}
              </label>
              <input
                type="number" min={0} max={20} step={0.5}
                value={guidanceScale}
                onChange={(e) => setGuidanceScale(e.target.value)}
                placeholder={String(currentModel?.guidance ?? 3.0)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              />
            </div>

            {(mode === 'image' || (mode === 'extend' && currentModel?.runtime !== 'ltx2')) && (
              <div className="col-span-2 sm:col-span-3">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <label className="block text-xs font-medium text-gray-400">Image Strength</label>
                  <span className="text-[11px] text-gray-500">{imageStrength || '1.0'}</span>
                </div>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={imageStrength || 1}
                  onChange={(e) => setImageStrength(e.target.value)}
                  className="w-full accent-port-accent"
                  title="Higher values preserve the source frame more strongly"
                />
              </div>
            )}

            <div className="col-span-2 sm:col-span-3">
              <label className="block text-xs font-medium text-gray-400 mb-1">Tiling</label>
              <select
                value={tiling}
                onChange={(e) => setTiling(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {VIDEO_TILING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            {mode !== 'a2v' && (
              <label className="col-span-2 sm:col-span-3 flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                <input
                  type="checkbox"
                  checked={disableAudio}
                  onChange={(e) => setDisableAudio(e.target.checked)}
                  className="rounded"
                />
                Disable audio (LTX-2 only — speeds up generation)
              </label>
            )}
            {mode !== 'a2v' && (
              <label
                className={`col-span-2 sm:col-span-3 flex items-center gap-2 text-xs cursor-pointer ${disableAudio ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400'}`}
                title="LTX-2 conditions audio on the prompt — appending 'no music, no soundtrack' at submit time pushes the model toward ambient/diegetic sound only"
              >
                <input
                  type="checkbox"
                  checked={noMusic}
                  disabled={disableAudio}
                  onChange={(e) => setNoMusic(e.target.checked)}
                  className="rounded"
                />
                No music — keep ambient/diegetic sound only (LTX-2)
              </label>
            )}
          </div>

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
                disabled={!prompt.trim() || notConnected || extendModeBlocked || a2vModeBlocked || byovGateBlocked}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg min-h-[40px]"
                title={
                  byovRuntimeMissing ? `${byovStatus?.label || byovRuntime} runtime is not installed — use the install banner above`
                    : byovGateBlocked ? `Checking ${byovRuntime} runtime status…`
                    : extendModeBlocked ? 'Pick a prior render and wait for the last frame to extract before generating'
                    : a2vModeBlocked ? (currentModel?.runtime !== 'ltx2'
                      ? 'a2v mode requires an ltx2-runtime model — pick one from the Model dropdown'
                      : 'Pick an audio file before generating')
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

        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Preview</h2>
            {result && (
              <a
                href={result.path || `/data/videos/${result.filename}`}
                download
                className="text-xs text-port-accent hover:underline"
              >
                Download
              </a>
            )}
          </div>
          <div
            className="mx-auto bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative max-w-full"
            style={{ width: previewWidth, height: previewHeight }}
          >
            {result ? (
              // muted so the clip autoplays under the mobile media-engagement
              // policy (iOS/Android block unmuted autoplay outside a user
              // gesture — otherwise it just shows black); poster paints the
              // thumbnail while it buffers. Controls let the user unmute.
              <video
                src={result.path || `/data/videos/${result.filename}`}
                poster={result.thumbnail ? `/data/video-thumbnails/${result.thumbnail}` : undefined}
                controls
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                className="w-full h-full"
              />
            ) : generating ? (
              <div className="text-gray-500 text-xs flex flex-col items-center gap-1.5">
                <BrailleSpinner />
                <span>{statusMsg || 'Starting...'}</span>
              </div>
            ) : (
              <div className="text-gray-600 text-xs flex flex-col items-center gap-1.5">
                <Film className="w-8 h-8" />
                <span>Generated video will appear here</span>
              </div>
            )}
            {generating && progressPct != null && (
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            )}
          </div>
          {result && (
            <div className="text-xs text-gray-400 truncate">{result.filename}</div>
          )}
        </div>
      </form>

      <BatchQueuePanel
        queue={queue}
        onRemove={removeFromQueue}
        onClear={clearFinishedQueue}
        summarize={(item) => (
          <>
            <span className="uppercase mr-2">{item.params.mode}</span>
            {item.params.width}×{item.params.height} · {item.params.numFrames}f
          </>
        )}
      />

      <MediaJobsQueue kind="video" />

      {(galleryVisible.length > 0 || favoritesOnly) && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Recent renders ({Math.min(galleryVisible.length, 5)} of {galleryVisible.length})</h2>
            <div className="flex items-center gap-2">
              <FavoritesFilterChip active={favoritesOnly} onToggle={() => setFavoritesOnly((v) => !v)} />
              {galleryVisible.length > 5 && (
                <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>
              )}
            </div>
          </div>
          {galleryVisible.length === 0 ? (
            <div className="text-xs text-gray-500 py-3">No favorited videos yet.</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {galleryVisible.slice(0, 5).map((v) => {
                const item = normalizeVideo(v);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => setPreview(item)}
                    onContinue={() => handleContinueHistory(v)}
                    onUpscale={() => handleUpscaleHistory(v)}
                    onDelete={() => handleDeleteHistory(v)}
                    onToggleHidden={() => handleToggleHistoryHidden(v)}
                    {...getCardProps(item.key)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {galleryHidden.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <button
            type="button"
            onClick={() => setShowHidden((s) => !s)}
            className="flex items-center justify-between w-full text-xs font-medium text-gray-400 uppercase tracking-wide hover:text-white"
          >
            <span>{showHidden ? 'Hide' : 'Show'} hidden ({galleryHidden.length})</span>
            <span className="text-xs text-gray-500">{showHidden ? '▾' : '▸'}</span>
          </button>
          {showHidden && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {galleryHidden.map((v) => {
                const item = normalizeVideo(v);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => setPreview(item)}
                    onContinue={() => handleContinueHistory(v)}
                    onDelete={() => handleDeleteHistory(v)}
                    onToggleHidden={() => handleToggleHistoryHidden(v)}
                    {...getCardProps(item.key)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={previewItems}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onContinue={(item) => handleContinueHistory(item.raw)}
        onRemix={(item) => item?.raw && handleRemixVideo(item.raw)}
      />

      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings">
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
