/**
 * Image Generation page.
 *
 * Backend is picked per-render via the chip strip (Local / External / Codex);
 * default comes from Settings → Image Gen. External mode is synchronous over
 * /api/image-gen/generate. Local + Codex are async — both kick off a job and
 * stream progress over /api/image-gen/:jobId/events SSE. Codex requires the
 * "Enable Codex Imagegen" toggle in Settings; otherwise its chip is hidden.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import Drawer from '../components/Drawer';
import { ImageGenTab } from '../components/settings/ImageGenTab';
import MediaCard from '../components/media/MediaCard';
import MediaPreview from '../components/media/MediaPreview';
import FavoritesFilterChip from '../components/media/FavoritesFilterChip';
import StylePresetPicker from '../components/media/StylePresetPicker';
import BackendChipStrip from '../components/media/BackendChipStrip';
import { normalizeImage } from '../components/media/normalize';
import { RUNNER_FAMILIES } from '../lib/runnerFamilies';
import Flux2InstallModal from '../components/imageGen/Flux2InstallModal';
import HfTokenBanner from '../components/imageGen/HfTokenBanner';
import ImageGenControls from '../components/imageGen/ImageGenControls';
import LoraPicker from '../components/imageGen/LoraPicker';
import MediaJobsQueue from '../components/media/MediaJobsQueue';
import { useMediaCompletionRefresh } from '../hooks/useMediaCompletionRefresh';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import usePreviewRoute from '../hooks/usePreviewRoute';
import {
  Image as ImageIcon, Sparkles, Download, RefreshCw, Settings as SettingsIcon,
  AlertTriangle, X, Film,
} from 'lucide-react';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import { deriveAvailableBackends, IMAGE_GEN_MODE } from '../lib/imageGenBackends';
import { DEFAULT_NEGATIVE_PROMPT } from '../lib/imageGenDefaults';
import { resolveCleanersFromConfig } from '../lib/imageCleaners';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import { useImageGenProgress } from '../hooks/useImageGenProgress';
import { useMediaJobSse } from '../hooks/useMediaJobSse';
import { useModelDownloadStatus } from '../hooks/useModelDownloadStatus';
import {
  getImageGenStatus, generateImage, listImageModels, listLorasFull, listImageGallery,
  cancelImageGen, deleteImage, setImageHidden, cleanGalleryImage, getActiveImageJob, getSettings,
  buildFormData, listMediaJobs,
} from '../services/api';

// Multi-reference editing (FLUX.2 only) — 4 fixed slots, each carrying an
// uploaded File + a 0..1 strength weight. Slots are positional so the
// blob-URL revoke pairs with the slot the user cleared.
const REFERENCE_SLOT_COUNT = 4;
const EMPTY_REF_SLOT = { file: null, previewUrl: null, strength: 1.0 };

// Append LoRA trigger words to a prompt comma-separated, skipping any
// already present. Compares against comma-separated prompt segments rather
// than raw substrings so a short trigger like "cat" doesn't false-match
// inside "concatenate". Civitai triggers are often phrases that themselves
// contain spaces, so the match is whole-segment, case-insensitive.
const appendTriggerWords = (prompt, words) => {
  const list = (Array.isArray(words) ? words : [])
    .filter((w) => typeof w === 'string' && w.trim())
    .map((w) => w.trim());
  if (!list.length) return prompt;
  const segments = String(prompt || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const fresh = list.filter((w) => !segments.includes(w.toLowerCase()));
  if (!fresh.length) return prompt;
  const trimmed = String(prompt || '').trim();
  const sep = !trimmed ? '' : trimmed.endsWith(',') ? ' ' : ', ';
  return `${trimmed}${sep}${fresh.join(', ')}`;
};

// User-facing labels for STAGE markers emitted by FLUX.2 (and any future
// runner). The keys match what `flux2_macos.py` prints; unknown stages fall
// through to the prettified id so adding a new STAGE in Python doesn't
// require a client change to be at least readable.
const STAGE_LABELS = {
  'starting': 'Starting…',
  'download-tokenizer': 'Loading tokenizer…',
  'download-pipeline': 'Downloading model weights (~8 GB on first run)…',
  'download-snapshot': 'Downloading model weights…',
  'download-int8-snapshot': 'Downloading model weights (~16 GB on first run)…',
  'load-transformer': 'Loading transformer…',
  'load-text-encoder': 'Loading text encoder…',
  'move-to-device': 'Moving model to GPU…',
  'inference': 'Running diffusion…',
};

// Headings for typed errors emitted via USER_ERROR: lines. Keys match `kind`
// from the SSE error event. Unknown/missing kinds fall through to the
// generic 'Generation failed' heading.
const ERROR_HEADINGS = {
  gated_repo: 'Model access required',
  hf_unauthorized: 'HuggingFace token rejected',
  repo_not_found: 'Model repo not found',
};

export default function ImageGen() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const settingsOpen = searchParams.get('settings') === '1';
  const openSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('settings', '1'); return n; });
  const closeSettings = () => setSearchParams(prev => { const n = new URLSearchParams(prev); n.delete('settings'); return n; });
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [models, setModels] = useState([]);
  const [availableLoras, setAvailableLoras] = useState([]);
  const [gallery, setGallery] = useState([]);
  // `preview` is URL-driven via `usePreviewRoute(previewItems)` — declared
  // after `previewItems` below so the resolver can match against it.
  const [showHidden, setShowHidden] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { annotations, updateAnnotation, getCardProps } = useMediaAnnotations();
  // FLUX.2 readiness — drives the gating banner. Lazy-fetched on the first
  // selection of a flux2 model so we don't make an extra request when the
  // user is only using mflux/external/codex.
  const [flux2Status, setFlux2Status] = useState(null);
  const [flux2InstallOpen, setFlux2InstallOpen] = useState(false);
  // Generic HF-token presence for legacy mflux gated models (FLUX.1-dev).
  // Lazy-fetched when a model with `requiresHfToken: true` is selected.
  const [hfTokenPresent, setHfTokenPresent] = useState(null);

  const [selectedMode, setSelectedMode] = useState(null);
  // Mirror selectedMode in a ref so callbacks (reloadBackends) can read the
  // latest value without re-creating themselves on every mode flip.
  const selectedModeRef = useRef(null);
  selectedModeRef.current = selectedMode;
  const [availableBackends, setAvailableBackends] = useState([]);

  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE_PROMPT);
  const [stylePreset, setStylePreset] = useState(null);
  const [modelId, setModelId] = useState('');
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState('');
  const [guidance, setGuidance] = useState('');
  const [cfgScale, setCfgScale] = useState(7);
  const [quantize, setQuantize] = useState('8');
  const [seed, setSeed] = useState('');
  const [selectedLoras, setSelectedLoras] = useState([]);

  // i2i (Flux, local mflux only). source='upload' carries `file`; source='gallery'
  // carries `name` (basename from URL param). Coupled lifetime — always replace
  // the whole object so previewUrl can never out-live its file/name.
  const [initImage, setInitImage] = useState({ source: null, file: null, name: null, previewUrl: null });
  const [initImageStrength, setInitImageStrength] = useState(0.4);
  // Form posts populated slots as `referenceImage1` … `referenceImage4`
  // multipart fields with a parallel `referenceStrengths` array.
  const [referenceImages, setReferenceImages] = useState(() => Array.from({ length: REFERENCE_SLOT_COUNT }, () => ({ ...EMPTY_REF_SLOT })));

  // Batch size: how many renders this submit kicks off. Only meaningful for
  // async modes (local + codex); external is synchronous and runs N=1.
  const [batchCount, setBatchCount] = useState(1);

  // Per-render cleaner overrides. Seeded from
  // `settings.imageGen.{mode}.{cleanC2PA,denoise}` whenever the active mode
  // changes; the user can flip the checkboxes to override the saved defaults
  // for this submit. The server's /generate route stamps the resolved values
  // into the payload so all three dispatch paths see the same booleans.
  const [cleanC2PA, setCleanC2PA] = useState(true);
  const [denoise, setDenoise] = useState(false);
  // Saved per-mode defaults — keeps the "(overrides saved default)" hint
  // reactive to settings reloads. Held as state (not a ref) so when the user
  // edits a saved default in the Settings drawer and closes it, the hint
  // re-evaluates even if the local state happens to match the new saved value.
  const [savedCleanC2PAByMode, setSavedCleanC2PAByMode] = useState({});
  const [savedDenoiseByMode, setSavedDenoiseByMode] = useState({});

  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [errorMeta, setErrorMeta] = useState(null); // { kind, repo } for typed-error guidance
  const [localProgress, setLocalProgress] = useState(null); // local mode SSE-driven 0..1
  // Count of additional submits stacked behind the in-flight render. Drains
  // back to 0 every time the active render completes (refreshGallery picks
  // up everything finished server-side). Just a visual signal for the user;
  // the real queue lives in mediaJobQueue on the server.
  const [pendingQueued, setPendingQueued] = useState(0);
  // FLUX.2 (and any future runner that emits `STAGE:` markers) flips this
  // through phases like 'download-pipeline' → 'move-to-device' → 'inference'.
  // Drives the loading-card label so a multi-minute first-run model download
  // doesn't look like a frozen "step 0/8".
  const [stage, setStage] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const { attach: attachJobEvents, eventSourceRef } = useMediaJobSse('image');

  // External-mode socket-driven progress (kept for backward compat with
  // existing AUTOMATIC1111 wiring; the local mode also feeds the same hook
  // via imageGenEvents so the same UI bits light up).
  const { progress: externalProgress, begin: beginGenerate, end: endGenerate, resume: resumeGenerate } = useImageGenProgress();

  // Per-model cache status drives the inline "Available / Download" badge
  // under the model picker. Only meaningful for the local backend (external
  // SD-API and Codex don't use HF cache), so we conditionally pass the
  // status through to ImageGenControls below.
  const modelDownload = useModelDownloadStatus({ kind: 'image' });

  // selectedMode is null until settings load — fall back to status.mode
  // so the form doesn't flicker between defaults.
  const effectiveMode = selectedMode || status?.mode || IMAGE_GEN_MODE.EXTERNAL;
  const isLocalMode = effectiveMode === IMAGE_GEN_MODE.LOCAL;
  const isCodexMode = effectiveMode === IMAGE_GEN_MODE.CODEX;
  const isAsyncMode = isLocalMode || isCodexMode;
  // Prefer the socket-driven hook (carries currentImage for both modes since
  // local mflux now writes stepwise frames). Fall back to the local SSE's
  // simpler progress shape if the hook hasn't received its first event yet.
  const progress = externalProgress || localProgress;
  const progressPct = progress?.progress != null ? Math.round(progress.progress * 100) : null;

  // Status reflects the currently-selected backend, not the saved default —
  // chip changes re-probe via the optional ?mode= override so the badge and
  // notConnected gating stay aligned with what Generate would actually use.
  //
  // Token-guarded so a slow stale check (e.g. the initial `external` probe
  // timing out against an unconfigured SD API URL) can't overwrite the
  // newer `local` probe that already returned green. Without this the badge
  // gets stuck on "SD API unreachable" even though Local is selected.
  const statusRequestToken = useRef(0);
  const refreshStatus = useCallback((mode) => {
    const myToken = ++statusRequestToken.current;
    setStatusLoading(true);
    getImageGenStatus(mode)
      .then((s) => {
        if (myToken !== statusRequestToken.current) return;
        setStatus(s);
      })
      .catch(() => {
        if (myToken !== statusRequestToken.current) return;
        setStatus({ connected: false, reason: 'Status check failed' });
      })
      .finally(() => {
        if (myToken === statusRequestToken.current) setStatusLoading(false);
      });
  }, []);

  const refreshGallery = useCallback(() => {
    listImageGallery().then(setGallery).catch(() => {});
  }, []);
  useMediaCompletionRefresh({ onImageCompleted: refreshGallery });

  // Re-runnable so the Settings drawer can trigger a refresh on close
  // without forcing a full page reload.
  const reloadBackends = useCallback(() => {
    return getSettings().then((s) => {
      const backends = deriveAvailableBackends(s);
      // Per-mode saved defaults via the shared helper (mirrored from
      // server/lib/imageClean.js). One pass per mode, then split into the
      // parallel cleanC2PA / denoise maps the UI binds to.
      const perMode = {
        external: resolveCleanersFromConfig(s?.imageGen?.external, IMAGE_GEN_MODE.EXTERNAL),
        local: resolveCleanersFromConfig(s?.imageGen?.local, IMAGE_GEN_MODE.LOCAL),
        codex: resolveCleanersFromConfig(s?.imageGen?.codex, IMAGE_GEN_MODE.CODEX),
      };
      const c2 = { external: perMode.external.cleanC2PA, local: perMode.local.cleanC2PA, codex: perMode.codex.cleanC2PA };
      const dn = { external: perMode.external.denoise, local: perMode.local.denoise, codex: perMode.codex.denoise };
      const saved = s?.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;
      // If the user just disabled the currently-selected backend, fall
      // through to the first viable one — a just-toggled provider should
      // Just Work without a page reload. Reading `selectedMode` here instead
      // of inside a setSelectedMode updater keeps the state update pure
      // (React updaters must not call other setters).
      const prev = selectedModeRef.current;
      const next = (prev && backends.find((b) => b.id === prev)) ? prev
        : backends.find((b) => b.id === saved) ? saved
        : backends.length ? backends[0].id
        : saved;
      setAvailableBackends(backends);
      setSavedCleanC2PAByMode(c2);
      setSavedDenoiseByMode(dn);
      setSelectedMode(next);
      setCleanC2PA(c2[next] === true);
      setDenoise(dn[next] === true);
    }).catch(() => {});
  }, []);

  // Re-seed the cleaner checkboxes when the user manually picks a different
  // backend chip — without this, switching external→local would leave the
  // external values in the form.
  const handleSelectMode = useCallback((next) => {
    setSelectedMode(next);
    setCleanC2PA(savedCleanC2PAByMode[next] === true);
    setDenoise(savedDenoiseByMode[next] === true);
  }, [savedCleanC2PAByMode, savedDenoiseByMode]);

  useEffect(() => {
    listImageModels().then((m) => {
      setModels(m);
      if (m.length && !modelId) setModelId(m[0].id);
    }).catch(() => {});
    // Use the richer /api/loras surface so the picker can show trigger
    // words + recommended scale + Civitai-derived runnerFamily.
    listLorasFull().then(setAvailableLoras).catch(() => {});
    refreshGallery();
    reloadBackends();
    // Resume an in-flight job so the user can navigate away mid-render and
    // come back to the same prompt + settings + live preview frame.
    getActiveImageJob().then(({ activeJob }) => {
      if (!activeJob) return;
      if (activeJob.prompt) setPrompt(activeJob.prompt);
      if (activeJob.negativePrompt != null) setNegativePrompt(activeJob.negativePrompt);
      if (activeJob.modelId) setModelId(activeJob.modelId);
      if (activeJob.width) setWidth(activeJob.width);
      if (activeJob.height) setHeight(activeJob.height);
      if (activeJob.steps != null) setSteps(activeJob.steps);
      if (activeJob.guidance != null) setGuidance(activeJob.guidance);
      if (activeJob.seed != null) setSeed(activeJob.seed);
      if (activeJob.quantize != null) setQuantize(String(activeJob.quantize));
      setGenerating(true);
      setStatusMsg('Resuming…');
      resumeGenerate(activeJob);
      // Re-attach the per-job SSE so raw status text resumes too. Every
      // terminal outcome (complete/error/canceled) and a lost connection just
      // flips the generating flag off; the reject on the error/canceled/
      // connection-loss paths is expected, so swallow it. onConnectionError is
      // required so a connection blip can't leave the resumed render parked at
      // "Resuming…" with generating stuck true.
      attachJobEvents(activeJob.generationId, {
        onStatus: (msg) => setStatusMsg(msg.message),
        onProgress: (msg) => setLocalProgress({ progress: msg.progress }),
        onComplete: () => setGenerating(false),
        onError: () => setGenerating(false),
        onCanceled: () => setGenerating(false),
        onConnectionError: () => setGenerating(false),
      }).catch(() => {});
    }).catch(() => {});
    return () => eventSourceRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-probe status whenever the effective backend changes — flipping the
  // chip from Local to Codex shouldn't leave the badge / notConnected
  // gating reflecting the previous backend.
  useEffect(() => {
    if (!effectiveMode) return;
    refreshStatus(effectiveMode);
  }, [effectiveMode, refreshStatus]);

  // ?initImageFile=foo.png pre-fills from a gallery basename — supports a
  // future "Send to Image (i2i)" gallery action.
  useEffect(() => {
    const fromUrl = searchParams.get('initImageFile');
    if (fromUrl && initImage.source == null) {
      setInitImage({ source: 'gallery', file: null, name: fromUrl, previewUrl: `/data/images/${fromUrl}` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ?lora=<filename> preselects a LoRA when the user clicks "Test" on the
  // /media/loras manager page. Defers until availableLoras has loaded so the
  // metadata (recommendedScale, name, triggerWords) is available; once applied,
  // strip the param so a refresh doesn't keep re-adding the LoRA. Also
  // auto-appends the LoRA's trigger words to the prompt — the user came from
  // "Test this" so the intent is "show me what this LoRA does," and most
  // LoRAs only fire correctly when their trigger words are in the prompt.
  useEffect(() => {
    const fromUrl = searchParams.get('lora');
    if (!fromUrl || !availableLoras.length) return;
    const match = availableLoras.find((l) => l.filename === fromUrl);
    if (!match) return;
    setSelectedLoras((prev) => prev.find((s) => s.filename === fromUrl) ? prev : [...prev, {
      filename: match.filename,
      name: match.name,
      scale: typeof match.recommendedScale === 'number' ? match.recommendedScale : 1.0,
    }]);
    if (match.triggerWords?.length) {
      setPrompt((p) => appendTriggerWords(p, match.triggerWords));
    }
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('lora'); return next; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, availableLoras]);

  // Remix payload from Media History (?prompt=…&modelId=…&seed=…). Populate
  // form state once on mount, then strip the params so a hot-reload or back-
  // nav doesn't re-clobber edits the user has made since.
  useEffect(() => {
    const remixKeys = ['prompt', 'negativePrompt', 'modelId', 'width', 'height', 'seed', 'steps', 'guidance', 'quantize'];
    const present = remixKeys.filter((k) => searchParams.get(k) != null);
    if (present.length === 0) return;
    const get = (k) => searchParams.get(k);
    if (get('prompt')) setPrompt(get('prompt'));
    if (get('negativePrompt')) setNegativePrompt(get('negativePrompt'));
    if (get('modelId')) setModelId(get('modelId'));
    if (get('width')) setWidth(Number(get('width')));
    if (get('height')) setHeight(Number(get('height')));
    if (get('seed') != null) setSeed(get('seed'));
    if (get('steps')) setSteps(get('steps'));
    if (get('guidance')) setGuidance(get('guidance'));
    if (get('quantize')) setQuantize(get('quantize'));
    setSearchParams((prev) => {
      const n = new URLSearchParams(prev);
      remixKeys.forEach((k) => n.delete(k));
      return n;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Strip EXIF orientation by re-encoding the image with rotation baked into
  // the pixels. Browsers honor EXIF when rendering <img>, so the upload
  // thumbnail looks right — but mflux/PIL reads raw pixels and ignores EXIF,
  // so a portrait iPhone photo (Orientation=6 or 8) lands sideways in the
  // generated output. createImageBitmap({ imageOrientation: 'from-image' })
  // applies the EXIF rotation; canvas re-encode produces an EXIF-free file
  // that any decoder will read in the same orientation as the browser shows.
  const normalizeImageOrientation = async (file) => {
    const bitmap = await window.createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    if (!bitmap) return file;
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return file;
    const newName = file.name.replace(/\.[^.]+$/, '.png');
    return new File([blob], newName, { type: 'image/png' });
  };

  const handlePickInitImage = async (e) => {
    const raw = e.target.files?.[0];
    if (!raw) return;
    const file = await normalizeImageOrientation(raw);
    if (initImage.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(initImage.previewUrl);
    setInitImage({ source: 'upload', file, name: file.name, previewUrl: URL.createObjectURL(file) });
  };
  const handleClearInitImage = () => {
    if (initImage.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(initImage.previewUrl);
    setInitImage({ source: null, file: null, name: null, previewUrl: null });
  };

  const handlePickReferenceImage = async (slotIndex, e) => {
    const raw = e.target.files?.[0];
    if (!raw) return;
    const file = await normalizeImageOrientation(raw);
    setReferenceImages((prev) => {
      const next = [...prev];
      const prior = next[slotIndex];
      if (prior?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(prior.previewUrl);
      next[slotIndex] = { file, previewUrl: URL.createObjectURL(file), strength: prior?.strength ?? 1.0 };
      return next;
    });
  };
  const handleClearReferenceImage = (slotIndex) => {
    setReferenceImages((prev) => {
      const next = [...prev];
      const prior = next[slotIndex];
      if (prior?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(prior.previewUrl);
      next[slotIndex] = { ...EMPTY_REF_SLOT };
      return next;
    });
  };
  const handleReferenceStrengthChange = (slotIndex, strength) => {
    setReferenceImages((prev) => {
      const next = [...prev];
      next[slotIndex] = { ...next[slotIndex], strength };
      return next;
    });
  };

  // Object URL cleanup on unmount — both the single init image and any
  // populated reference slots. Mirror the live URLs into a ref so the
  // empty-deps unmount cleanup walks the LATEST set, not the initial empty
  // closure snapshot (per-action handlers already revoke when a slot is
  // replaced/cleared; this catches the one held at unmount).
  const previewUrlsRef = useRef({ init: null, refs: [] });
  useEffect(() => {
    previewUrlsRef.current = {
      init: initImage.previewUrl,
      refs: referenceImages.map((s) => s.previewUrl),
    };
  });
  useEffect(() => () => {
    const { init, refs } = previewUrlsRef.current;
    if (init?.startsWith('blob:')) URL.revokeObjectURL(init);
    for (const url of refs) {
      if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
    }
  }, []);

  // When the user closes the Settings drawer, settings may have changed
  // (e.g. they enabled Codex or configured a new external URL). Reload so
  // the chip strip matches the new state without a page refresh.
  const wasSettingsOpenRef = useRef(false);
  useEffect(() => {
    if (wasSettingsOpenRef.current && !settingsOpen) {
      reloadBackends();
    }
    wasSettingsOpenRef.current = settingsOpen;
  }, [settingsOpen, reloadBackends]);

  const currentModel = models.find((m) => m.id === modelId);
  const isFlux2Model = currentModel?.runner === RUNNER_FAMILIES.FLUX2;
  // mflux is the default runner for entries with no explicit `runner` field.
  // LoraPicker filters compatible weights itself; we just pass the family.
  const currentRunnerFamily = currentModel?.runner || RUNNER_FAMILIES.MFLUX;

  const refreshFlux2Status = useCallback((signal) => {
    const qs = modelId ? `?modelId=${encodeURIComponent(modelId)}` : '';
    return fetch(`/api/image-gen/setup/flux2-status${qs}`, { signal })
      .then((r) => r.ok ? r.json() : null)
      .then((s) => { if (s) setFlux2Status(s); })
      .catch(() => {});
  }, [modelId]);

  const refreshHfTokenStatus = useCallback((signal) => {
    return fetch('/api/image-gen/setup/hf-token-status', { signal })
      .then((r) => r.ok ? r.json() : null)
      .then((s) => { if (s) setHfTokenPresent(!!s.hfTokenPresent); })
      .catch(() => {});
  }, []);

  // Memoized so Flux2InstallModal's EventSource effect doesn't re-fire on
  // every parent re-render (gallery / generating / progress state churn
  // would otherwise tear down the SSE connection mid-install).
  const handleFlux2ModalClose = useCallback(() => setFlux2InstallOpen(false), []);
  const handleFlux2InstallComplete = useCallback(() => {
    refreshFlux2Status();
    toast.success('FLUX.2 runtime installed');
  }, [refreshFlux2Status]);

  useEffect(() => {
    if (!isFlux2Model) { setFlux2Status(null); return; }
    // Abort the in-flight request when the user switches models before it
    // resolves — otherwise a stale response could re-show the banner for
    // a non-flux2 selection.
    const controller = new AbortController();
    refreshFlux2Status(controller.signal);
    return () => controller.abort();
  }, [isFlux2Model, modelId, refreshFlux2Status]);

  // Lazy-fetch HF token presence for legacy mflux gated models (FLUX.1-dev).
  // FLUX.2 has its own combined status fetch above (which also covers the
  // venv install), so skip the duplicate request when isFlux2Model. The
  // `isLocalMode` gate is the important one: codex + external don't run mflux,
  // so a stale Flux modelId left in state from a prior local session must not
  // surface the HF banner under those backends.
  const needsHfTokenGate = isLocalMode && !!currentModel?.requiresHfToken && !isFlux2Model;
  useEffect(() => {
    if (!needsHfTokenGate) { setHfTokenPresent(null); return; }
    const controller = new AbortController();
    refreshHfTokenStatus(controller.signal);
    return () => controller.abort();
  }, [needsHfTokenGate, modelId, refreshHfTokenStatus]);

  // While the user has additional renders queued behind the active one, poll
  // `/api/media-jobs` to keep `pendingQueued` in sync with the server's
  // actual queue depth and refresh the gallery when a job transitions
  // running → done. The effect intentionally depends only on `pendingQueued
  // > 0` (a boolean) — using `pendingQueued` directly would tear down and
  // recreate the interval every tick the count changes, never letting the
  // 4s clock settle.
  const queueActive = pendingQueued > 0;
  const lastBusyRef = useRef(0);
  const pollQueue = useCallback(async () => {
    const jobs = await listMediaJobs({ kind: 'image' }).catch(() => null);
    if (!jobs) return;
    const stillBusy = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
    // Subtract 1 for the actively-tracked render (when generating). Floor
    // at 0 so a transient counting glitch doesn't show "−1 queued".
    const next = Math.max(0, stillBusy - (generating ? 1 : 0));
    // Only refresh gallery on a busy-count drop — that's the signal a
    // queued job just completed. Otherwise polling re-fetches the gallery
    // every 4s for nothing.
    if (stillBusy < lastBusyRef.current) refreshGallery();
    lastBusyRef.current = stillBusy;
    // No-op guard: same value setState would still trigger a render, so
    // explicitly skip when nothing changed.
    setPendingQueued((prev) => (prev === next ? prev : next));
  }, [generating, refreshGallery]);
  useAutoRefetch(pollQueue, 4000, { enabled: queueActive, pollOnly: true });

  const flux2Issue = isFlux2Model && flux2Status
    ? (!flux2Status.venvInstalled ? 'venv' : !flux2Status.hfTokenPresent ? 'token' : null)
    : null;
  const { visibleGallery, hiddenGallery } = useMemo(() => {
    const visible = gallery.filter((img) => !img.hidden);
    const hidden = gallery.filter((img) => img.hidden);
    if (!favoritesOnly) return { visibleGallery: visible, hiddenGallery: hidden };
    // Normalize to derive the canonical item.key rather than hand-building
    // `image:${img.filename}` — the kind/ref convention lives in normalize.js.
    const isStarred = (img) => !!annotations[normalizeImage(img).key]?.starred;
    return { visibleGallery: visible.filter(isStarred), hiddenGallery: hidden.filter(isStarred) };
  }, [gallery, favoritesOnly, annotations]);
  const previewItems = useMemo(() => [
    ...visibleGallery.map(normalizeImage),
    ...(showHidden ? hiddenGallery.map(normalizeImage) : []),
  ], [visibleGallery, hiddenGallery, showHidden]);
  const [preview, setPreview] = usePreviewRoute(previewItems);

  // Snapshots current form state into a server payload + POSTs it to the
  // mediaJobQueue. Returns the queue's response ({ jobId, position, ... }).
  // Shared between startLocalGeneration (which then opens SSE for the job)
  // and the "queue another while one is running" path which only needs the
  // POST — the user keeps watching the active render and the new submission
  // sits in the server queue until the active one finishes.
  const submitGenerationPayload = async () => {
    const composed = composeStyledPrompt(prompt, negativePrompt, stylePreset);
    const payload = isCodexMode ? {
      prompt: composed.prompt,
      negativePrompt: composed.negativePrompt || undefined,
      width, height,
      mode: IMAGE_GEN_MODE.CODEX,
      cleanC2PA, denoise,
    } : {
      prompt: composed.prompt,
      negativePrompt: composed.negativePrompt || undefined,
      modelId: modelId || undefined,
      width, height,
      steps: steps ? Number(steps) : undefined,
      guidance: guidance ? Number(guidance) : undefined,
      seed: seed && Number(seed) >= 0 ? Number(seed) : undefined,
      quantize,
      loraFilenames: selectedLoras.map((l) => l.filename),
      loraScales: selectedLoras.map((l) => l.scale),
      mode: IMAGE_GEN_MODE.LOCAL,
      cleanC2PA, denoise,
    };
    const hasInitImage = isLocalMode && initImage.source != null;
    // Multi-reference editing is FLUX.2-only; gate the slot read so it can't
    // accidentally fire on mflux or codex, and pack the populated slots so a
    // gap (e.g. slots 1,3 filled, 2 empty) collapses to a packed two-image
    // submit that aligns with the server's positional pairing.
    const populatedRefs = (isLocalMode && isFlux2Model)
      ? referenceImages.filter((s) => s.file != null)
      : [];
    const hasReferenceImages = populatedRefs.length > 0;
    if (hasInitImage || hasReferenceImages) {
      const initFields = hasInitImage ? {
        ...(initImage.source === 'upload' ? { initImage: initImage.file } : { initImageFile: initImage.name }),
        initImageStrength,
      } : {};
      const refFields = hasReferenceImages ? {
        ...Object.fromEntries(populatedRefs.map((slot, i) => [`referenceImage${i + 1}`, slot.file])),
        referenceStrengths: populatedRefs.map((s) => s.strength),
      } : {};
      const fd = buildFormData({ ...payload, ...initFields, ...refFields });
      const res = await fetch('/api/image-gen/generate', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      return { payload, data: await res.json() };
    }
    return { payload, data: await generateImage(payload) };
  };

  const startLocalGeneration = async () => {
    setLocalProgress({ progress: 0 });
    const { payload, data } = await submitGenerationPayload();
    const jobId = data.jobId || data.generationId;
    return attachJobEvents(jobId, {
      onStage: (msg) => setStage({ name: msg.stage, detail: msg.detail }),
      onStatus: (msg) => setStatusMsg(msg.message),
      onProgress: (msg) => {
        setLocalProgress({ progress: msg.progress, phase: msg.phase });
        setStatusMsg(msg.message);
      },
      onComplete: (msg) => {
        // Codex's built-in image_gen tool decides steps/guidance/seed
        // internally and ignores whatever we pass — so don't backfill
        // local-mode model defaults onto a codex render's metadata.
        // The gallery / sidecar would otherwise show steps=20,
        // guidance=3.5 (Flux 1 Dev defaults) on every codex image,
        // misleading the user about what actually produced it.
        const localOnlyMeta = isCodexMode ? {} : {
          steps: payload.steps ?? currentModel?.steps,
          guidance: payload.guidance ?? currentModel?.guidance,
        };
        setResult({
          ...data,
          ...msg.result,
          prompt: payload.prompt,
          negativePrompt: payload.negativePrompt,
          width, height,
          ...localOnlyMeta,
        });
        return msg.result;
      },
      onError: (msg) => {
        // The server may attach `kind` (e.g. 'gated_repo', 'hf_unauthorized')
        // and `repo` for the UI to deep-link to the HF access page. Carry
        // them on the Error so handleGenerate's catch can render guidance.
        const err = new Error(msg.error);
        if (msg.kind) err.kind = msg.kind;
        if (msg.repo) err.repo = msg.repo;
        return err;
      },
    });
  };

  // Queue N renders without taking over the active SSE/preview. Used when the
  // user submits while one is already rendering — they get to keep watching
  // the in-flight render, and the new payloads land in mediaJobQueue (server
  // FIFO). When the active render finishes, refreshGallery() pulls all
  // completed images so the queued ones become visible as they land.
  // Async-mode only; external is synchronous so submitting N would block N×.
  const queueAdditional = async (count = 1) => {
    if (!prompt.trim() || count < 1) return;
    const submissions = Array.from({ length: count }, () =>
      submitGenerationPayload().then(({ data }) => data).catch((err) => err),
    );
    const results = await Promise.all(submissions);
    const queued = results.filter((r) => r && !(r instanceof Error)).length;
    const failed = results.length - queued;
    if (queued > 0) setPendingQueued((n) => n + queued);
    if (queued > 0) toast.success(count === 1 ? 'Queued' : `Queued ${queued}`);
    if (failed > 0) toast.error(`${failed} job(s) failed to queue`);
  };

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    if (!prompt.trim()) return;
    const batchN = isAsyncMode ? Math.max(1, batchCount) : 1;
    if (generating) return queueAdditional(batchN);
    setGenerating(true);
    setStatusMsg('Starting...');
    setError(null);
    setErrorMeta(null);
    setResult(null);
    setStage(null);
    // Both modes go through the socket-driven progress hook now — local mflux
    // emits stepwise frames via the imageGenEvents bus the same way external
    // SD API does, so the same hook drives the live preview for both.
    beginGenerate();

    try {
      if (isAsyncMode) {
        // Fire batch extras in parallel with the SSE-tracked first job so the
        // queue positions surface immediately; await both before showing the
        // success toast so the "+N queued" badge is in sync.
        const extras = batchN > 1 ? queueAdditional(batchN - 1) : Promise.resolve();
        await startLocalGeneration();
        await extras;
      } else {
        const composed = composeStyledPrompt(prompt, negativePrompt, stylePreset);
        const payload = {
          prompt: composed.prompt,
          negativePrompt: composed.negativePrompt || undefined,
          width, height,
          steps: steps ? Number(steps) : 25,
          cfgScale,
          mode: IMAGE_GEN_MODE.EXTERNAL,
          cleanC2PA, denoise,
        };
        if (seed && Number(seed) >= 0) payload.seed = Number(seed);
        const data = await generateImage(payload);
        setResult({ ...data, prompt: payload.prompt, negativePrompt: payload.negativePrompt, width, height, steps: payload.steps, cfgScale });
      }
      toast.success('Image generated');
      refreshGallery();
    } catch (err) {
      setError(err.message || 'Image generation failed');
      // Typed kind from a USER_ERROR: line lets the UI render guidance
      // (request access link, re-paste token CTA) instead of just the prose.
      if (err.kind) setErrorMeta({ kind: err.kind, repo: err.repo });
      // Toast a one-line summary; the inline error card carries full prose.
      const firstLine = String(err.message || 'Image generation failed').split('\n')[0];
      toast.error(firstLine);
    } finally {
      setGenerating(false);
      setLocalProgress(null);
      setStage(null);
      endGenerate();
      // pendingQueued is reconciled by the polling effect (source of truth
      // is /api/media-jobs). Decrementing here would briefly undercount
      // before the next 4s tick reconciles.
    }
  };

  const handleCancel = async () => {
    eventSourceRef.current?.close();
    await cancelImageGen().catch(() => {});
    setGenerating(false);
    setStatusMsg('Cancelled');
  };

  const handleDelete = async (filename) => {
    await deleteImage(filename).catch(() => {});
    setGallery((g) => g.filter((img) => img.filename !== filename));
  };

  const handleToggleHidden = async (img) => {
    const nextHidden = !img.hidden;
    setGallery((g) => g.map((x) => (x.filename === img.filename ? { ...x, hidden: nextHidden } : x)));
    const result = await setImageHidden(img.filename, nextHidden).catch((err) => {
      toast.error(err.message || 'Failed to update visibility');
      setGallery((g) => g.map((x) => (x.filename === img.filename ? { ...x, hidden: !nextHidden } : x)));
      return null;
    });
    if (result) toast.success(nextHidden ? 'Image hidden' : 'Image unhidden');
  };

  const handleClean = async (img) => {
    if (!img?.filename) throw new Error('Missing filename');
    const cleaned = await cleanGalleryImage(img.filename).catch((err) => {
      toast.error(err.message || 'Failed to clean image');
      throw err;
    });
    setGallery((g) => [cleaned, ...g.filter((x) => x.filename !== cleaned.filename)]);
    toast.success(`Cleaned → ${cleaned.filename}`);
  };

  const sendToVideo = (img) => {
    if (!img?.filename) return;
    const params = new URLSearchParams({ sourceImageFile: img.filename });
    const srcPrompt = img.prompt || img.metadata?.prompt;
    const srcNegative = img.negativePrompt || img.negative_prompt || img.metadata?.negativePrompt;
    if (srcPrompt) params.set('prompt', srcPrompt);
    if (srcNegative) params.set('negativePrompt', srcNegative);
    navigate(`/media/video?${params}`);
  };

  const handleRemix = (img) => {
    // Preset was already folded into the recorded prompt at submit time;
    // clear the picker so the user sees what actually produced the image.
    setStylePreset(null);
    if (img.prompt) setPrompt(img.prompt);
    if (img.negativePrompt || img.negative_prompt) setNegativePrompt(img.negativePrompt || img.negative_prompt);
    if (img.seed != null) setSeed(String(img.seed));
    if (img.steps) setSteps(String(img.steps));
    if (img.guidance != null) setGuidance(String(img.guidance));
    if (img.quantize) setQuantize(String(img.quantize));
    if (img.width) setWidth(img.width);
    if (img.height) setHeight(img.height);
    if (img.modelId && models.some((m) => m.id === img.modelId)) setModelId(img.modelId);

    // Restore LoRAs from the new `loraFilenames` field; fall back to the
    // legacy `loraPaths` (absolute server paths) for older sidecar metadata
    // — extract the basename so the lookup against `availableLoras` works.
    const sidecarFilenames = img.loraFilenames?.length
      ? img.loraFilenames
      : (img.loraPaths || []).map((p) => p.split(/[\\/]/).pop());
    if (sidecarFilenames.length) {
      const restored = sidecarFilenames.map((fn, i) => {
        const match = availableLoras.find((l) => l.filename === fn);
        return match ? { filename: match.filename, name: match.name, scale: img.loraScales?.[i] ?? 1.0 } : null;
      }).filter(Boolean);
      setSelectedLoras(restored);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const notConnected = status && status.connected === false;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          {statusLoading ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-port-border bg-port-card text-gray-400">
              <RefreshCw className="w-3 h-3 animate-spin" /> Checking {effectiveMode}…
            </span>
          ) : status ? (
            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
              status.connected
                ? 'border-port-success/40 bg-port-success/10 text-port-success'
                : 'border-port-error/40 bg-port-error/10 text-port-error'
            }`}>
              {status.connected ? (
                <><span className="w-2 h-2 rounded-full bg-port-success" /> {status.model || (status.mode === IMAGE_GEN_MODE.LOCAL ? 'mflux/local' : status.mode === IMAGE_GEN_MODE.CODEX ? 'codex CLI' : 'external SD API')}</>
              ) : (
                <>
                  <AlertTriangle className="w-3 h-3" />
                  {status.reason || 'Not connected'} —
                  <button type="button" onClick={openSettings} className="underline">Settings</button>
                </>
              )}
            </span>
          ) : (
            <span className="text-gray-500">Checking…</span>
          )}
          {availableBackends.length > 1 && (
            <BackendChipStrip
              availableBackends={availableBackends}
              value={effectiveMode}
              onChange={handleSelectMode}
              disabled={statusLoading}
              loadingId={statusLoading ? effectiveMode : null}
              titlePrefix="Use"
            />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => refreshStatus(effectiveMode)}
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
            title="Image Gen settings"
          >
            <SettingsIcon className="w-3.5 h-3.5" /> Settings
          </button>
        </div>
      </div>

      <form onSubmit={handleGenerate} className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
          <StylePresetPicker
            value={stylePreset?.id || ''}
            onChange={setStylePreset}
            disabled={statusLoading}
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                disabled={statusLoading}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
                placeholder="Describe the image you want to generate..."
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Negative Prompt</label>
              <textarea
                value={negativePrompt}
                onChange={(e) => setNegativePrompt(e.target.value)}
                rows={3}
                disabled={statusLoading}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
                placeholder="What to avoid..."
              />
            </div>
          </div>

          {flux2Issue === 'venv' && (
            <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                FLUX.2 runtime isn't installed yet. PortOS can set it up automatically
                — torch + diffusers download, ~3-10 min on first run.
              </div>
              <button
                type="button"
                onClick={() => setFlux2InstallOpen(true)}
                disabled={statusLoading}
                className="self-start sm:self-auto whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80 disabled:opacity-50"
              >
                <Sparkles size={14} />
                Install FLUX.2
              </button>
            </div>
          )}
          {flux2Issue === 'token' && (
            <HfTokenBanner
              modelLabel={currentModel?.name || 'FLUX.2-klein'}
              licenseUrl={flux2Status.licenseUrl}
              onSaved={refreshFlux2Status}
            />
          )}
          {needsHfTokenGate && hfTokenPresent === false && (
            <HfTokenBanner
              modelLabel={currentModel?.name || modelId}
              licenseUrl={currentModel?.licenseUrl}
              onSaved={refreshHfTokenStatus}
            />
          )}

          <ImageGenControls
            mode={effectiveMode}
            models={models}
            modelId={modelId}
            // Reset steps + guidance when switching models so the placeholder
            // (model defaults) takes effect instead of leaking the previous
            // model's tuned values onto the new one.
            onModelChange={(id) => { setModelId(id); setSteps(''); setGuidance(''); }}
            width={width} height={height}
            onResolutionChange={(w, h) => { setWidth(w); setHeight(h); }}
            steps={steps} onStepsChange={setSteps}
            guidance={guidance} onGuidanceChange={setGuidance}
            cfgScale={cfgScale} onCfgScaleChange={setCfgScale}
            quantize={quantize} onQuantizeChange={setQuantize}
            seed={seed} onSeedChange={setSeed}
            showSeed
            disabled={statusLoading}
            modelStatus={isLocalMode ? modelDownload.getStatus(modelId) : null}
            onModelDownload={isLocalMode ? modelDownload.start : undefined}
            onModelDownloadCancel={modelDownload.cancel}
          />

          {isLocalMode && (
            <LoraPicker
              availableLoras={availableLoras}
              selected={selectedLoras}
              onChange={setSelectedLoras}
              currentRunnerFamily={currentRunnerFamily}
              onAppendTrigger={(words) => setPrompt((p) => appendTriggerWords(p, words))}
              disabled={statusLoading}
            />
          )}

          {isLocalMode && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                Init image <span className="text-gray-500 font-normal">(image-to-image — Flux only)</span>
              </label>
              {initImage.previewUrl ? (
                <div className="flex items-start gap-3">
                  <div className="relative shrink-0">
                    <img
                      src={initImage.previewUrl}
                      alt="Init"
                      className="w-16 h-16 object-cover rounded-lg border border-port-border bg-port-bg"
                    />
                    <button
                      type="button"
                      onClick={handleClearInitImage}
                      disabled={statusLoading}
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-port-card border border-port-border text-gray-300 hover:text-white hover:bg-port-error/40 flex items-center justify-center disabled:opacity-50"
                      title="Remove init image"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-xs text-gray-400 truncate" title={initImage.name}>{initImage.name}</div>
                    <label className="block text-[11px] text-gray-500">
                      Strength {initImageStrength.toFixed(2)}
                      <input
                        type="range" min={0} max={1} step={0.05}
                        value={initImageStrength}
                        disabled={statusLoading}
                        onChange={(e) => setInitImageStrength(Number(e.target.value))}
                        className="w-full accent-port-accent mt-1"
                      />
                    </label>
                  </div>
                </div>
              ) : (
                <label className="flex items-center justify-center gap-2 w-full px-3 py-2 border border-dashed border-port-border rounded-lg text-xs text-gray-400 hover:text-white hover:border-port-accent cursor-pointer transition-colors">
                  <ImageIcon className="w-4 h-4" />
                  Upload image to remix (PNG/JPG/WebP)
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handlePickInitImage} disabled={statusLoading} />
                </label>
              )}
            </div>
          )}

          {isLocalMode && isFlux2Model && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">
                Reference images <span className="text-gray-500 font-normal">(up to 4 images for FLUX.2 multi-reference edit)</span>
              </label>
              {/*
                FLUX.2 multi-reference editing — references are conditioned via
                diffusers' Flux2KleinKVPipeline (K/V-cache reference-token
                attention). First-time use prompts the user to accept the
                FLUX.2-klein-9B-kv license on Hugging Face. Per-reference
                strengths are honored end-to-end: scripts/flux2_macos.py
                patches Flux2KVLayerCache.store + _flux2_kv_causal_attention
                so each reference's V slice is scaled by its strength
                (1.0 = full influence, 0.0 = ignored).
              */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {referenceImages.map((slot, i) => {
                  const slotId = `ref-image-${i}`;
                  const strengthId = `ref-strength-${i}`;
                  return (
                    <div key={i} className="flex flex-col gap-1 p-2 rounded-lg border border-port-border bg-port-bg/30">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500">Ref {i + 1}</div>
                      {slot.previewUrl ? (
                        <>
                          <div className="relative">
                            <img
                              src={slot.previewUrl}
                              alt={`Reference ${i + 1}`}
                              className="w-full h-16 object-cover rounded border border-port-border bg-port-bg"
                            />
                            <button
                              type="button"
                              onClick={() => handleClearReferenceImage(i)}
                              disabled={statusLoading}
                              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-port-card border border-port-border text-gray-300 hover:text-white hover:bg-port-error/40 flex items-center justify-center disabled:opacity-50"
                              title={`Remove reference ${i + 1}`}
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                          <label htmlFor={strengthId} className="block text-[10px] text-gray-500">
                            Strength {slot.strength.toFixed(2)}
                          </label>
                          <input
                            id={strengthId}
                            type="range" min={0} max={1} step={0.05}
                            value={slot.strength}
                            disabled={statusLoading}
                            onChange={(e) => handleReferenceStrengthChange(i, Number(e.target.value))}
                            className="w-full accent-port-accent"
                          />
                        </>
                      ) : (
                        <label
                          htmlFor={slotId}
                          className="flex flex-col items-center justify-center gap-1 h-[88px] border border-dashed border-port-border rounded text-[10px] text-gray-500 hover:text-white hover:border-port-accent cursor-pointer transition-colors"
                        >
                          <ImageIcon className="w-4 h-4" />
                          Add
                          <input
                            id={slotId}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="hidden"
                            onChange={(e) => handlePickReferenceImage(i, e)}
                            disabled={statusLoading}
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1 flex-wrap">
            <button
              type="submit"
              disabled={!prompt.trim() || notConnected}
              className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg min-h-[40px]"
            >
              <Sparkles className="w-4 h-4" /> {generating ? 'Queue' : 'Generate'}
              {isAsyncMode && batchCount > 1 && <span className="text-xs opacity-80">× {batchCount}</span>}
            </button>
            {isAsyncMode && (
              <label className="flex items-center gap-1.5 text-xs text-gray-400" title="Batch size: number of renders to queue per submit">
                <span className="select-none">×</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={batchCount}
                  onChange={(e) => setBatchCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  className="w-14 bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
                />
              </label>
            )}
            {generating && (
              <button
                type="button"
                onClick={handleCancel}
                className="flex items-center gap-2 px-3 py-2 bg-port-error hover:bg-port-error/80 text-white text-sm font-medium rounded-lg min-h-[40px]"
              >
                <X className="w-4 h-4" /> Cancel current
              </button>
            )}
            {pendingQueued > 0 && (
              <span className="text-xs px-2 py-1 rounded bg-port-accent/20 text-port-accent border border-port-accent/30">
                +{pendingQueued} queued
              </span>
            )}
            {progressPct != null && <span className="text-xs text-port-accent">{progressPct}%</span>}
            {(generating || error) && (
              <span className={`text-xs truncate ${error ? 'text-port-error' : 'text-gray-400'}`}>
                {error ? String(error).split('\n')[0] : (stage ? (STAGE_LABELS[stage.name] || stage.name) : statusMsg) || 'Working...'}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1 text-xs text-gray-400">
            <label
              className="flex items-center gap-2 cursor-pointer select-none"
              title="Lossless strip of the gpt-image C2PA provenance chunk. Pixels untouched. Overrides the saved Settings → Image Gen default for this render only."
            >
              <input
                type="checkbox"
                checked={cleanC2PA}
                onChange={(e) => setCleanC2PA(e.target.checked)}
                className="rounded"
              />
              <span>
                Clean C2PA
                {savedCleanC2PAByMode[effectiveMode] !== undefined && cleanC2PA !== savedCleanC2PAByMode[effectiveMode] && (
                  <span className="ml-1 text-port-warning">(overrides saved default)</span>
                )}
              </span>
            </label>
            <label
              className="flex items-center gap-2 cursor-pointer select-none"
              title="Median + sharpen pass for AI-artifact reduction. WARNING: blurs annotation text and small details. Skip for sheets, infographics, comic panels."
            >
              <input
                type="checkbox"
                checked={denoise}
                onChange={(e) => setDenoise(e.target.checked)}
                className="rounded"
              />
              <span>
                Denoise <span className="text-port-warning">(blurs text)</span>
                {savedDenoiseByMode[effectiveMode] !== undefined && denoise !== savedDenoiseByMode[effectiveMode] && (
                  <span className="ml-1 text-port-warning">(overrides saved default)</span>
                )}
              </span>
            </label>
          </div>

          {error && (
            <div className="rounded-lg border border-port-error/40 bg-port-error/10 px-3 py-3 text-xs text-port-error space-y-2">
              <div className="font-semibold text-sm">
                {ERROR_HEADINGS[errorMeta?.kind] || 'Generation failed'}
              </div>
              <div className="whitespace-pre-wrap break-words text-port-warning/90">
                {String(error)}
              </div>
              {errorMeta?.kind === 'gated_repo' && errorMeta?.repo && (
                <a
                  href={`https://huggingface.co/${errorMeta.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
                >
                  Request access to {errorMeta.repo} ↗
                </a>
              )}
              {errorMeta?.kind === 'hf_unauthorized' && (
                <div className="text-port-warning/80">
                  Paste a fresh token in the HF token banner above (it appears when the model needs one).
                </div>
              )}
            </div>
          )}
        </div>

        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Preview</h2>
            {result && !generating && (
              <a href={result.path} download className="flex items-center gap-1 text-xs text-port-accent hover:underline">
                <Download className="w-3 h-3" /> Download
              </a>
            )}
          </div>

          <div className="aspect-square max-w-[360px] mx-auto bg-port-bg border border-port-border rounded-lg overflow-hidden flex items-center justify-center relative">
            {progress?.currentImage ? (
              <img src={`data:image/png;base64,${progress.currentImage}`} alt="Diffusing..." decoding="async" className="w-full h-full object-contain" />
            ) : result ? (
              <img src={result.path} alt={result.prompt} decoding="async" className="w-full h-full object-contain" />
            ) : generating ? (
              <div className="text-gray-500 text-sm flex flex-col items-center gap-2 px-4 text-center">
                <BrailleSpinner />
                <span className="font-medium text-gray-300">
                  {stage ? (STAGE_LABELS[stage.name] || stage.name) : (statusMsg || 'Starting diffusion…')}
                </span>
                {stage?.detail && (
                  <span className="text-[10px] text-gray-500 truncate max-w-[280px]">{stage.detail}</span>
                )}
              </div>
            ) : (
              <div className="text-gray-600 text-xs flex flex-col items-center gap-1.5">
                <ImageIcon className="w-8 h-8" />
                <span>Generated image will appear here</span>
              </div>
            )}

            {generating && progressPct != null && (
              <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                <div className="h-full bg-port-accent transition-all" style={{ width: `${progressPct}%` }} />
              </div>
            )}
          </div>

          {generating && progress?.totalSteps != null && (
            <div className="flex items-center justify-center gap-2 text-[11px] text-gray-400 tabular-nums">
              <span>step {progress.step ?? 0}/{progress.totalSteps}</span>
              {progressPct != null && <span className="text-gray-600">·</span>}
              {progressPct != null && <span>{progressPct}%</span>}
            </div>
          )}

          {result && !generating && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span className="truncate flex-1">{result.filename}</span>
              <span>{result.width}×{result.height}</span>
              {result.seed != null && <span>seed {result.seed}</span>}
              <button
                type="button"
                onClick={() => sendToVideo(result)}
                className="flex items-center gap-1 px-2 py-1 bg-port-success/20 hover:bg-port-success/40 text-port-success rounded text-xs"
              >
                <Film className="w-3 h-3" /> Send to Video
              </button>
            </div>
          )}
        </div>
      </form>

      <MediaJobsQueue kind="image" />

      {(visibleGallery.length > 0 || favoritesOnly) && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Recent renders ({Math.min(visibleGallery.length, 5)} of {visibleGallery.length})</h2>
            <div className="flex items-center gap-2">
              <FavoritesFilterChip active={favoritesOnly} onToggle={() => setFavoritesOnly((v) => !v)} />
              {visibleGallery.length > 5 && (
                <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>
              )}
            </div>
          </div>
          {visibleGallery.length === 0 ? (
            <div className="text-xs text-gray-500 py-3">No favorited images yet.</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {visibleGallery.slice(0, 5).map((img) => {
                const item = normalizeImage(img);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => setPreview(item)}
                    onRemix={() => handleRemix(img)}
                    onSendToVideo={() => sendToVideo(img)}
                    onDelete={() => handleDelete(img.filename)}
                    onToggleHidden={() => handleToggleHidden(item)}
                    {...getCardProps(item.key)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {hiddenGallery.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <button
            type="button"
            onClick={() => setShowHidden((s) => !s)}
            className="flex items-center justify-between w-full text-xs font-medium text-gray-400 uppercase tracking-wide hover:text-white"
          >
            <span>{showHidden ? 'Hide' : 'Show'} hidden ({hiddenGallery.length})</span>
            <span className="text-xs text-gray-500">{showHidden ? '▾' : '▸'}</span>
          </button>
          {showHidden && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {hiddenGallery.map((img) => {
                const item = normalizeImage(img);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => setPreview(item)}
                    onRemix={() => handleRemix(img)}
                    onSendToVideo={() => sendToVideo(img)}
                    onDelete={() => handleDelete(img.filename)}
                    onToggleHidden={() => handleToggleHidden(item)}
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
        onRemix={(item) => item?.raw && handleRemix(item.raw)}
        onSendToVideo={(item) => item?.raw?.filename && sendToVideo(item.raw)}
        onClean={(item) => handleClean(item?.raw)}
      />


      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings">
        <ImageGenTab />
      </Drawer>

      <Flux2InstallModal
        open={flux2InstallOpen}
        onClose={handleFlux2ModalClose}
        onComplete={handleFlux2InstallComplete}
      />
    </div>
  );
}
