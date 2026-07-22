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
import { useSearchParams, useNavigate } from 'react-router-dom';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import LocalSetupPanel from '../components/settings/LocalSetupPanel';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import FramePanel from '../components/videoGen/FramePanel';
import KeyframePanel from '../components/videoGen/KeyframePanel';
import AudioPanel from '../components/videoGen/AudioPanel';
import ExtendPanel from '../components/videoGen/ExtendPanel';
import RuntimeFingerprint from '../components/videoGen/RuntimeFingerprint';
import ModelRepairBanner from '../components/videoGen/ModelRepairBanner';
import VideoPreviewPanel from '../components/videoGen/VideoPreviewPanel';
import VideoGenGallery from '../components/videoGen/VideoGenGallery';
import MediaPreview from '../components/media/MediaPreview';
import StylePresetPicker from '../components/media/StylePresetPicker';
import { normalizeVideo } from '../components/media/normalize';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import {
  Film, Sparkles, Settings as SettingsIcon, RefreshCw, AlertTriangle,
  Dice5, X, Type, Image as ImageIcon, GitBranch, ListPlus, Music,
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
import { videoLoraFamily, VIDEO_LORA_FAMILIES } from '../lib/runnerFamilies';
import { randomSeed } from '../lib/genUtils';
import { VIDEO_RESOLUTIONS, snapAspectToImage } from '../lib/videoGenResolutions';
import { clampImageEdge } from '../lib/imageGenResolutions';
import ResolutionField from '../components/media/ResolutionField';
import { VIDEO_TILING_OPTIONS, VIDEO_TILING_ENUM_SET } from '../lib/videoTilingOptions';
import {
  FRAME_OPTIONS, FPS_OPTIONS, VIDEO_EDGE_BOUNDS,
  videoModelMemoryGb, computeFflfSafeFrames, isModelAllowedForMode,
} from '../lib/videoGenParams.js';

const MODES = [
  { id: 'text',   label: 'Text',   icon: Type,       desc: 'Text-to-video' },
  { id: 'image',  label: 'Image',  icon: ImageIcon,  desc: 'Image-to-video (start frame)' },
  { id: 'fflf',   label: 'FFLF',   icon: GitBranch,  desc: 'First frame + last frame' },
  { id: 'extend', label: 'Extend', icon: Film,       desc: 'Continue from a prior render' },
  { id: 'a2v',    label: 'Audio',  icon: Music,      desc: 'Audio-to-video (audio drives motion + sync)' },
];

export default function VideoGen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const incomingSourceImage = searchParams.get('sourceImageFile');
  const incomingPrompt = searchParams.get('prompt');
  const incomingNegativePrompt = searchParams.get('negativePrompt');
  const incomingWidth = searchParams.get('w');
  const incomingHeight = searchParams.get('h');
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
  const [backend, setBackend] = useState('local');
  const [grokDuration, setGrokDuration] = useState(6);
  const [models, setModels] = useState([]);
  const refreshGrokEnabled = useCallback(() => {
    getSettings({ silent: true })
      .then((sv) => setGrokEnabled(sv?.imageGen?.grok?.enabled === true))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshGrokEnabled(); }, [refreshGrokEnabled]);

  const [mode, setMode] = useState(incomingSourceImage ? 'image' : 'text');
  const [prompt, setPrompt] = useState(incomingPrompt || '');
  const [negativePrompt, setNegativePrompt] = useState(incomingNegativePrompt || '');
  const [stylePreset, setStylePreset] = useState(null);
  const [modelId, setModelId] = useState('');
  const [width, setWidth] = useState(768);
  const [height, setHeight] = useState(512);
  // Set once the size has been chosen deliberately — the user picking a preset,
  // or an explicit size arriving via Continue/Remix/restore. While it's false,
  // selecting an I2V source image auto-snaps W×H to the source's aspect ratio
  // (so the default frame doesn't cover-crop the subject). The snap itself does
  // NOT set this, so re-picking a different source still re-snaps until the user
  // takes the size into their own hands.
  const sizeManuallySetRef = useRef(false);
  const [numFrames, setNumFrames] = useState(121);
  const [fps, setFps] = useState(24);
  const [chunks, setChunks] = useState(1);
  const [steps, setSteps] = useState('');
  const [guidanceScale, setGuidanceScale] = useState('');
  const [imageStrength, setImageStrength] = useState('');
  const [seed, setSeed] = useState('');
  const [tiling, setTiling] = useState('auto');
  const [disableAudio, setDisableAudio] = useState(false);
  // Video LoRAs (ltx2 runtime only) — `{ filename, name, scale }` entries the
  // LoraPicker owns; `availableLoras` is the full installed library filtered
  // by the picker to the model's video family. See videoLoraFamily().
  const [availableLoras, setAvailableLoras] = useState([]);
  const [selectedLoras, setSelectedLoras] = useState([]);
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
  // Multi-keyframe FFLF (ltx2 runtime only): the user anchors 2–8 gallery
  // images at specific pixel-frame indices and the model interpolates between
  // them. This is a distinct server path from the legacy first/last pair
  // (the route rejects mixing the two) — `keyframesMode` flips fflf between
  // the two pickers. Each entry is { file, index } where file is a gallery
  // basename; the route resolves it to an absolute path. Keyframes are
  // gallery-only (no per-frame upload) because the route only accepts
  // gallery references for them.
  const [keyframesMode, setKeyframesMode] = useState(false);
  const [keyframes, setKeyframes] = useState([]);
  const [extendFromVideoId, setExtendFromVideoId] = useState('');
  const [extendingFrame, setExtendingFrame] = useState(false);
  // a2v mode — direct audio upload only (no gallery for audio yet). The File
  // is sent as multipart field name 'audioFile'; the server stages it under
  // data/uploads, then the python helper passes it to AudioToVideoPipeline.
  const [audioFile, setAudioFile] = useState(null);

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
    if (Number.isFinite(w) && w > 0) { setWidth(w); sizeManuallySetRef.current = true; }
    if (Number.isFinite(h) && h > 0) { setHeight(h); sizeManuallySetRef.current = true; }
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

  // Auto-snap the default W×H to a selected I2V source image's aspect ratio so
  // the server's cover-crop (force_original_aspect_ratio=increase,crop in
  // local.js#resizeImage) doesn't silently cut the subject out of a mismatched
  // frame. Only fires while the user hasn't taken the size into their own hands
  // (sizeManuallySetRef) — the inputs stay fully editable for power users, and
  // the server keeps its own 64-grid clamp. Gallery picks resolve to
  // /data/images/<file>; uploads reuse the object URL built above. The load is
  // async, so guard the apply against a newer pick (cancelled) and a late-
  // arriving manual size change (the ref re-check).
  useEffect(() => {
    if (sizeManuallySetRef.current) return;
    const src = sourceImageFile ? `/data/images/${sourceImageFile}` : sourceUploadUrl;
    if (!src) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled || sizeManuallySetRef.current) return;
      const snapped = snapAspectToImage(VIDEO_RESOLUTIONS, img.naturalWidth, img.naturalHeight);
      if (snapped) { setWidth(snapped.w); setHeight(snapped.h); }
    };
    img.src = src;
    return () => { cancelled = true; };
  }, [sourceImageFile, sourceUploadUrl]);

  const refreshHistory = useCallback(() => {
    listVideoHistory().then((items) => setHistory(Array.isArray(items) ? items : [])).catch(() => {});
  }, []);
  useMediaCompletionRefresh({ onVideoCompleted: refreshHistory });
  useEffect(() => { refreshHistory(); }, [refreshHistory]);
  useEffect(() => { listImageGallery().then(setImageGallery).catch(() => {}); }, []);
  // Installed LoRA library — the picker filters this to the current model's
  // video family (ltx-video). Silent: a failure just hides the picker.
  useEffect(() => { listLorasFull().then((l) => setAvailableLoras(Array.isArray(l) ? l : [])).catch(() => {}); }, []);
  // ?lora=<filename> preselects a video LoRA when the user clicks "Test" on a
  // video LoRA card in /media/loras. Mirrors the ImageGen ?lora= handoff:
  // defer until the library has loaded (for name/scale/triggers), append the
  // LoRA's trigger words, then strip the param so a refresh doesn't re-add it.
  useEffect(() => {
    const fromUrl = searchParams.get('lora');
    if (!fromUrl || !availableLoras.length) return;
    const match = availableLoras.find((l) => l.filename === fromUrl);
    if (match) {
      // A video (ltx-video) LoRA only renders on an ltx2 model. The default
      // video model is often mlx_video (e.g. ltx23_distilled_q4 on macOS), where
      // the picker is hidden and the payload omits the LoRA — so the Test
      // handoff would silently no-op. Switch to an available ltx2 model first.
      // Wait for `models` to load before deciding (the LoRA library usually
      // loads first); the mode is still the default 'text', with which every
      // ltx2 model is compatible, so the modelId-validation effect won't undo
      // this. A non-ltx2 LoRA needs no switch (the image picker tolerates it).
      const isVideoLora = (match.loraCompatKey || match.runnerFamily) === VIDEO_LORA_FAMILIES.LTX_VIDEO;
      const cur = models.find((m) => m.id === modelId);
      if (isVideoLora && !videoLoraFamily(cur)) {
        if (!models.length) return; // re-runs when models loads (in deps)
        const ltx2Model = models.find((m) => m.runtime === 'ltx2');
        if (ltx2Model) setModelId(ltx2Model.id);
      }
      setSelectedLoras((prev) => prev.find((s) => s.filename === fromUrl) ? prev : [...prev, {
        filename: match.filename,
        name: match.name,
        scale: typeof match.recommendedScale === 'number' ? match.recommendedScale : 1.0,
      }]);
      if (match.triggerWords?.length) {
        setPrompt((p) => { const add = match.triggerWords.join(', '); return p && p.trim() ? `${p}, ${add}` : add; });
      }
    }
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('lora'); return next; }, { replace: true });
  }, [availableLoras, models]);

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
    if (item.width) { setWidth(item.width); sizeManuallySetRef.current = true; }
    if (item.height) { setHeight(item.height); sizeManuallySetRef.current = true; }
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
    // Restore the LoRA picker from the render record. `item` here is the RAW
    // history record (the gallery passes `handleRemixVideo(item.raw)` and every
    // field above — prompt/modelId/width/… — is read off it directly), so the
    // LoRAs live on `item.loraFilenames`/`item.loraScales` (the parallel-array
    // contract the record is stamped with). Names resolve from the loaded
    // library, falling back to the filename. The picker self-hides when the
    // remixed model isn't ltx2, and the payload omits LoRAs there.
    if (Array.isArray(item.loraFilenames) && item.loraFilenames.length) {
      setSelectedLoras(item.loraFilenames.map((filename, i) => ({
        filename,
        name: availableLoras.find((a) => a.filename === filename)?.name || filename,
        scale: typeof item.loraScales?.[i] === 'number' ? item.loraScales[i] : 1.0,
      })));
    } else {
      setSelectedLoras([]);
    }
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
  // Tracks the last stale modelId we already toasted about so the
  // validateModelId effect fires the "original model gone" toast exactly once
  // per unique stale id, even if the effect re-runs (e.g. models list updates).
  const staleModelToastRef = useRef(null);
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
        if (s.defaultModel) setModelId((prev) => prev || s.defaultModel);
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
      const p = job.params || {};
      if (p.prompt) setPrompt(p.prompt);
      if (p.negativePrompt) setNegativePrompt(p.negativePrompt);
      if (p.modelId) setModelId(p.modelId);
      if (p.width) { setWidth(p.width); sizeManuallySetRef.current = true; }
      if (p.height) { setHeight(p.height); sizeManuallySetRef.current = true; }
      if (p.numFrames) setNumFrames(p.numFrames);
      if (p.fps) setFps(p.fps);
      if (p.steps != null) setSteps(String(p.steps));
      if (p.guidanceScale != null) setGuidanceScale(String(p.guidanceScale));
      if (p.seed != null) setSeed(String(p.seed));
      if (p.tiling) setTiling(p.tiling);
      if (typeof p.disableAudio === 'boolean') setDisableAudio(p.disableAudio);
      if (p.mode === 'grok') {
        // Grok job: 'grok' is the queue discriminator, not a semantic video
        // mode — restore the backend switch and the real t2v/i2v mode.
        setBackend('grok');
        setMode(p.videoMode === 'image' ? 'image' : 'text');
        if (p.duration) setGrokDuration(p.duration);
      } else if (p.mode) setMode(p.mode);
      if (p.chunks && p.chunks > 1) setChunks(p.chunks);
      // Multi-keyframe FFLF: the route maps the stored { path, index } back to
      // { file, index } (gallery basename) for us, so restore the picker
      // state directly. >= 2 mirrors the server's accept floor; flipping
      // keyframesMode on re-renders the multi-keyframe picker (the model was
      // ltx2 for the job to have keyframes, so keyframesSupported holds once
      // setModelId above resolves).
      if (Array.isArray(p.keyframes) && p.keyframes.length >= 2) {
        setKeyframes(p.keyframes.map((kf) => ({ file: kf.file, index: kf.index })));
        setKeyframesMode(true);
      }
      // Restore the LoRA picker — params carry { filename, scale } basenames;
      // resolve the display name from the loaded library (falls back to the
      // filename if the library hasn't loaded yet or the LoRA was deleted).
      if (Array.isArray(p.loras) && p.loras.length) {
        setSelectedLoras(p.loras.map((l) => ({
          filename: l.filename,
          name: availableLoras.find((a) => a.filename === l.filename)?.name || l.filename,
          scale: typeof l.scale === 'number' ? l.scale : 1.0,
        })));
      }
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

  // Video-LoRA family for the selected model — 'ltx-video' on ltx2, else null.
  // When null the picker is hidden and no LoRAs ride along on submit (the
  // route would 400 with LORAS_REQUIRE_LTX2). Derived, not state, so it tracks
  // the model dropdown without an effect.
  const loraFamily = videoLoraFamily(currentModel);
  // Strictly restrict the video picker to LoRAs whose family IS the video
  // family. The shared LoraPicker treats a missing compat key as "compatible"
  // (reasonable for image, where an unknown LoRA is usually still some image
  // family), but for video that would surface hand-dropped / pre-sidecar IMAGE
  // LoRAs — selecting one would send an incompatible adapter to the LTX
  // transformer (the route only checks file-exists + ltx2) and fail the render.
  // Video LoRAs always carry an explicit `ltx-video` family (HF import sets it),
  // so an exact-match filter here is the correct strict mode.
  const videoLoras = useMemo(
    () => (loraFamily
      ? availableLoras.filter((l) => (l.loraCompatKey || l.runnerFamily) === loraFamily)
      : []),
    [availableLoras, loraFamily],
  );

  // Installed LTX-video LoRAs regardless of the selected model's runtime. When
  // the user picks an LTX-2.x model whose runtime can't fuse LoRAs (a quantized
  // mlx_video model — loraFamily is null), the picker is correctly hidden, but
  // silently doing so reads as a bug. Use this to explain *why* the LoRA is
  // unavailable and point at the models that CAN run it. The `/ltx-?2/i` scope
  // matches the server's LTX-2.x capability family (see isMlxVideoLtxLoraCapable)
  // so the hint never fires for a non-LTX-2.x model where the advice wouldn't apply.
  const installedVideoLoras = useMemo(
    () => availableLoras.filter(
      (l) => (l.loraCompatKey || l.runnerFamily) === VIDEO_LORA_FAMILIES.LTX_VIDEO,
    ),
    [availableLoras],
  );
  // Gated on the quantized-mlx_video case specifically (runtime mlx_video +
  // loraFamily null = a quantized LTX-2.x model) so the hint copy's "quantized
  // runtime isn't supported yet" wording always matches what triggered it.
  const showLtxLoraUnsupportedHint = !loraFamily && installedVideoLoras.length > 0
    && currentModel?.runtime === 'mlx_video'
    && /ltx-?2/i.test(`${currentModel?.id || ''} ${currentModel?.repo || ''} ${currentModel?.name || ''}`);

  // Multi-keyframe availability + validation. Keyframes are an ltx2-runtime
  // primitive (the route 400s with KEYFRAMES_REQUIRE_LTX2 otherwise), so the
  // picker only offers itself when the selected model runs on ltx2. Mirror
  // the server's accept rules (server/routes/videoGen.js ~line 574) so the
  // form blocks before a doomed POST: 2–8 entries, each pinned to a gallery
  // file, indices strictly ascending and within [0, numFrames-1].
  const keyframesSupported = currentModel?.runtime === 'ltx2';
  const keyframesActive = mode === 'fflf' && keyframesMode && keyframesSupported;
  // The worker clamps FFLF/ltx2 numFrames down to fit a pixel-frame budget that
  // depends on resolution, so at default 768×512 the real frame ceiling is far
  // below numFrames. Compute the same cap the server enforces so the picker can
  // gate indices (and the auto-seed) against it. Falls back to numFrames when
  // the budget hasn't loaded yet (server still enforces the real cap).
  const maxSafeFrames = useMemo(
    () => computeFflfSafeFrames(width, height, numFrames, status?.fflfLtx2PixelBudget),
    [width, height, numFrames, status?.fflfLtx2PixelBudget],
  );
  const keyframesError = useMemo(() => {
    if (!keyframesActive) return null;
    if (keyframes.length < 2) return 'Add at least 2 keyframes.';
    if (keyframes.length > 8) return 'Use at most 8 keyframes.';
    let prev = -1;
    for (let i = 0; i < keyframes.length; i++) {
      const kf = keyframes[i];
      if (!kf.file) return `Keyframe ${i + 1} needs a gallery image.`;
      if (!Number.isInteger(kf.index) || kf.index < 0) return `Keyframe ${i + 1} needs a frame index ≥ 0.`;
      if (kf.index > numFrames - 1) return `Keyframe ${i + 1} frame ${kf.index} must be below numFrames (${numFrames}).`;
      // Effective cap from the resolution-dependent pixel budget (< numFrames at
      // higher resolutions). Mirrors the worker's clamp so we don't POST a
      // render that 400s with LTX2_FFLF_PIXEL_BUDGET_EXCEEDED.
      if (maxSafeFrames < numFrames && kf.index > maxSafeFrames - 1) {
        return `Keyframe ${i + 1} frame ${kf.index} exceeds the ${width}×${height} pixel budget (max frame ${maxSafeFrames - 1}). Lower the resolution or raise FFLF_LTX2_PIXEL_BUDGET.`;
      }
      if (kf.index <= prev) return 'Keyframe frame indices must be strictly ascending.';
      prev = kf.index;
    }
    return null;
  }, [keyframesActive, keyframes, numFrames, maxSafeFrames, width, height]);
  const keyframesBlocked = keyframesActive && !!keyframesError;

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

  // Preset pick or custom W×H edit — mark the size as manually set so aspect-snap
  // on image upload stops overriding it (same flag the remix/deep-link paths set).
  // ResolutionField passes a transient 0 mid-edit and blur-snaps each edge to the
  // 64..2048 bound; the preview + FFLF-budget math guard against a transient 0,
  // and the server floors both dims to a multiple of 64 (generateVideo in
  // local.js) before enforcing the per-tier pixel budget.
  const handleResolutionChange = (w, h) => {
    setWidth(w); setHeight(h); sizeManuallySetRef.current = true;
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

  // The last addressable frame index — the smaller of numFrames and the
  // resolution-dependent pixel-budget cap (maxSafeFrames), minus 1. Seeding new
  // keyframe rows against this keeps the auto-seeded index inside the budget the
  // server enforces, so toggling keyframes on at a high resolution doesn't seed
  // an index that immediately trips keyframesError.
  const lastSeedableIndex = Math.max(0, Math.min(numFrames, maxSafeFrames) - 1);
  // Multi-keyframe list mutators. A new row defaults its index to the prior
  // row's index + 1 (clamped to the last addressable frame) so the strictly-
  // ascending invariant holds out of the box without the user hand-typing it.
  const addKeyframe = () => setKeyframes((prev) => {
    if (prev.length >= 8) return prev;
    const lastIndex = prev.length ? prev[prev.length - 1].index : -1;
    const nextIndex = Math.min(lastIndex + 1, lastSeedableIndex);
    return [...prev, { file: '', index: nextIndex }];
  });
  const updateKeyframe = (i, patch) => setKeyframes((prev) =>
    prev.map((kf, idx) => (idx === i ? { ...kf, ...patch } : kf)));
  const removeKeyframe = (i) => setKeyframes((prev) => prev.filter((_, idx) => idx !== i));
  // Toggling multi-keyframe mode on seeds two empty rows anchored at the first
  // and last frame (the FFLF mental model, and the minimum 2 the server
  // requires) and drops the legacy first/last pair (the route rejects mixing
  // them). Toggling off clears the keyframe list for the same reason.
  const toggleKeyframesMode = () => setKeyframesMode((on) => {
    const next = !on;
    if (next) {
      clearSourceImage();
      clearLastImage();
      setKeyframes((prev) => (prev.length >= 2 ? prev : [
        { file: '', index: 0 },
        { file: '', index: Math.max(1, lastSeedableIndex) },
      ]));
    } else {
      setKeyframes([]);
    }
    return next;
  });

  // Switching mode resets the now-irrelevant fields so a stale choice from
  // a prior mode can't sneak into the next generation. (Prompt/seed/etc.
  // carry over because they apply to all modes.)
  const handleModeChange = (next) => {
    setMode(next);
    // Audio is only meaningful in a2v mode — drop it on every other switch
    // so a stale upload from a prior pick doesn't sneak into a non-a2v post.
    if (next !== 'a2v') setAudioFile(null);
    // Multi-keyframe is fflf-only — drop it on every other switch so a stale
    // keyframe list can't sneak into the next post (the route would 400 on a
    // non-fflf mode anyway, but keep the form honest).
    if (next !== 'fflf') { setKeyframesMode(false); setKeyframes([]); }
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
    const res = await extractLastFrame(videoId, { silent: true }).catch((err) => {
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
  const isGrok = grokEnabled && backend === 'grok';

  const buildGeneratePayload = () => {
    const composed = composeStyledPrompt(prompt, negativePrompt, stylePreset);
    if (isGrok) {
      // Grok's image-first flow reads only these fields; width/height ride
      // along so the server maps them to the closest supported aspect ratio.
      return {
        backend: 'grok',
        prompt: composed.prompt,
        negativePrompt: composed.negativePrompt,
        grokDuration,
        width: clampImageEdge(width, VIDEO_EDGE_BOUNDS),
        height: clampImageEdge(height, VIDEO_EDGE_BOUNDS),
        mode: mode === 'image' ? 'image' : 'text',
        sourceImageFile: mode === 'image' ? (sourceImageFile || '') : '',
        sourceImage: mode === 'image' ? (sourceImageUpload || '') : '',
      };
    }
    // Append "no music, no soundtrack" only when the toggle is on AND audio
    // generation is itself active — there's no point steering audio output
    // when audio is disabled outright. Idempotent: if the user already
    // typed "no music" we avoid double-appending.
    const promptOut = (noMusic && !disableAudio && !/no music/i.test(composed.prompt))
      ? `${composed.prompt}\n\nno music, no soundtrack`
      : composed.prompt;
    // Legacy first/last-frame fflf: the two-image picker is mutually exclusive
    // with multi-keyframe mode on the server, so its image fields only ride
    // along when keyframes aren't active.
    const legacyFflf = mode === 'fflf' && !keyframesActive;
    return {
      prompt: promptOut,
      negativePrompt: composed.negativePrompt,
      modelId,
      // Clamp/floor to the runner's edge bounds so a transient 0 (field cleared
      // mid-edit) or off-grid value can't 400 the server — mirrors ImageGen's
      // submit-time clampImageEdge guard.
      width: clampImageEdge(width, VIDEO_EDGE_BOUNDS),
      height: clampImageEdge(height, VIDEO_EDGE_BOUNDS),
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
      // keyframes goes as a JSON string — buildFormData would otherwise
      // stringify each {file,index} object to "[object Object]" (it appends
      // arrays element-by-element); the route's zod preprocess JSON-parses it
      // and strips any unknown keys, so sending the entries verbatim is safe.
      keyframes: keyframesActive ? JSON.stringify(keyframes) : '',
      // Video LoRAs (ltx2 only) ride as the universal parallel-array contract
      // (loraFilenames + loraScales) — the SAME shape ImageGen submits and a
      // history requeue emits — so buildFormData appends them as repeated
      // multipart keys and the route needs no bespoke shape. Only sent when the
      // model's runtime supports LoRAs (else the route 400s LORAS_REQUIRE_LTX2);
      // undefined fields are dropped by buildFormData.
      loraFilenames: (loraFamily && selectedLoras.length) ? selectedLoras.map((l) => l.filename) : undefined,
      loraScales: (loraFamily && selectedLoras.length) ? selectedLoras.map((l) => l.scale) : undefined,
      sourceImageFile: (mode === 'image' || legacyFflf
        || (mode === 'extend' && currentModel?.runtime !== 'ltx2'))
        ? (sourceImageFile || '') : '',
      sourceImage: (mode === 'image' || legacyFflf) ? (sourceImageUpload || '') : '',
      lastImageFile: legacyFflf ? (lastImageFile || '') : '',
      lastImage: legacyFflf ? (lastImageUpload || '') : '',
      extendFromVideoId: (mode === 'extend' && currentModel?.runtime === 'ltx2')
        ? (extendFromVideoId || '') : '',
      // Audio File goes through under the multipart field 'audioFile'. Server
      // routes it to the durable uploads dir and into the a2v helper.
      audioFile: mode === 'a2v' ? (audioFile || '') : '',
      // Keyframes anchor a single clip — the route rejects chunks > 1 with
      // KEYFRAMES_CHUNKS_CONFLICT, so suppress chunking when keyframes are on.
      chunks: mode !== 'a2v' && !keyframesActive && chunks > 1 ? chunks : '',
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
    if (!prompt.trim() || generating || (!isGrok && (notConnected || extendModeBlocked || a2vModeBlocked || byovGateBlocked || keyframesBlocked))) return;
    await runGeneration(buildGeneratePayload()).catch(() => {});
  };

  const handleEnqueue = () => {
    // Mirror the Generate guard — a BYOV runtime that isn't installed yet
    // would silently queue a doomed job that fails late in the worker with
    // VENV_MISSING, hiding the installer banner from the user. Block at
    // enqueue time so the only path forward is the install banner above.
    if (!prompt.trim() || (!isGrok && (notConnected || extendModeBlocked || a2vModeBlocked || byovGateBlocked || keyframesBlocked))) return;
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
              onClick={() => {
                setBackend(id);
                if (id === 'grok' && mode !== 'text' && mode !== 'image') {
                  setMode((sourceImageFile || sourceImageUpload) ? 'image' : 'text');
                }
              }}
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
                onPickGallery={(filename) => {
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
                }}
                onUpload={(file) => {
                  // Clear any gallery pick + URL param when an upload is
                  // chosen — otherwise the preview keeps rendering the old
                  // gallery image while the POST sends the upload.
                  if (file && (sourceImageFile || incomingSourceImage)) clearSourceImage();
                  setSourceImageUpload(file);
                }}
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
                  onPickGallery={(filename) => {
                    setLastImageUpload(null);
                    setLastImageFile(filename);
                  }}
                  onUpload={(file) => {
                    if (file && lastImageFile) setLastImageFile(null);
                    setLastImageUpload(file);
                  }}
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

          {isGrok ? (
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Clip length" labelClassName="block text-xs font-medium text-gray-400 mb-1">
                <select
                  value={grokDuration}
                  onChange={(e) => setGrokDuration(Number(e.target.value))}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                >
                  <option value={6}>6 seconds</option>
                  <option value={10}>10 seconds</option>
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
                (videoLoras is the strict ltx-video subset; see above). */}
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

            <FormField label="Frames" labelClassName="block text-xs font-medium text-gray-400 mb-1">
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
            </FormField>

            {mode !== 'a2v' && (
              <div>
                <label htmlFor="chunks-select" className="block text-xs font-medium text-gray-400 mb-1" title="Chain N renders end-to-end. Each chunk's last frame seeds the next, then they're stitched into one clip. Wall time scales linearly with chunks.">
                  Chunks
                </label>
                <select
                  id="chunks-select"
                  value={keyframesActive ? 1 : chunks}
                  onChange={(e) => setChunks(Number(e.target.value))}
                  disabled={keyframesActive}
                  title={keyframesActive ? 'Multi-keyframe renders anchor a single clip — chunking is unavailable.' : undefined}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? '1 (single)' : `${n} (~${((n * numFrames) / fps).toFixed(0)}s total)`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <FormField label="FPS" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value))}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {FPS_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </FormField>

            <div>
              <label htmlFor="video-seed" className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
              <div className="flex items-center gap-1">
                <input
                  id="video-seed"
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

            <FormField
              label={<>Steps {currentModel?.steps && `(default: ${currentModel.steps})`}</>}
              labelClassName="block text-xs font-medium text-gray-400 mb-1"
            >
              <input
                type="number" min={1} max={150}
                value={steps}
                onChange={(e) => setSteps(e.target.value)}
                placeholder={String(currentModel?.steps || 25)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              />
            </FormField>

            <FormField
              label={<>CFG Scale {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}</>}
              labelClassName="block text-xs font-medium text-gray-400 mb-1"
            >
              <input
                type="number" min={0} max={20} step={0.5}
                value={guidanceScale}
                onChange={(e) => setGuidanceScale(e.target.value)}
                placeholder={String(currentModel?.guidance ?? 3.0)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              />
            </FormField>

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

            <FormField className="col-span-2 sm:col-span-3" label="Tiling" labelClassName="block text-xs font-medium text-gray-400 mb-1">
              <select
                value={tiling}
                onChange={(e) => setTiling(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {VIDEO_TILING_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </FormField>

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
                disabled={!prompt.trim() || (!isGrok && (notConnected || extendModeBlocked || a2vModeBlocked || byovGateBlocked || keyframesBlocked))}
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
            {item.params.width}×{item.params.height} · {item.params.backend === 'grok' ? `${item.params.grokDuration || 6}s` : `${item.params.numFrames}f`}
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
