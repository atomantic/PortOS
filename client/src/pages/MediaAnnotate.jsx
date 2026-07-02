import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Pencil, Eraser, Undo2, Trash2, Save, Download, ArrowLeft, ImageOff } from 'lucide-react';
import toast from '../components/ui/Toast';
import AnnotationCanvas from '../components/media/AnnotationCanvas';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { undoStrokes, clampSize, DEFAULT_COLOR, DEFAULT_SIZE, MIN_SIZE, MAX_SIZE } from '../lib/sketchCanvas';
import { getMediaSketch, saveMediaSketch } from '../services/api';

// Parse a media key `<kind>:<ref>` on the client (mirrors server/lib/mediaItemKey.js
// rules loosely — the server re-validates authoritatively). Phase 1 only supports
// annotating images.
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
  const parsed = useMemo(() => parseMediaKey(mediaKey), [mediaKey]);
  const isImage = parsed?.kind === 'image';
  // Images are served from /data/images/<filename>; the ref IS the filename.
  const imageSrc = isImage ? `/data/images/${parsed.ref}` : null;

  const canvasApiRef = useRef(null);
  const [strokes, setStrokes] = useState([]);
  const [dims, setDims] = useState(null);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [mode, setMode] = useState('draw'); // 'draw' | 'erase'
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  // Load any previously-saved strokes for this media key. React Router reuses
  // this component instance across :mediaKey changes (no remount), so reset all
  // transient view state synchronously before fetching — otherwise the previous
  // key's strokes / imageError / dims leak onto the new image.
  useEffect(() => {
    if (!isImage) { setLoading(false); return; }
    let active = true;
    setStrokes([]);
    setDims(null);
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
  }, [mediaKey, isImage]);

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

  const handleSave = useCallback(async () => {
    const res = await save();
    if (res) toast.success(strokes.length ? 'Annotation saved' : 'Annotation cleared');
  }, [save, strokes.length]);

  const handleExport = useCallback(() => {
    const dataUrl = canvasApiRef.current?.exportPng?.();
    if (!dataUrl) { toast.error('Nothing to export yet'); return; }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `annotated-${parsed?.ref || 'image'}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [parsed]);

  if (!isImage) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto text-sm text-gray-400">
        <Link to="/media/history" className="text-port-accent hover:underline inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to Media History
        </Link>
        <div className="mt-6 bg-port-card border border-port-border rounded-xl p-8 text-center">
          <ImageOff className="w-8 h-8 mx-auto mb-2 text-gray-600" />
          {mediaKey
            ? 'Only generated images can be annotated. This link points at an unsupported or missing item.'
            : 'Open a generated image from Media History or a Collection and choose “Annotate” to draw over it.'}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-3 md:p-4 border-b border-port-border flex flex-wrap items-center gap-2 sticky top-0 bg-port-bg/95 backdrop-blur z-10">
        <Link to="/media/history" className="text-gray-400 hover:text-white inline-flex items-center gap-1 text-sm mr-1" title="Back to Media History">
          <ArrowLeft className="w-4 h-4" /> <span className="hidden sm:inline">History</span>
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
            className="px-3 py-1.5 text-xs bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-40 inline-flex items-center gap-1"
            title="Save annotation"
          >
            <Save className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save'}
          </button>
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
            {loading && <div className="text-gray-500 text-sm mb-2">Loading saved annotation…</div>}
            <AnnotationCanvas
              ref={canvasApiRef}
              imageSrc={imageSrc}
              strokes={strokes}
              tool={tool}
              onStrokesChange={setStrokes}
              onImageLoad={setDims}
              onImageError={() => setImageError(true)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
