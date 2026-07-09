import { useState, useRef, useCallback, useEffect } from 'react';
import { Eraser, Upload, Download, ShieldCheck, Sparkles, Brush, Square, Undo2, X, Cpu, Zap, Save } from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import IgnoreZonePainter from '../components/media/IgnoreZonePainter';
import * as api from '../services/api';
import useMediaJobProgress from '../hooks/useMediaJobProgress';
import { formatBytes } from '../utils/formatters';

const ALLOWED_EXT = /\.(png|jpe?g|webp)$/i;
const ALLOWED_MIME = /^image\/(png|jpe?g|webp)$/i;

// Detect pixel dimensions from a File without uploading — load it into an
// <img> and read naturalWidth/Height. Resolves to null on decode failure so the
// caller just omits the pre-clean dimensions instead of blocking the upload.
function detectDimensions(objectUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = objectUrl;
  });
}

const megapixels = (w, h) => (w && h ? (w * h) / 1_000_000 : 0);

export default function ImageClean() {
  // { previewUrl, file, size, name, width, height }
  const [original, setOriginal] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  // Opt-in pipeline steps. metadata defaults ON (lossless), denoise OFF (lossy),
  // diffusion OFF (lossy — CPU light pass or GPU FLUX round-trip).
  const [steps, setSteps] = useState({ metadata: true, denoise: false, diffusion: false });
  // Diffusion sub-mode: 'gpu' (FLUX round-trip, hardware-gated) or 'cpu' (light
  // spatial pass, always available). Auto-selected by hardware once availability
  // loads; the user can override. `regen` carries the availability payload
  // (strength bounds, model id, reason) so the strength slider stays in lock-step
  // with server validation. null until the probe returns.
  const [diffusionMode, setDiffusionMode] = useState('cpu');
  const [regen, setRegen] = useState(null);
  const [strength, setStrength] = useState(0.25);
  const [maxMp, setMaxMp] = useState(''); // '' = use server default budget
  // GPU job tracking (issue #2264). When a GPU clean is enqueued the server
  // returns a jobId; we track it via the media-job channel, then fetch the
  // finished bytes. `gpuJobId` drives the progress hook; `gpuResult` holds the
  // fetched render + whether it was saved to the gallery.
  const [gpuJobId, setGpuJobId] = useState(null);
  const [gpuJob, setGpuJob] = useState(null); // enqueue descriptor (modelId, strength, ...)
  const [savedFilename, setSavedFilename] = useState(null);
  const [saving, setSaving] = useState(false);
  // Ignore-zone (preserve-region) mask state — only relevant when the diffusion
  // step is on. `maskTool`/`brushSize`/`feather` drive the painter; `hasMask`
  // reflects whether any region is painted so the re-clean knows to send it.
  const [maskTool, setMaskTool] = useState('brush');
  const [brushSize, setBrushSize] = useState(40);
  const [feather, setFeather] = useState(3);
  const [hasMask, setHasMask] = useState(false);
  const painterRef = useRef(null);
  const fileInputRef = useRef(null);
  const requestIdRef = useRef(0);
  const previewUrlRef = useRef(null);
  const resultUrlRef = useRef(null);

  // Live progress for the GPU clean job (no-op when gpuJobId is null).
  const jobProgress = useMediaJobProgress(gpuJobId, { kind: 'image' });

  // Probe local FLUX availability once on mount — auto-select GPU when a runner
  // is installed, else fall back to the always-available CPU light pass. Also
  // seeds the strength slider bounds/default so it matches server validation.
  useEffect(() => {
    let alive = true;
    api.getRegenAvailability().then((info) => {
      if (!alive || !info) return;
      setRegen(info);
      setStrength(typeof info.strengthDefault === 'number' ? info.strengthDefault : 0.25);
      setDiffusionMode(info.available ? 'gpu' : 'cpu');
    }).catch(() => {
      // Availability is best-effort — if it fails, stay on the CPU light pass
      // (always available) with the conservative defaults already set.
    });
    return () => { alive = false; };
  }, []);

  // Revoke any outstanding blob URL on unmount so we don't leak.
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
  }, []);

  // Once the tracked GPU job completes, fetch the finished bytes and show them
  // in the After preview. Gated on the jobId so a stale completion (user moved
  // on) can't overwrite a newer render.
  useEffect(() => {
    if (!gpuJobId || jobProgress.status !== 'completed') return;
    let alive = true;
    const myJob = gpuJobId;
    // The socket `completed` event can (rarely) beat the render's final disk
    // write, so a `pending` (409) result gets a few bounded retries rather than
    // stranding the spinner. The server writes the PNG before emitting the
    // event, so in practice the first attempt succeeds.
    const attempt = (tries) => {
      api.fetchCleanResult(myJob).then((res) => {
        if (!alive || myJob !== gpuJobId) return;
        if (res.pending) {
          if (tries > 0) setTimeout(() => { if (alive && myJob === gpuJobId) attempt(tries - 1); }, 600);
          else { setBusy(false); toast.error('GPU clean result never became available'); }
          return;
        }
        if (resultUrlRef.current) { URL.revokeObjectURL(resultUrlRef.current); resultUrlRef.current = null; }
        const objectUrl = URL.createObjectURL(res.blob);
        resultUrlRef.current = objectUrl;
        const report = res.report || {};
        setResult({
          format: 'png',
          width: report.width,
          height: report.height,
          sizeAfter: res.blob.size,
          sizeBefore: original?.size || res.blob.size,
          mimeType: res.mimeType,
          objectUrl,
          steps: gpuJob?.steps || [],
          c2paStripped: !!gpuJob?.c2paStripped,
          c2paPresent: !!gpuJob?.c2paPresent,
          gpu: true,
        });
        setBusy(false);
        toast.success('GPU clean complete');
      }).catch((err) => {
        if (!alive) return;
        setBusy(false);
        toast.error(err.message || 'Failed to fetch clean result');
      });
    };
    attempt(5);
    return () => { alive = false; };
  }, [gpuJobId, jobProgress.status, original, gpuJob]);

  // A failed/canceled GPU job clears the spinner and surfaces the error.
  useEffect(() => {
    if (!gpuJobId) return;
    if (jobProgress.status === 'failed' || jobProgress.status === 'canceled') {
      setBusy(false);
      toast.error(jobProgress.error || `GPU clean ${jobProgress.status}`);
    }
  }, [gpuJobId, jobProgress.status, jobProgress.error]);

  // `skipMask` lets a caller (e.g. Clear) force a mask-free re-clean without
  // depending on the painter ref having flushed its React state yet — clear()
  // only schedules state, so reading painterRef.hasMask in the same tick would
  // still see the stale mask. The Clear path passes skipMask:true explicitly.
  const runClean = useCallback(async (file, selectedSteps, mode, opts = {}) => {
    const { skipMask = false } = opts;
    if (!file) return;
    const myRequestId = ++requestIdRef.current;
    setBusy(true);
    // Reset any prior GPU job/result state on a fresh run.
    setGpuJobId(null);
    setGpuJob(null);
    setSavedFilename(null);
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    setResult(null);
    // Map the diffusion toggle + sub-mode to the server's mode enum.
    const diffusion = selectedSteps.diffusion ? (mode === 'gpu' ? 'gpu' : 'light') : 'off';
    const payload = {
      metadata: selectedSteps.metadata,
      denoise: selectedSteps.denoise,
      diffusion,
    };
    // GPU-only diffusion knobs.
    if (diffusion === 'gpu') {
      payload.strength = strength;
      const mp = Number(maxMp);
      if (maxMp !== '' && Number.isFinite(mp) && mp > 0) payload.maxMp = mp;
    }
    // Ignore-zone mask only matters when a diffusion pass runs — export the
    // painted preserve-region as a PNG Blob and ride it in the request envelope
    // so the server composites original pixels back into the masked regions.
    if (!skipMask && selectedSteps.diffusion && painterRef.current?.hasMask) {
      const maskBlob = await painterRef.current.exportMaskBlob();
      if (maskBlob) {
        payload.mask = maskBlob;
        payload.feather = feather;
      }
    }
    const cleaned = await api.cleanImage(file, payload).catch((err) => {
      toast.error(err.message || 'Failed to clean image');
      return null;
    });
    // Drop responses from a stale click — a newer reclean is in flight.
    if (myRequestId !== requestIdRef.current) return;
    if (!cleaned) {
      setBusy(false);
      return;
    }
    // GPU path: the server enqueued a job. Track it — the progress effect fetches
    // the bytes on completion. Keep `busy` true (the spinner shows job progress).
    if (cleaned.gpu) {
      if (!cleaned.job?.jobId) {
        setBusy(false);
        toast.error('GPU clean did not return a job id');
        return;
      }
      setGpuJob(cleaned.job);
      setGpuJobId(cleaned.job.jobId);
      return;
    }
    setBusy(false);
    const objectUrl = URL.createObjectURL(cleaned.blob);
    resultUrlRef.current = objectUrl;
    const report = cleaned.report || {};
    setResult({ ...report, mimeType: cleaned.mimeType, objectUrl });
    toast.success(report.c2paStripped ? 'C2PA chunk removed' : 'Image cleaned');
  }, [feather, strength, maxMp]);

  const handleFile = async (file) => {
    if (!file) return;
    // Server-side magic-byte sniff is the source of truth. Only fail-fast in the
    // client when BOTH MIME and extension are present and clearly not supported
    // — missing/empty values (common on drag from the file system) fall through
    // to the server. No byte cap: the server streams raw bytes (256MB transport
    // limit) and guards against decompression bombs by pixel count.
    const hasMime = !!file.type;
    const hasExt = /\./.test(file.name || '');
    const mimeOk = hasMime ? ALLOWED_MIME.test(file.type) : null;
    const extOk = hasExt ? ALLOWED_EXT.test(file.name) : null;
    if (mimeOk === false && extOk === false) {
      toast.error('Only PNG, JPEG, and WebP images are supported');
      return;
    }

    // Use a blob URL for the Before preview and dimension detection.
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    previewUrlRef.current = previewUrl;
    const dims = await detectDimensions(previewUrl);

    setOriginal({
      previewUrl,
      file,
      size: file.size,
      name: file.name,
      width: dims?.width || null,
      height: dims?.height || null,
    });
    // Auto-run the sync pipeline on select. If the GPU sub-mode is active it's
    // NOT auto-enqueued (see `autoRun`) — the user tunes strength/max-MP then
    // clicks "Run GPU clean", so the render reads the settings they see.
    autoRun(file, steps, diffusionMode);
  };

  // A GPU diffusion run is expensive (GPU-serialized, queued) and has tunable
  // params (strength / max-MP) — so it only fires from an explicit button, never
  // as a side effect of toggling a step or switching mode (which would enqueue
  // with stale params, then silently ignore later slider moves). Sync pipelines
  // (metadata / denoise / CPU light) stay auto-run for instant feedback.
  const willUseGpu = (selectedSteps, mode) => !!selectedSteps.diffusion && mode === 'gpu';
  const autoRun = (file, selectedSteps, mode, opts) => {
    if (!file) return;
    if (willUseGpu(selectedSteps, mode)) {
      // Clear a stale sync result so the After panel shows the "run GPU" prompt
      // rather than a now-inconsistent preview.
      if (resultUrlRef.current) { URL.revokeObjectURL(resultUrlRef.current); resultUrlRef.current = null; }
      setResult(null);
      setGpuJobId(null);
      setGpuJob(null);
      setBusy(false);
      return;
    }
    runClean(file, selectedSteps, mode, opts);
  };

  const toggleStep = (key) => {
    // Compute next outside setState so the updater stays pure (no side effects).
    const next = { ...steps, [key]: !steps[key] };
    setSteps(next);
    // Re-run immediately against the new selection so the After preview always
    // reflects the current steps (GPU is gated behind the explicit button).
    if (original?.file) autoRun(original.file, next, diffusionMode);
  };

  const changeDiffusionMode = (mode) => {
    setDiffusionMode(mode);
    if (original?.file && steps.diffusion) autoRun(original.file, steps, mode);
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleReset = () => {
    requestIdRef.current++;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    // Clear the input so picking the same file again still fires onChange
    // (browsers suppress onChange when the value is unchanged).
    if (fileInputRef.current) fileInputRef.current.value = '';
    setOriginal(null);
    setResult(null);
    setBusy(false);
    setGpuJobId(null);
    setGpuJob(null);
    setSavedFilename(null);
  };

  const saveToGallery = async () => {
    if (!gpuJobId || saving) return;
    setSaving(true);
    const saved = await api.saveCleanResult(gpuJobId, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to save to gallery');
      return null;
    });
    setSaving(false);
    if (saved?.filename) {
      setSavedFilename(saved.filename);
      toast.success('Saved to gallery');
    }
  };

  const downloadName = (() => {
    if (!original?.name) return 'cleaned';
    const dot = original.name.lastIndexOf('.');
    const stem = dot > 0 ? original.name.slice(0, dot) : original.name;
    const ext = result?.format === 'jpeg' ? 'jpg' : result?.format || 'png';
    return `${stem}.cleaned.${ext}`;
  })();

  const sizeDelta = result ? result.sizeAfter - result.sizeBefore : 0;
  const sizeDeltaPct = result && result.sizeBefore > 0
    ? ((sizeDelta / result.sizeBefore) * 100).toFixed(1)
    : '0.0';

  // Render-budget analysis for the GPU path (issue #2264). The GPU render
  // downscales to fit FLUX's O(tokens²) attention budget, then upscales back —
  // so a source over the budget takes a fidelity hit worth warning about.
  const srcMp = megapixels(original?.width, original?.height);
  const budgetMp = (() => {
    const n = Number(maxMp);
    return maxMp !== '' && Number.isFinite(n) && n > 0 ? n : 2.0; // DEFAULT_MAX_REGEN_MEGAPIXELS
  })();
  const overBudget = srcMp > budgetMp;

  const STEP_DEFS = [
    {
      key: 'metadata',
      label: 'Strip metadata & C2PA',
      hint: 'Removes the C2PA provenance chunk plus EXIF/XMP/IPTC and text metadata. Lossless for PNG (pixels untouched); JPEG/WebP are re-encoded.',
    },
    {
      key: 'denoise',
      label: 'Median + sharpen',
      hint: 'Lossy — reduces visible AI-generation artifacts but blurs fine text. Re-encodes the image.',
    },
    {
      key: 'diffusion',
      label: 'Diffusion pass — disrupt SynthID',
      hint: 'Lossy, best-effort — round-trips the pixels to perturb SynthID\'s watermark carriers. This is the only step that touches SynthID, and it disrupts — never guarantees removal. Blurs fine text (use the ignore-zone mask to preserve regions).',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Eraser size={24} className="text-port-accent" />
            Image Cleaner
          </h2>
          <p className="text-gray-500 text-sm">
            Composable, opt-in pipeline: strip provenance/identifying metadata and/or reduce AI-generation artifacts.
          </p>
          <p className="text-gray-500 text-xs mt-1">
            <span className="text-port-warning">Note:</span>{' '}
            the metadata and median/sharpen passes do NOT defeat SynthID — gpt-image / Imagen / Gemini renders stay detectable by their
            vendor watermark checkers (e.g.{' '}
            <a href="https://openai.com/synthid" target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline">
              openai.com/synthid
            </a>
            ), since SynthID is embedded in pixel values and was designed to survive median + sharpen + re-encode. The <strong>diffusion pass</strong>{' '}
            is the only step that perturbs SynthID's carriers — best-effort, and it <em>disrupts</em> rather than guarantees removal (never verified against
            Google's detector).
          </p>
        </div>
      </div>

      {!original && (
        <div
          className={`relative p-12 border-2 border-dashed rounded-lg text-center transition-colors ${
            dragActive
              ? 'border-port-accent bg-port-accent/10'
              : 'border-port-border hover:border-port-accent/50 bg-port-card'
          }`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              handleFile(file);
            }}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          <Upload size={40} className={`mx-auto mb-4 ${dragActive ? 'text-port-accent' : 'text-gray-500'}`} />
          <p className="text-white mb-2">
            {dragActive ? 'Drop image here' : 'Drag and drop an image here'}
          </p>
          <p className="text-gray-500 text-sm mb-4">PNG, JPEG, or WebP</p>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg transition-colors"
          >
            Browse File
          </button>
        </div>
      )}

      {original && (
        <div className="space-y-6">
          {/* Step selector */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={16} className="text-port-accent" />
              <span className="text-sm font-medium text-white">Pipeline steps</span>
              <span className="text-xs text-gray-500">run in order: metadata → median/sharpen → diffusion</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {STEP_DEFS.map(({ key, label, hint }) => (
                <label
                  key={key}
                  htmlFor={`step-${key}`}
                  className="flex items-start gap-3 p-3 rounded-lg border border-port-border hover:border-port-accent/50 cursor-pointer transition-colors"
                >
                  <input
                    id={`step-${key}`}
                    type="checkbox"
                    checked={steps[key]}
                    onChange={() => toggleStep(key)}
                    disabled={busy}
                    className="mt-1 accent-port-accent"
                  />
                  <span>
                    <span className="block text-sm text-white">{label}</span>
                    <span className="block text-xs text-gray-500">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Diffusion options — sub-mode + resolution-aware controls (issue #2264) */}
          {steps.diffusion && (
            <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
              <div className="flex items-center gap-2">
                <Zap size={16} className="text-port-accent" />
                <span className="text-sm font-medium text-white">Diffusion sub-mode</span>
              </div>
              {/* Sub-mode selector — GPU (hardware-gated) vs CPU light pass. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => changeDiffusionMode('gpu')}
                  disabled={busy || !regen?.available}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    diffusionMode === 'gpu'
                      ? 'border-port-accent bg-port-accent/10'
                      : 'border-port-border hover:border-port-accent/50'
                  } ${!regen?.available ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <span className="flex items-center gap-2 text-sm text-white"><Zap size={14} /> GPU FLUX round-trip</span>
                  <span className="block text-xs text-gray-500 mt-1">
                    {regen?.available
                      ? `Higher reliability. Model: ${regen.modelId || 'local FLUX'}. GPU-serialized (queued).`
                      : (regen?.reason || 'No local FLUX runner installed.')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => changeDiffusionMode('cpu')}
                  disabled={busy}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    diffusionMode === 'cpu'
                      ? 'border-port-accent bg-port-accent/10'
                      : 'border-port-border hover:border-port-accent/50'
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm text-white"><Cpu size={14} /> CPU light pass</span>
                  <span className="block text-xs text-gray-500 mt-1">
                    Always available, synchronous. Best-effort spatial round-trip — lower reliability than the GPU pass.
                  </span>
                </button>
              </div>

              {/* GPU-only resolution-aware options. */}
              {diffusionMode === 'gpu' && (
                <div className="space-y-3 border-t border-port-border pt-3">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                    <div className="flex items-center gap-2 flex-1">
                      <label htmlFor="strength" className="text-xs text-gray-500 whitespace-nowrap">Denoise strength</label>
                      <input
                        id="strength"
                        type="range"
                        min={regen?.strengthMin ?? 0.02}
                        max={regen?.strengthMax ?? 0.6}
                        step="0.01"
                        value={strength}
                        onChange={(e) => setStrength(Number(e.target.value))}
                        disabled={busy}
                        className="flex-1 accent-port-accent"
                      />
                      <span className="text-xs text-gray-400 w-10 text-right">{strength.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-1">
                      <label htmlFor="max-mp" className="text-xs text-gray-500 whitespace-nowrap">Max render MP</label>
                      <input
                        id="max-mp"
                        type="number"
                        min="0.25"
                        max="16"
                        step="0.25"
                        value={maxMp}
                        placeholder="2.0 (default)"
                        onChange={(e) => setMaxMp(e.target.value)}
                        disabled={busy}
                        className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-gray-500">
                    A universal resolution-squeeze (~0.9×) is applied automatically as a second disruption vector, then the render is upscaled back to source dimensions.
                  </p>
                  {overBudget && (
                    <p className="text-xs text-port-warning">
                      Source is {srcMp.toFixed(1)}MP, above the {budgetMp.toFixed(1)}MP render budget — the render downscales to fit FLUX's attention budget, then upscales back to {original.width}×{original.height}. Expect some fidelity loss.
                    </p>
                  )}
                  {/* Explicit run trigger — GPU never auto-enqueues, so the
                      render always reads the strength/max-MP shown here. */}
                  <button
                    type="button"
                    onClick={() => { if (original?.file) runClean(original.file, steps, 'gpu'); }}
                    disabled={busy || !regen?.available}
                    className="px-4 py-2 rounded-lg text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors flex items-center gap-2 w-full sm:w-auto"
                  >
                    <Zap size={16} />
                    {busy && gpuJobId ? 'Rendering…' : 'Run GPU clean'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Ignore-zone (preserve-region) mask painter — only when diffusion is on */}
          {steps.diffusion && (
            <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Brush size={16} className="text-port-accent" />
                  <span className="text-sm font-medium text-white">Ignore zone (preserve region)</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setMaskTool('brush')}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 border transition-colors ${maskTool === 'brush' ? 'border-port-accent text-port-accent bg-port-accent/10' : 'border-port-border text-gray-400 hover:text-white'}`}
                  >
                    <Brush size={12} /> Brush
                  </button>
                  <button
                    onClick={() => setMaskTool('rect')}
                    className={`px-2 py-1 rounded text-xs flex items-center gap-1 border transition-colors ${maskTool === 'rect' ? 'border-port-accent text-port-accent bg-port-accent/10' : 'border-port-border text-gray-400 hover:text-white'}`}
                  >
                    <Square size={12} /> Rectangle
                  </button>
                  <button
                    onClick={() => { painterRef.current?.undo(); }}
                    className="px-2 py-1 rounded text-xs flex items-center gap-1 border border-port-border text-gray-400 hover:text-white transition-colors"
                  >
                    <Undo2 size={12} /> Undo
                  </button>
                  <button
                    onClick={() => { painterRef.current?.clear(); if (original?.file) autoRun(original.file, steps, diffusionMode, { skipMask: true }); }}
                    className="px-2 py-1 rounded text-xs flex items-center gap-1 border border-port-border text-gray-400 hover:text-white transition-colors"
                  >
                    <X size={12} /> Clear
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Paint the regions the diffusion pass should NOT alter (comic dialog, faces, fine text).
                After the pass, the original pixels are composited back into these regions with a feathered edge.
                <span className="text-port-warning"> Heads up:</span> a preserved region keeps its original SynthID locally — a deliberate per-region quality-vs-disruption tradeoff.
              </p>
              <div className="flex items-center justify-center bg-port-bg/50 rounded p-2">
                <IgnoreZonePainter
                  ref={painterRef}
                  imageSrc={original.previewUrl}
                  tool={maskTool}
                  brushSize={brushSize}
                  onHasMaskChange={setHasMask}
                />
              </div>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-2 flex-1">
                  <label htmlFor="brush-size" className="text-xs text-gray-500 whitespace-nowrap">Brush size</label>
                  <input
                    id="brush-size"
                    type="range"
                    min="8"
                    max="200"
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                    className="flex-1 accent-port-accent"
                  />
                  <span className="text-xs text-gray-400 w-10 text-right">{brushSize}px</span>
                </div>
                <div className="flex items-center gap-2 flex-1">
                  <label htmlFor="feather" className="text-xs text-gray-500 whitespace-nowrap">Feather</label>
                  <input
                    id="feather"
                    type="range"
                    min="0"
                    max="50"
                    value={feather}
                    onChange={(e) => setFeather(Number(e.target.value))}
                    className="flex-1 accent-port-accent"
                  />
                  <span className="text-xs text-gray-400 w-10 text-right">{feather}px</span>
                </div>
                <button
                  onClick={() => { if (original?.file) runClean(original.file, steps, diffusionMode); }}
                  disabled={busy || !hasMask}
                  className="px-3 py-1.5 rounded text-sm bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors whitespace-nowrap"
                >
                  Apply mask
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
              <div className="px-4 py-2 border-b border-port-border flex items-center justify-between">
                <span className="text-sm font-medium text-white">Before</span>
                <span className="text-xs text-gray-500">
                  {formatBytes(original.size)}
                  {original.width && original.height && (
                    <> · {original.width}×{original.height} · {megapixels(original.width, original.height).toFixed(1)}MP</>
                  )}
                </span>
              </div>
              <div className="p-4 flex items-center justify-center bg-port-bg/50 min-h-[200px]">
                <img src={original.previewUrl} alt="Original" className="max-w-full max-h-[480px] object-contain" />
              </div>
            </div>

            <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
              <div className="px-4 py-2 border-b border-port-border flex items-center justify-between">
                <span className="text-sm font-medium text-white">After</span>
                {result && <span className="text-xs text-gray-500">{formatBytes(result.sizeAfter)}</span>}
              </div>
              <div className="p-4 flex items-center justify-center bg-port-bg/50 min-h-[200px]">
                {busy && gpuJobId && (
                  <BrailleSpinner text={
                    jobProgress.status === 'queued' ? 'Queued (GPU)'
                      : jobProgress.status === 'running' ? `Rendering${typeof jobProgress.progress === 'number' && jobProgress.progress > 0 ? ` ${Math.round(jobProgress.progress * 100)}%` : ''}`
                      : 'Cleaning'
                  } />
                )}
                {busy && !gpuJobId && <BrailleSpinner text="Cleaning" />}
                {!busy && result && (
                  <img
                    src={result.objectUrl}
                    alt="Cleaned"
                    className="max-w-full max-h-[480px] object-contain"
                  />
                )}
                {!busy && !result && (
                  <span className="text-gray-600 text-sm">Select steps to clean</span>
                )}
              </div>
            </div>
          </div>

          {result && (
            <div className="bg-port-card border border-port-border rounded-lg p-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Format</div>
                <div className="text-white font-medium">{result.format}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Dimensions</div>
                <div className="text-white font-medium">
                  {result.width && result.height ? `${result.width}×${result.height}` : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">Size delta</div>
                <div className="text-white font-medium">
                  {sizeDelta >= 0 ? '+' : '−'}{formatBytes(Math.abs(sizeDelta))}{' '}
                  <span className="text-xs text-gray-500">({sizeDeltaPct}%)</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase tracking-wide">C2PA</div>
                <div className={`font-medium flex items-center gap-1 ${
                  result.c2paStripped ? 'text-port-success' : result.c2paPresent ? 'text-port-warning' : 'text-gray-400'
                }`}>
                  {result.c2paStripped && <ShieldCheck size={14} />}
                  {result.c2paStripped ? 'Stripped' : result.c2paPresent ? 'Present (kept)' : 'None found'}
                </div>
              </div>
            </div>
          )}

          {result?.steps?.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Per-step report</div>
              <ul className="space-y-1 text-sm">
                {result.steps.map((s) => (
                  <li key={s.step} className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${s.status === 'applied' ? 'bg-port-success' : 'bg-gray-600'}`} />
                    <span className="text-white capitalize">{s.step}</span>
                    <span className="text-gray-500">— {s.status}{s.detail ? ` (${s.detail})` : ''}</span>
                    {s.status === 'applied' && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${s.lossless ? 'bg-port-success/15 text-port-success' : 'bg-port-warning/15 text-port-warning'}`}>
                        {s.lossless ? 'lossless' : 'lossy'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {result && (
              <a
                href={result.objectUrl}
                download={downloadName}
                className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors flex items-center gap-2"
              >
                <Download size={16} />
                Download
              </a>
            )}
            {/* Save-to-gallery — only for a finished GPU render (the temp result
                is discarded by default; this promotes it to a gallery citizen). */}
            {result?.gpu && gpuJobId && (
              <button
                onClick={saveToGallery}
                disabled={saving || !!savedFilename}
                className="px-4 py-2 bg-port-card border border-port-border hover:border-port-accent/50 text-gray-300 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Save size={16} />
                {savedFilename ? 'Saved to gallery' : saving ? 'Saving…' : 'Save to gallery'}
              </button>
            )}
            <button
              onClick={handleReset}
              className="px-4 py-2 bg-port-card border border-port-border hover:border-port-accent/50 text-gray-300 rounded-lg transition-colors"
            >
              Choose another image
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
