import { useState, useRef, useCallback, useEffect } from 'react';
import { Eraser, Upload, Download, ShieldCheck, Sparkles } from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import * as api from '../services/api';
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
  // diffusion OFF (lossy — CPU light pass, the only step that touches SynthID).
  const [steps, setSteps] = useState({ metadata: true, denoise: false, diffusion: false });
  const fileInputRef = useRef(null);
  const requestIdRef = useRef(0);
  const previewUrlRef = useRef(null);
  const resultUrlRef = useRef(null);

  // Revoke any outstanding blob URL on unmount so we don't leak.
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
  }, []);

  const runClean = useCallback(async (file, selectedSteps) => {
    if (!file) return;
    const myRequestId = ++requestIdRef.current;
    setBusy(true);
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    }
    setResult(null);
    // Map the boolean diffusion toggle to the server's mode enum. Only the CPU
    // light pass is wired on this route today; the GPU FLUX round-trip is a
    // deferred follow-up (server returns 501 for diffusion=gpu).
    const payload = {
      metadata: selectedSteps.metadata,
      denoise: selectedSteps.denoise,
      diffusion: selectedSteps.diffusion ? 'light' : 'off',
    };
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
    setBusy(false);
    const objectUrl = URL.createObjectURL(cleaned.blob);
    resultUrlRef.current = objectUrl;
    const report = cleaned.report || {};
    setResult({ ...report, mimeType: cleaned.mimeType, objectUrl });
    toast.success(report.c2paStripped ? 'C2PA chunk removed' : 'Image cleaned');
  }, []);

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
    runClean(file, steps);
  };

  const toggleStep = (key) => {
    // Compute next outside setState so the updater stays pure (no side effects).
    const next = { ...steps, [key]: !steps[key] };
    setSteps(next);
    // Re-run immediately against the new selection so the After preview always
    // reflects the current steps.
    if (original?.file) runClean(original.file, next);
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
      label: 'Diffusion pass — disrupt SynthID (CPU)',
      hint: 'Lossy, best-effort — a CPU spatial round-trip (resize-squeeze + color/high-frequency nudge) that perturbs SynthID\'s watermark carriers. Blurs fine text. This is the only step that touches SynthID, and it disrupts — never guarantees removal. GPU FLUX round-trip coming later.',
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
            (CPU) is the only step that perturbs SynthID's carriers — best-effort, and it <em>disrupts</em> rather than guarantees removal (never verified against
            Google's detector). The higher-reliability GPU FLUX round-trip is a follow-up.
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
                {busy && <BrailleSpinner text="Cleaning" />}
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
