import { useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Loader2, Pencil, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import AnnotationCanvas from '../media/AnnotationCanvas';
import { getMediaSketch, saveMediaSketch } from '../../services/api';
import { undoStrokes, DEFAULT_SIZE } from '../../lib/sketchCanvas';
import { STORYBOARD_LIMITS } from '../../../../server/lib/storyboardVocabulary.js';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const toolButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg border border-port-border text-gray-300 hover:text-white disabled:opacity-40';
const SWATCHES = ['#ef4444', '#3b82f6', '#22c55e', '#000000', '#ffffff'];

/**
 * Correct the selected frame in place: draw on it, say what to change, and
 * Redraw. The marks are saved as the frame's markup (the same `image:<file>`
 * sketch the media annotator keeps), which the image node then uses as its
 * first reference with the note after the shot; new frames land as takes.
 * The Prompts tab shows the exact prompt and references sent.
 */
export default function PanelCorrection({ take, onCorrect, onClose }) {
  const markupKey = `image:${take.image}`;
  const canvasRef = useRef(null);
  const [strokes, setStrokes] = useState([]);
  // Any draw, undo or clear: the earlier markup must not land over it, even an emptied canvas.
  const edited = useRef(false);
  const editStrokes = (next) => { edited.current = true; setStrokes(next); };
  const [dims, setDims] = useState(null);
  const [color, setColor] = useState(SWATCHES[0]);
  const [mode, setMode] = useState('draw');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const tool = useMemo(() => ({ color, size: DEFAULT_SIZE, mode }), [color, mode]);
  const fieldId = `panel-correction-${take.id}`;

  // Earlier marks on this frame come back, so a correction can be refined;
  // a read that lands after the user started editing keeps their canvas.
  useEffect(() => {
    let active = true;
    getMediaSketch(markupKey, { silent: true })
      .then((res) => {
        if (active && !edited.current && Array.isArray(res?.sketch?.strokes)) setStrokes(res.sketch.strokes);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [markupKey]);

  const redraw = async () => {
    setSending(true);
    // Saving with no strokes clears old markup, so the plain frame is the reference.
    const saved = dims ? await saveMediaSketch(markupKey, {
      width: dims.w, height: dims.h, strokes, png: strokes.length ? canvasRef.current?.exportPng?.() || undefined : undefined,
    }).catch(() => null) : null;
    const ok = saved ? await onCorrect({ takeId: take.id, note: note.trim() }) : false;
    setSending(false);
    if (ok) { setNote(''); onClose(); }
  };

  return (
    <section aria-label="Correct this frame" className="space-y-2">
      <div className="flex justify-center">
        <AnnotationCanvas
          ref={canvasRef}
          imageSrc={`/data/images/${encodeURIComponent(take.image)}`}
          strokes={strokes}
          tool={tool}
          onStrokesChange={editStrokes}
          onImageLoad={setDims}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Drawing tools">
        {SWATCHES.map((swatch) => (
          <button key={swatch} type="button" aria-label={`Color ${swatch}`} aria-pressed={mode === 'draw' && color === swatch}
            onClick={() => { setColor(swatch); setMode('draw'); }}
            className={`h-11 w-11 rounded-lg border-2 ${mode === 'draw' && color === swatch ? 'border-port-accent' : 'border-port-border'}`}>
            <span className="mx-auto block h-5 w-5 rounded-full" style={{ backgroundColor: swatch }} />
          </button>
        ))}
        <button type="button" className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${toolButton} ${mode === 'draw' ? 'text-white' : ''}`} aria-label="Pen" aria-pressed={mode === 'draw'} onClick={() => setMode('draw')}>
          <Pencil size={16} aria-hidden="true" />
        </button>
        <button type="button" className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${toolButton} ${mode === 'erase' ? 'border-port-accent text-white' : ''}`} aria-label="Eraser" aria-pressed={mode === 'erase'} onClick={() => setMode('erase')}>
          <Eraser size={16} aria-hidden="true" />
        </button>
        <button type="button" className={toolButton} aria-label="Undo" onClick={() => editStrokes((prev) => undoStrokes(prev))} disabled={!strokes.length}>
          <Undo2 size={16} aria-hidden="true" />
        </button>
        <button type="button" className={toolButton} aria-label="Clear drawing" onClick={() => editStrokes([])} disabled={!strokes.length}>
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
      <div>
        <label htmlFor={fieldId} className="block text-[11px] text-gray-500 mb-0.5">What to change</label>
        <textarea id={fieldId} value={note} onChange={(event) => setNote(event.target.value)} rows={2}
          maxLength={STORYBOARD_LIMITS.panelText} placeholder="Move her to the left third, lower angle"
          className="w-full min-h-[2.75rem] bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white" />
      </div>
      <div className="flex gap-2">
        <button type="button" className={actionButton} onClick={redraw} disabled={sending || !note.trim() || !dims}>
          {sending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Redraw
        </button>
        <button type="button" className={actionButton} onClick={onClose} disabled={sending}>Cancel</button>
      </div>
    </section>
  );
}
