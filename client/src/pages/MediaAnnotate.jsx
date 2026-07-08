import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom';
import { Pencil, Eraser, Undo2, Trash2, Save, Download, ArrowLeft, ImageOff, Wand2, Loader2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal';
import AnnotationCanvas from '../components/media/AnnotationCanvas';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { undoStrokes, clampSize, DEFAULT_COLOR, DEFAULT_SIZE, MIN_SIZE, MAX_SIZE } from '../lib/sketchCanvas';
import { getMediaSketch, saveMediaSketch, getRegenAvailability, rerenderWithAnnotations } from '../services/api';

// Default denoise for an annotation re-render — high enough that the drawn marks
// actually reshape the image (mirrors the server's REGEN_ANNOTATED_STRENGTH_DEFAULT).
// Clamped into the backend's advertised [min, max] bounds at render time.
const DEFAULT_ANNOTATED_STRENGTH = 0.5;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Blank-canvas defaults (phase 3). A storyboard sketch opens at a square 1:1
// unless the caller passes ?w=&h= (e.g. matching the scene's aspect ratio).
const DEFAULT_BLANK_DIM = 1024;
const MIN_BLANK_DIM = 64;
const MAX_BLANK_DIM = 4096;
const clampDim = (v, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_BLANK_DIM, Math.max(MIN_BLANK_DIM, n));
};

// Parse a sketch key on the client (mirrors server/services/mediaSketches.js
// loosely — the server re-validates authoritatively). Supported kinds:
//   image:<filename>  — annotate over a generated image (phases 1–2)
//   sketch:<uuid>     — free-standing blank canvas (phase 3)
function parseMediaKey(key) {
  if (typeof key !== 'string') return null;
  const idx = key.indexOf(':');
  if (idx <= 0) return null;
  const kind = key.slice(0, idx);
  const ref = key.slice(idx + 1);
  if (!ref || ref.includes(':')) return null;
  return { kind, ref };
}

const COLOR_SWATCHES = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#000000'];

