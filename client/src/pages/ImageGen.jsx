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
import MediaLightbox from '../components/media/MediaLightbox';
import { normalizeImage } from '../components/media/normalize';
import {
  Image as ImageIcon, Sparkles, Download, RefreshCw, Settings as SettingsIcon,
  Dice5, AlertTriangle, X, Film, Cloud, Cpu, Terminal
} from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import { useImageGenProgress } from '../hooks/useImageGenProgress';
import {
  getImageGenStatus, generateImage, listImageModels, listLoras, listImageGallery,
  cancelImageGen, deleteImage, setImageHidden, getActiveImageJob, getSettings,
  buildFormData,
} from '../services/api';
import { randomSeed, safeParseJSON } from '../lib/genUtils';

const RESOLUTIONS = [
  { label: '512×512', w: 512, h: 512 },
  { label: '768×512', w: 768, h: 512 },
  { label: '512×768', w: 512, h: 768 },
  { label: '768×768', w: 768, h: 768 },
  { label: '1024×1024', w: 1024, h: 1024 },
  { label: '832×1216 (Flux portrait)', w: 832, h: 1216 },
  { label: '1216×832 (Flux landscape)', w: 1216, h: 832 },
  { label: '1024×576 (16:9)', w: 1024, h: 576 },
  { label: '576×1024 (9:16)', w: 576, h: 1024 },
];

