import { useState } from 'react';
import { Brush, Loader2 } from 'lucide-react';
import { selectedTake } from './storyboardArt';

const DRAWING = new Set(['running', 'queued']);

/**
 * Draw panel: the board's recipe draws one frame from the panel's shot (as
 * written, unless a prompt enhancer is wired in), which becomes its art. Sits beside what the director edits
 * (the shot words, the prompts) so a change is redrawn in place; it reads
 * "Drawing…" while a prompt is written or a frame is on its way (here, or from
 * Redraw all).
 */
export default function DrawPanelButton({ panel, onDraw, disabled = false }) {
  const [starting, setStarting] = useState(false);
  const drawing = starting || Object.values(panel.make?.nodes || {}).some((state) => DRAWING.has(state?.status));
  if (!onDraw) return null;
  return (
    <button type="button" disabled={drawing || disabled}
      onClick={async () => { setStarting(true); await onDraw(); setStarting(false); }}
      className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg bg-port-accent px-3 text-sm text-white hover:bg-port-accent/80 disabled:opacity-60">
      {drawing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Brush size={16} aria-hidden="true" />}
      {drawing ? 'Drawing…' : selectedTake(panel) ? 'Redraw panel' : 'Draw panel'}
    </button>
  );
}