export default function MediaAnnotate() {
  const { mediaKey } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const parsed = useMemo(() => parseMediaKey(mediaKey), [mediaKey]);
  const isImage = parsed?.kind === 'image';
  const isBlank = parsed?.kind === 'sketch';
  const isSupported = isImage || isBlank;
  // Images are served from /data/images/<filename>; the ref IS the filename.
  // A blank sketch has no backing image (the canvas fills a solid background).
  const imageSrc = isImage ? `/data/images/${parsed.ref}` : null;

  // Blank-canvas size + a return link, both driven by the URL so the page is
  // reload-safe and shareable (the storyboard scene passes them when it opens
  // a sketch). Falls back to a square default when absent/invalid.
  const blankWidth = useMemo(() => clampDim(searchParams.get('w'), DEFAULT_BLANK_DIM), [searchParams]);
  const blankHeight = useMemo(() => clampDim(searchParams.get('h'), DEFAULT_BLANK_DIM), [searchParams]);
  const returnTo = searchParams.get('returnTo');

  const canvasApiRef = useRef(null);
  const [strokes, setStrokes] = useState([]);
  const [dims, setDims] = useState(null);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [mode, setMode] = useState('draw'); // 'draw' | 'erase'
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  // Re-render (issue #2036 phase 2). `regenInfo` is the same local-FLUX
  // img2img availability the lightbox uses — it names the exact model a
  // re-render would run, so the user sees the provider/model before any AI
  // call (no cold-bootstrap). null until fetched; `available:false` gates it.
  const [regenInfo, setRegenInfo] = useState(null);
  const [rerenderOpen, setRerenderOpen] = useState(false);
  const [rerenderPrompt, setRerenderPrompt] = useState('');
  const [rerenderStrength, setRerenderStrength] = useState(DEFAULT_ANNOTATED_STRENGTH);

  useEffect(() => {
    if (!isImage) return;
    let active = true;
    // Clear synchronously on every image change: React Router reuses this page
    // across :mediaKey changes, so a leftover regenInfo would otherwise disclose
    // the PREVIOUS image's model/bounds until the new (possibly slow) probe
    // resolves — letting the dialog open on stale availability.
    setRegenInfo(null);
    // Pass the source filename so the reported model is the exact one a regen of
    // THIS image would run (multi-model installs), keeping the dialog honest.
    getRegenAvailability(parsed?.ref)
      .then((r) => { if (active) setRegenInfo(r || null); })
      .catch(() => { if (active) setRegenInfo(null); });
    return () => { active = false; };
  }, [isImage, parsed?.ref]);

  // Load any previously-saved strokes for this media key. React Router reuses
  // this component instance across :mediaKey changes (no remount), so reset all
  // transient view state synchronously before fetching — otherwise the previous
  // key's strokes / imageError / dims leak onto the new image.
  useEffect(() => {
    if (!isSupported) { setLoading(false); return; }
    let active = true;
    setStrokes([]);
    // In image mode dims come from the <img> onLoad, which re-fires when the src
    // changes — so reset to null and let it re-report. In blank mode dims derive
    // from the (stable-per-key) URL size params; the child's dims effect won't
    // re-fire when navigating sketch→sketch at the same w/h, so clearing here
    // would strand Save disabled (`!dims`). Leave blank dims in place.
    if (!isBlank) setDims(null);
    setImageError(false);
    setLoading(true);
    getMediaSketch(mediaKey, { silent: true })
      .then((res) => {
        if (!active) return;
        const loaded = Array.isArray(res?.sketch?.strokes) ? res.sketch.strokes : [];
        setStrokes(loaded);
        if (loaded.length > 0) toast.success(`Restored ${loaded.length} stroke${loaded.length === 1 ? '' : 's'}`);
      })
      .catch(() => { if (active) toast.error('Failed to load saved annotation'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mediaKey, isSupported]);

  const tool = useMemo(() => ({ color, size, mode }), [color, size, mode]);

  const handleUndo = useCallback(() => setStrokes((prev) => undoStrokes(prev)), []);
  const handleClear = useCallback(() => setStrokes([]), []);

  const [save, saving] = useAsyncAction(async () => {
    if (!dims) throw new Error('Canvas not ready');
    const png = canvasApiRef.current?.exportPng?.() || undefined;
    const res = await saveMediaSketch(mediaKey, {
      width: dims.w,
      height: dims.h,
      strokes,
      png,
    }, { silent: true });
    return res;
  }, { errorMessage: 'Failed to save annotation' });

  const noun = isBlank ? 'Sketch' : 'Annotation';
  const backPath = returnTo || '/media/history';
  const backLabel = returnTo ? 'Back' : 'Media History';

  const handleSave = useCallback(async () => {
    const res = await save();
    if (res) toast.success(strokes.length ? `${noun} saved` : `${noun} cleared`);
  }, [save, strokes.length, noun]);

  const handleExport = useCallback(() => {
    const dataUrl = canvasApiRef.current?.exportPng?.();
    if (!dataUrl) { toast.error('Nothing to export yet'); return; }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = isBlank ? `sketch-${parsed?.ref || 'canvas'}.png` : `annotated-${parsed?.ref || 'image'}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [parsed, isBlank]);

  const strengthMin = regenInfo?.strengthMin ?? 0.02;
  const strengthMax = regenInfo?.strengthMax ?? 0.6;
  const regenAvailable = !!regenInfo?.available;
  const regenModelLabel = regenInfo?.modelId || 'local FLUX img2img';

  const openRerender = useCallback(() => {
    setRerenderStrength(clamp(DEFAULT_ANNOTATED_STRENGTH, strengthMin, strengthMax));
    setRerenderPrompt('');
    setRerenderOpen(true);
  }, [strengthMin, strengthMax]);

  // Persist the annotation (writes the flattened PNG sidecar the server uses as
  // the img2img init image), then enqueue the re-render. Both API calls are
  // silent so useAsyncAction owns the single error toast.
  const [rerender, rerendering] = useAsyncAction(async () => {
    if (!dims) throw new Error('Canvas not ready');
    if (strokes.length === 0) throw new Error('Draw over the image before re-rendering');
    const png = canvasApiRef.current?.exportPng?.() || undefined;
    await saveMediaSketch(mediaKey, { width: dims.w, height: dims.h, strokes, png }, { silent: true });
    return rerenderWithAnnotations(parsed.ref, {
      strength: rerenderStrength,
      prompt: rerenderPrompt.trim() || undefined,
    });
  }, { errorMessage: 'Failed to start re-render' });

  const handleRerender = useCallback(async () => {
    const res = await rerender();
    if (!res) return;
    setRerenderOpen(false);
    toast.success('Re-rendering with your annotations — it’ll appear in Media History');
    navigate('/media/history');
  }, [rerender, navigate]);

  if (!isSupported) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-gray-400">
        <Link to="/media/history" className="text-port-accent hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to Media History
        </Link>
        <div className="mt-6 bg-port-card border border-port-border rounded-xl p-8 text-center">
          <ImageOff className="w-8 h-8 mx-auto mb-2 text-gray-600" />
          {mediaKey
            ? 'Only generated images or blank-canvas sketches can be annotated. This link points at an unsupported or missing item.'
            : 'Open a generated image from Media History or a Collection and choose “Annotate” to draw over it.'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-3 md:p-4 border-b border-port-border flex flex-wrap items-center gap-2 sticky top-0 bg-port-bg/95 backdrop-blur z-10">
        <Link to={backPath} className="text-gray-400 hover:text-white inline-flex items-center gap-1 text-sm mr-1" title={`Back to ${backLabel}`}>
          <ArrowLeft className="w-4 h-4" /> <span className="hidden sm:inline">{backLabel}</span>
        </Link>

        {/* Draw / erase */}
        <div className="flex rounded-lg overflow-hidden border border-port-border">
          <button
            type="button"
            onClick={() => setMode('draw')}
            className={`px-2.5 py-1.5 text-xs flex items-center gap-1 ${mode === 'draw' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-300 hover:bg-port-border'}`}
            aria-pressed={mode === 'draw'}
          >
            <Pencil className="w-3.5 h-3.5" /> Draw
          </button>
          <button
            type="button"
            onClick={() => setMode('erase')}
            className={`px-2.5 py-1.5 text-xs flex items-center gap-1 ${mode === 'erase' ? 'bg-port-accent text-white' : 'bg-port-card text-gray-300 hover:bg-port-border'}`}
            aria-pressed={mode === 'erase'}
          >
            <Eraser className="w-3.5 h-3.5" /> Erase
          </button>
        </div>

        {/* Color swatches */}
        <div className="flex items-center gap-1">
          {COLOR_SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setColor(c); setMode('draw'); }}
              className={`w-6 h-6 rounded-full border-2 ${color === c && mode === 'draw' ? 'border-white' : 'border-port-border'}`}
              style={{ backgroundColor: c }}
              title={`Color ${c}`}
              aria-label={`Color ${c}`}
            />
          ))}
          <label htmlFor="annotate-color" className="sr-only">Custom color</label>
          <input
            id="annotate-color"
            type="color"
            value={color}
            onChange={(e) => { setColor(e.target.value); setMode('draw'); }}
            className="w-6 h-6 rounded cursor-pointer bg-transparent border border-port-border"
            title="Custom color"
          />
        </div>

        {/* Brush size */}
        <div className="flex items-center gap-1.5">
          <label htmlFor="annotate-size" className="text-xs text-gray-400">Size</label>
          <input
            id="annotate-size"
            type="range"
            min={MIN_SIZE}
            max={MAX_SIZE}
            value={size}
            onChange={(e) => setSize(clampSize(e.target.value))}
            className="w-20 md:w-28 accent-port-accent"
          />
          <span className="text-xs text-gray-400 w-5 tabular-nums">{size}</span>
        </div>

        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            onClick={handleUndo}
            disabled={strokes.length === 0}
            className="px-2 py-1.5 text-xs bg-port-card border border-port-border rounded hover:bg-port-border disabled:opacity-40 inline-flex items-center gap-1"
            title="Undo last stroke"
          >
            <Undo2 className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Undo</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={strokes.length === 0}
            className="px-2 py-1.5 text-xs bg-port-card border border-port-border rounded hover:bg-port-border disabled:opacity-40 inline-flex items-center gap-1"
            title="Clear all strokes"
          >
            <Trash2 className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Clear</span>
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!dims}
            className="px-2 py-1.5 text-xs bg-port-card border border-port-border rounded hover:bg-port-border disabled:opacity-40 inline-flex items-center gap-1"
            title="Download flattened PNG"
          >
            <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Export</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dims}
            className="px-3 py-1.5 text-xs bg-port-card border border-port-border text-gray-200 rounded hover:bg-port-border disabled:opacity-40 inline-flex items-center gap-1"
            title={`Save ${noun.toLowerCase()}`}
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save'}
          </button>
          {/* Re-render is img2img over an existing generated image — only for the
              overlay (image) mode. A blank sketch has no source render to feed. */}
          {isImage ? (
            <button
              type="button"
              onClick={openRerender}
              disabled={!dims || strokes.length === 0}
              className="px-3 py-1.5 text-xs bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-40 inline-flex items-center gap-1"
              title={strokes.length === 0 ? 'Draw over the image first' : 'Re-render this image guided by your annotations'}
            >
              <Wand2 className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Re-render</span>
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex-1 p-3 md:p-6 flex items-start justify-center">
        {imageError ? (
          <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-sm text-gray-400 max-w-md">
            <ImageOff className="w-8 h-8 mx-auto mb-2 text-gray-600" />
            Couldn't load this image. It may have been deleted or not yet synced from a peer.
            <div className="mt-3">
              <Link to="/media/history" className="text-port-accent hover:underline">← Back to Media History</Link>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-4xl">
            {loading && <div className="text-gray-500 text-sm mb-2">Loading saved {noun.toLowerCase()}…</div>}
            <AnnotationCanvas
              ref={canvasApiRef}
              imageSrc={imageSrc}
              blankWidth={blankWidth}
              blankHeight={blankHeight}
              strokes={strokes}
              tool={tool}
              onStrokesChange={setStrokes}
              onImageLoad={setDims}
              onImageError={() => setImageError(true)}
            />
          </div>
        )}
      </div>

      <Modal
        open={rerenderOpen}
        onClose={() => !rerendering && setRerenderOpen(false)}
        size="sm"
        closeOnBackdrop={!rerendering}
        closeOnEsc={!rerendering}
        ariaLabel="Re-render with annotations"
        panelClassName="bg-port-card border border-port-border rounded-xl p-5 text-sm"
      >
        <h2 className="text-base font-semibold text-white flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-port-accent" /> Re-render with annotations
        </h2>
        <p className="text-gray-400 mt-1 text-xs">
          Your drawing is flattened onto the image and fed back through img2img so the marks reshape the render.
        </p>

        {/* Provider/model visible before any AI call runs (no cold-bootstrap). */}
        <div className="mt-3 rounded-lg bg-port-bg border border-port-border px-3 py-2 text-xs">
          <span className="text-gray-500">Renders locally via </span>
          <span className="text-gray-200 font-mono">{regenModelLabel}</span>
        </div>

        {!regenAvailable ? (
          <div className="mt-3 text-xs text-port-warning">
            {regenInfo?.reason || 'Local img2img isn’t available on this install. A local FLUX runner is required to re-render.'}
          </div>
        ) : (
          <>
            <div className="mt-4">
              <label htmlFor="rerender-prompt" className="block text-xs text-gray-400 mb-1">
                Prompt <span className="text-gray-600">(optional — steer the redraw)</span>
              </label>
              <textarea
                id="rerender-prompt"
                value={rerenderPrompt}
                onChange={(e) => setRerenderPrompt(e.target.value)}
                rows={2}
                placeholder="Leave blank to let the annotations alone guide the redraw"
                className="w-full rounded-lg bg-port-bg border border-port-border px-3 py-2 text-sm text-gray-200 resize-none focus:outline-none focus:border-port-accent"
              />
            </div>

            <div className="mt-3">
              <label htmlFor="rerender-strength" className="flex items-center justify-between text-xs text-gray-400 mb-1">
                <span>Strength <span className="text-gray-600">(how much to change)</span></span>
                <span className="text-gray-300 tabular-nums">{rerenderStrength.toFixed(2)}</span>
              </label>
              <input
                id="rerender-strength"
                type="range"
                min={strengthMin}
                max={strengthMax}
                step={0.01}
                value={rerenderStrength}
                onChange={(e) => setRerenderStrength(clamp(parseFloat(e.target.value), strengthMin, strengthMax))}
                className="w-full accent-port-accent"
              />
            </div>
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setRerenderOpen(false)}
            disabled={rerendering}
            className="px-3 py-1.5 text-xs bg-port-card border border-port-border rounded hover:bg-port-border disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRerender}
            disabled={rerendering || !regenAvailable}
            className="px-3 py-1.5 text-xs bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-40 inline-flex items-center gap-1"
          >
            {rerendering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
            {rerendering ? 'Starting…' : 'Re-render'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