const DEFAULT_NEGATIVE = 'blurry, low quality, distorted, deformed, ugly, watermark, text, signature';

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
  const [preview, setPreview] = useState(null);
  const [showHidden, setShowHidden] = useState(false);
  // FLUX.2 readiness — drives the gating banner. Lazy-fetched on the first
  // selection of a flux2 model so we don't make an extra request when the
  // user is only using mflux/external/codex.
  const [flux2Status, setFlux2Status] = useState(null);

  const [selectedMode, setSelectedMode] = useState(null);
  const [availableBackends, setAvailableBackends] = useState([]);

  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE);
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

  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [localProgress, setLocalProgress] = useState(null); // local mode SSE-driven 0..1
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const eventSourceRef = useRef(null);

  // External-mode socket-driven progress (kept for backward compat with
  // existing AUTOMATIC1111 wiring; the local mode also feeds the same hook
  // via imageGenEvents so the same UI bits light up).
  const { progress: externalProgress, begin: beginGenerate, end: endGenerate, resume: resumeGenerate } = useImageGenProgress();

  // selectedMode is null until settings load — fall back to status.mode
  // so the form doesn't flicker between defaults.
  const effectiveMode = selectedMode || status?.mode || 'external';
  const isLocalMode = effectiveMode === 'local';
  const isCodexMode = effectiveMode === 'codex';
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

  // Settings load — derives the chip strip and the initial selectedMode.
  // Re-runnable so the Settings drawer can trigger a refresh on close
  // without forcing a full page reload.
  const reloadBackends = useCallback(() => {
    return getSettings().then((s) => {
      const ig = s?.imageGen || {};
      const externalUrl = (ig.external?.sdapiUrl || ig.sdapiUrl || '').trim();
      const pyPath = (ig.local?.pythonPath || '').trim();
      const codexOn = ig.codex?.enabled === true;
      const backends = [];
      if (externalUrl) backends.push({ id: 'external', label: 'External', icon: Cloud });
      if (pyPath) backends.push({ id: 'local', label: 'Local', icon: Cpu });
      if (codexOn) backends.push({ id: 'codex', label: 'Codex', icon: Terminal });
      setAvailableBackends(backends);
      const saved = ig.mode || 'external';
      // Prefer the saved default if viable. If the user just disabled the
      // currently-selected backend, fall through to the first viable one
      // (so a freshly-configured setup or a just-toggled provider Just
      // Works without forcing a reload).
      setSelectedMode((prev) => {
        if (prev && backends.find((b) => b.id === prev)) return prev;
        if (backends.find((b) => b.id === saved)) return saved;
        if (backends.length) return backends[0].id;
        return saved;
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    listImageModels().then((m) => {
      setModels(m);
      if (m.length && !modelId) setModelId(m[0].id);
    }).catch(() => {});
    listLoras().then(setAvailableLoras).catch(() => {});
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
      // Re-attach the per-job SSE so raw status text resumes too.
      const es = new EventSource(`/api/image-gen/${activeJob.generationId}/events`);
      eventSourceRef.current = es;
      es.onmessage = (e) => {
        const msg = safeParseJSON(e.data);
        if (!msg) return;
        if (msg.type === 'status') setStatusMsg(msg.message);
        if (msg.type === 'progress') setLocalProgress({ progress: msg.progress });
        if (msg.type === 'complete' || msg.type === 'error' || msg.type === 'canceled') {
          setGenerating(false);
          es.close();
        }
      };
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
  // Object URL cleanup on unmount.
  useEffect(() => () => {
    if (initImage.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(initImage.previewUrl);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const matchedResolution = RESOLUTIONS.find((r) => r.w === width && r.h === height);
  const resolutionLabel = matchedResolution?.label || `${width}×${height}`;
  const isFlux2Model = currentModel?.runner === 'flux2';

  useEffect(() => {
    if (!isFlux2Model) { setFlux2Status(null); return; }
    // Abort the in-flight request when the user switches models before it
    // resolves — otherwise a stale response could re-show the banner for
    // a non-flux2 selection.
    const controller = new AbortController();
    fetch('/api/image-gen/setup/flux2-status', { signal: controller.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((s) => { if (s) setFlux2Status(s); })
      .catch(() => {});
    return () => controller.abort();
  }, [isFlux2Model, modelId]);

  const flux2Issue = isFlux2Model && flux2Status
    ? (!flux2Status.venvInstalled ? 'venv' : !flux2Status.hfTokenPresent ? 'token' : null)
    : null;
  const { visibleGallery, hiddenGallery } = useMemo(() => ({
    visibleGallery: gallery.filter((img) => !img.hidden),
    hiddenGallery: gallery.filter((img) => img.hidden),
  }), [gallery]);

  const handleResolutionChange = (e) => {
    const r = RESOLUTIONS.find((r) => r.label === e.target.value);
    if (r) { setWidth(r.w); setHeight(r.h); }
  };

  const handleRandomSeed = () => setSeed(randomSeed());

  const startLocalGeneration = async () => {
    setLocalProgress({ progress: 0 });
    // Codex shares the SSE-driven async pipeline with local. The codex
    // payload below intentionally omits local-only knobs (model, LoRAs,
    // quantize, guidance, steps, seed) — the codex provider only consumes
    // prompt/negative/width/height, so we don't bother sending the rest.
    const payload = isCodexMode ? {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim() || undefined,
      width, height,
      mode: 'codex',
    } : {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt.trim() || undefined,
      modelId: modelId || undefined,
      width, height,
      steps: steps ? Number(steps) : undefined,
      guidance: guidance ? Number(guidance) : undefined,
      seed: seed && Number(seed) >= 0 ? Number(seed) : undefined,
      quantize,
      loraFilenames: selectedLoras.map((l) => l.filename),
      loraScales: selectedLoras.map((l) => l.scale),
      mode: 'local',
    };
    // i2i (local Flux): switch to multipart so the init image travels with
    // the prompt payload. The route's optional-multipart middleware accepts
    // both shapes against the same endpoint.
    const hasInitImage = isLocalMode && initImage.source != null;
    let data;
    if (hasInitImage) {
      const fd = buildFormData({
        ...payload,
        ...(initImage.source === 'upload' ? { initImage: initImage.file } : { initImageFile: initImage.name }),
        initImageStrength,
      });
      const res = await fetch('/api/image-gen/generate', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      data = await res.json();
    } else {
      data = await generateImage(payload);
    }

    return new Promise((resolve, reject) => {
      const jobId = data.jobId || data.generationId;
      const es = new EventSource(`/api/image-gen/${jobId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (ev) => {
        const msg = safeParseJSON(ev.data);
        if (!msg) return;
        if (msg.type === 'status') setStatusMsg(msg.message);
        if (msg.type === 'progress') {
          setLocalProgress({ progress: msg.progress });
          setStatusMsg(msg.message);
        }
        if (msg.type === 'complete') {
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
          es.close();
          resolve(msg.result);
        }
        if (msg.type === 'error') {
          es.close();
          reject(new Error(msg.error));
        }
        if (msg.type === 'canceled') {
          es.close();
          reject(new Error(msg.reason || 'Canceled'));
        }
      };
      es.onerror = () => {
        es.close();
        reject(new Error('Lost connection to server'));
      };
    });
  };

  const handleGenerate = async (e) => {
    e?.preventDefault?.();
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setStatusMsg('Starting...');
    setError(null);
    setResult(null);
    // Both modes go through the socket-driven progress hook now — local mflux
    // emits stepwise frames via the imageGenEvents bus the same way external
    // SD API does, so the same hook drives the live preview for both.
    beginGenerate();

    try {
      if (isAsyncMode) {
        await startLocalGeneration();
      } else {
        const payload = {
          prompt: prompt.trim(),
          negativePrompt: negativePrompt.trim() || undefined,
          width, height,
          steps: steps ? Number(steps) : 25,
          cfgScale,
          mode: 'external',
        };
        if (seed && Number(seed) >= 0) payload.seed = Number(seed);
        const data = await generateImage(payload);
        setResult({ ...data, prompt: payload.prompt, negativePrompt: payload.negativePrompt, width, height, steps: payload.steps, cfgScale });
      }
      toast.success('Image generated');
      refreshGallery();
    } catch (err) {
      setError(err.message || 'Image generation failed');
      toast.error(err.message || 'Image generation failed');
    } finally {
      setGenerating(false);
      setLocalProgress(null);
      endGenerate();
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
          {status ? (
            <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
              status.connected
                ? 'border-port-success/40 bg-port-success/10 text-port-success'
                : 'border-port-error/40 bg-port-error/10 text-port-error'
            }`}>
              {status.connected ? (
                <><span className="w-2 h-2 rounded-full bg-port-success" /> {status.model || (status.mode === 'local' ? 'mflux/local' : status.mode === 'codex' ? 'codex CLI' : 'external SD API')}</>
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
            <div className="inline-flex items-center gap-1 p-0.5 border border-port-border rounded-full bg-port-bg" role="group" aria-label="Backend">
              {availableBackends.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedMode(id)}
                  disabled={generating}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs transition-colors disabled:opacity-50 ${effectiveMode === id ? 'bg-port-accent text-white' : 'text-gray-400 hover:text-white hover:bg-port-border/40'}`}
                  title={`Use ${label} for the next render`}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              ))}
            </div>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Prompt</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                disabled={generating}
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
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50 resize-y"
                placeholder="What to avoid..."
              />
            </div>
          </div>

          {flux2Issue === 'venv' && (
            <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
              FLUX.2 venv not found at <code className="text-white">{flux2Status.expectedVenvPath}</code>.
              Run <code className="text-white">INSTALL_FLUX2=1 bash scripts/setup-image-video.sh</code> to bootstrap it.
            </div>
          )}
          {flux2Issue === 'token' && (
            <div className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
              FLUX.2-klein is gated. Accept the license at{' '}
              <a href={flux2Status.licenseUrl} target="_blank" rel="noreferrer" className="underline text-white">
                huggingface.co/black-forest-labs/FLUX.2-klein-4B
              </a>{' '}
              and export <code className="text-white">HF_TOKEN=…</code> before running PortOS.
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {isLocalMode && models.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
                <select
                  value={modelId}
                  onChange={(e) => { setModelId(e.target.value); setSteps(''); setGuidance(''); }}
                  disabled={generating}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                >
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Resolution</label>
              <select
                value={resolutionLabel}
                onChange={handleResolutionChange}
                disabled={generating}
                className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
              >
                {RESOLUTIONS.map((r) => <option key={r.label} value={r.label}>{r.label}</option>)}
                {!matchedResolution && <option value={resolutionLabel}>{resolutionLabel} (custom)</option>}
              </select>
            </div>

            {/* Codex's built-in image_gen tool ignores seed/steps/guidance —
                only the prompt + (optional) resolution hint matter. Hide
                irrelevant knobs in that mode. */}
            {!isCodexMode && (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Seed</label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    disabled={generating}
                    placeholder="Random"
                    className="flex-1 bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={handleRandomSeed}
                    disabled={generating}
                    className="p-2 text-gray-400 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 disabled:opacity-50 min-h-[40px] min-w-[40px] flex items-center justify-center"
                    title="Randomize seed"
                  >
                    <Dice5 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {!isCodexMode && (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Steps {currentModel?.steps && `(default: ${currentModel.steps})`}
                </label>
                <input
                  type="number" min={1} max={150}
                  value={steps}
                  onChange={(e) => setSteps(e.target.value)}
                  placeholder={String(currentModel?.steps || 25)}
                  disabled={generating}
                  className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                />
              </div>
            )}

            {!isCodexMode && (isLocalMode ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-gray-400 mb-1">
                    Guidance {currentModel?.guidance != null && `(default: ${currentModel.guidance})`}
                  </label>
                  <input
                    type="number" min={0} max={20} step={0.5}
                    value={guidance}
                    onChange={(e) => setGuidance(e.target.value)}
                    placeholder={String(currentModel?.guidance ?? '')}
                    disabled={generating}
                    className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                  />
                </div>
                {!isFlux2Model && (
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-1">Quantize (bits)</label>
                    <select
                      value={quantize}
                      onChange={(e) => setQuantize(e.target.value)}
                      disabled={generating}
                      className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
                    >
                      {['3', '4', '5', '6', '8'].map((q) => <option key={q} value={q}>{q}-bit{q === '8' ? ' (default)' : q === '4' ? ' (fast)' : ''}</option>)}
                    </select>
                  </div>
                )}
              </>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">CFG Scale ({cfgScale})</label>
                <input
                  type="range" min={1} max={20} step={0.5}
                  value={cfgScale}
                  disabled={generating}
                  onChange={(e) => setCfgScale(Number(e.target.value))}
                  className="w-full accent-port-accent"
                />
              </div>
            ))}
          </div>

          {isLocalMode && !isFlux2Model && availableLoras.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">LoRAs</label>
              <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                {availableLoras.map((lora) => {
                  const selected = selectedLoras.find((s) => s.filename === lora.filename);
                  return (
                    <div key={lora.filename} className="flex items-center gap-2">
                      <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                        <input
                          type="checkbox"
                          checked={!!selected}
                          disabled={generating}
                          onChange={(e) => {
                            if (e.target.checked) setSelectedLoras((p) => [...p, { filename: lora.filename, name: lora.name, scale: 1.0 }]);
                            else setSelectedLoras((p) => p.filter((s) => s.filename !== lora.filename));
                          }}
                          className="rounded"
                        />
                        <span className="text-xs text-gray-300 truncate">{lora.name}</span>
                      </label>
                      {selected && (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">Scale</span>
                          <input
                            type="number" min={0} max={2} step={0.1}
                            value={selected.scale}
                            disabled={generating}
                            onChange={(e) => {
                              const scale = parseFloat(e.target.value) || 0;
                              setSelectedLoras((p) => p.map((s) => s.filename === lora.filename ? { ...s, scale } : s));
                            }}
                            className="w-20 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
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
                      disabled={generating}
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
                        disabled={generating}
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
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handlePickInitImage} disabled={generating} />
                </label>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
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
                disabled={!prompt.trim() || notConnected}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg min-h-[40px]"
              >
                <Sparkles className="w-4 h-4" /> Generate
              </button>
            )}
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
              <div className="text-gray-500 text-sm flex flex-col items-center gap-2">
                <BrailleSpinner />
                <span>{statusMsg || 'Starting diffusion...'}</span>
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

      {visibleGallery.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Recent renders ({Math.min(visibleGallery.length, 6)} of {visibleGallery.length})</h2>
            {visibleGallery.length > 6 && (
              <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
            {visibleGallery.slice(0, 6).map((img) => {
              const item = normalizeImage(img);
              return (
                <MediaCard
                  key={item.key}
                  item={item}
                  onPreview={() => setPreview(img)}
                  onRemix={() => handleRemix(img)}
                  onSendToVideo={() => sendToVideo(img)}
                  onDelete={() => handleDelete(img.filename)}
                  onToggleHidden={() => handleToggleHidden(item)}
                />
              );
            })}
          </div>
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
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {hiddenGallery.map((img) => {
                const item = normalizeImage(img);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => setPreview(img)}
                    onRemix={() => handleRemix(img)}
                    onSendToVideo={() => sendToVideo(img)}
                    onDelete={() => handleDelete(img.filename)}
                    onToggleHidden={() => handleToggleHidden(item)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      <MediaLightbox
        item={preview ? normalizeImage(preview) : null}
        onClose={() => setPreview(null)}
        // Guard against the click landing after the lightbox close path has
        // already nulled `preview` — without this the closure throws on
        // preview.filename access.
        onRemix={() => preview && handleRemix(preview)}
        onSendToVideo={() => preview?.filename && sendToVideo(preview)}
      />


      <Drawer open={settingsOpen} onClose={closeSettings} title="Media Generation Settings">
        <ImageGenTab />
      </Drawer>
    </div>
  );
}
