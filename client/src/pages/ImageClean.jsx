import { useState, useRef, useCallback, useEffect } from 'react';
import { Eraser, Upload, Download, ShieldCheck } from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import * as api from '../services/api';
import { formatBytes } from '../utils/formatters';
import { readFileAsBase64 } from '../utils/fileUpload';

// Keep aligned with MAX_INPUT_BYTES in server/routes/imageClean.js — both are
// sized so the base64+JSON envelope fits under the 55mb body parser cap.
const MAX_BYTES = 40 * 1024 * 1024;
const CLEAN_LEVELS = ['light', 'aggressive'];
const ALLOWED_EXT = /\.(png|jpe?g|webp)$/i;
const ALLOWED_MIME = /^image\/(png|jpe?g|webp)$/i;

export default function ImageClean() {
  const [level, setLevel] = useState('light');
  const [original, setOriginal] = useState(null); // { previewUrl, base64, size, name }
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const requestIdRef = useRef(0);
  const previewUrlRef = useRef(null);

  // Revoke any outstanding blob URL on unmount so we don't leak.
  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const runClean = useCallback(async (base64, lvl) => {
    const myRequestId = ++requestIdRef.current;
    setBusy(true);
    setResult(null);
    const cleaned = await api.cleanImage(base64, lvl).catch((err) => {
      toast.error(err.message || 'Failed to clean image');
      return null;
    });
    // Drop responses from a stale click — newer reclean is in flight.
    if (myRequestId !== requestIdRef.current) return;
    setBusy(false);
    if (cleaned) {
      setResult(cleaned);
      toast.success(cleaned.c2paStripped ? 'C2PA provenance stripped' : 'Image cleaned');
    }
  }, []);

  const handleFile = async (file) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error(`File exceeds ${MAX_BYTES / 1024 / 1024}MB limit`);
      return;
    }
    // Some drag sources leave file.type empty — fall back to extension. The
    // server still does a magic-byte sniff and is the source of truth.
    const typeOk = file.type ? ALLOWED_MIME.test(file.type) : true;
    const extOk = ALLOWED_EXT.test(file.name || '');
    if (!typeOk || !extOk) {
      toast.error('Only PNG, JPEG, and WebP images are supported');
      return;
    }

    const base64 = await readFileAsBase64(file).catch(() => null);
    if (!base64) {
      toast.error('Failed to read file');
      return;
    }

    // Use a blob URL for the Before preview so we don't double the in-memory
    // image (base64 string + data URI string). Revoke any previous URL first.
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const previewUrl = URL.createObjectURL(file);
    previewUrlRef.current = previewUrl;

    setOriginal({
      previewUrl,
      base64,
      size: file.size,
      name: file.name,
    });
    runClean(base64, level);
  };

  const handleLevelChange = (newLevel) => {
    setLevel(newLevel);
    if (original?.base64) runClean(original.base64, newLevel);
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2">
            <Eraser size={24} className="text-port-accent" />
            Image Cleaner
          </h2>
          <p className="text-gray-500 text-sm">
            Strip C2PA provenance + median-filter pixel noise from gpt-image-1 / Codex output.
          </p>
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <span className="text-sm text-gray-400">Cleaning level</span>
        <div className="flex gap-2">
          {CLEAN_LEVELS.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => handleLevelChange(opt)}
              disabled={busy}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors capitalize ${
                level === opt
                  ? 'bg-port-accent text-white'
                  : 'bg-port-bg border border-port-border text-gray-400 hover:text-white'
              } disabled:opacity-50`}
            >
              {opt}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-600 sm:ml-auto">
          {level === 'light' ? 'median(1)' : 'median(3) + sharpen'}
        </span>
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
            onChange={(e) => handleFile(e.target.files?.[0])}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          <Upload size={40} className={`mx-auto mb-4 ${dragActive ? 'text-port-accent' : 'text-gray-500'}`} />
          <p className="text-white mb-2">
            {dragActive ? 'Drop image here' : 'Drag and drop an image here'}
          </p>
          <p className="text-gray-500 text-sm mb-4">PNG, JPEG, or WebP (max 40MB)</p>
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
              <div className="px-4 py-2 border-b border-port-border flex items-center justify-between">
                <span className="text-sm font-medium text-white">Before</span>
                <span className="text-xs text-gray-500">{formatBytes(original.size)}</span>
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
                    src={`data:${result.mimeType};base64,${result.data}`}
                    alt="Cleaned"
                    className="max-w-full max-h-[480px] object-contain"
                  />
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
                <div className={`font-medium flex items-center gap-1 ${result.c2paStripped ? 'text-port-success' : 'text-gray-400'}`}>
                  {result.c2paStripped && <ShieldCheck size={14} />}
                  {result.c2paStripped ? 'Stripped' : 'None found'}
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {result && (
              <a
                href={`data:${result.mimeType};base64,${result.data}`}
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
