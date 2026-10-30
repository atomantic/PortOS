import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Loader2, PenLine, RefreshCw } from 'lucide-react';
import { STORYBOARD_LIMITS } from '../../../../server/lib/storyboardVocabulary.js';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';

/**
 * Correct the selected frame: draw on it (the annotate page, which returns
 * here), say what to change, and Redraw. The image node makes new frames from
 * the marked-up frame with the note after the shot (a prompt enhancer, when
 * one is wired in, rewrites its prompt with the note instead); they land as
 * takes. The Prompts tab shows the exact prompt and references sent.
 */
export default function PanelCorrection({ take, sketchNonce, onCorrect, onClose }) {
  const location = useLocation();
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [markupShown, setMarkupShown] = useState(true);
  const markupKey = `image:${take.image}`;
  const returnTo = `${location.pathname}${location.search}`;
  const annotateHref = `/media/annotate/${encodeURIComponent(markupKey)}?returnTo=${encodeURIComponent(returnTo)}`;
  const fieldId = `panel-correction-${take.id}`;

  const redraw = async () => {
    setSending(true);
    const ok = await onCorrect({ takeId: take.id, note: note.trim() });
    setSending(false);
    if (ok) { setNote(''); onClose(); }
  };

  return (
    <section aria-label="Correct this frame" className="space-y-2 rounded-lg border border-port-border p-2">
      <div className="flex items-start gap-2">
        {markupShown && (
          <img src={`/api/media/sketches/${encodeURIComponent(markupKey)}/png?v=${sketchNonce(markupKey)}`} alt="Your markup"
            onError={() => setMarkupShown(false)} className="h-16 w-28 shrink-0 rounded border border-port-border object-cover" />
        )}
        <Link to={annotateHref} className={actionButton}>
          <PenLine size={16} aria-hidden="true" /> {markupShown ? 'Edit markup' : 'Draw on frame'}
        </Link>
      </div>
      <div>
        <label htmlFor={fieldId} className="block text-[11px] text-gray-500 mb-0.5">What to change</label>
        <textarea id={fieldId} value={note} onChange={(event) => setNote(event.target.value)} rows={2}
          maxLength={STORYBOARD_LIMITS.panelText} placeholder="Move her to the left third, lower angle"
          className="w-full min-h-[2.75rem] bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white" />
      </div>
      <div className="flex gap-2">
        <button type="button" className={actionButton} onClick={redraw} disabled={sending || !note.trim()}>
          {sending ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Redraw
        </button>
        <button type="button" className={actionButton} onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}
