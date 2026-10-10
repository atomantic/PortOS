import { useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import { formatCount } from '../../utils/formatters.js';

const buttonClass = 'flex items-center gap-1 rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/**
 * Plain-text feedback on a Cast & Sets sheet. Aimed at the whole sheet, the
 * server rewrites the direction (and the look line every image prompt
 * carries) to honor it, re-renders what changed, and keeps honoring it on
 * later revisions and rebuilds until it is removed here. Aimed at one image,
 * it is that image's revision note. The last revision's change summary shows
 * under the box.
 */
export default function CastAndSetsFeedback({ stage, busy, onApply, onRemove }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const images = Object.values(stage.plan || {});
  const standing = stage.feedback || [];
  const summary = stage.changeSummary?.revision === stage.revision ? stage.changeSummary : null;
  const apply = () => {
    const value = text.trim();
    if (!value) return;
    onApply({ text: value, target: target || null }).then((res) => {
      if (res) { setText(''); setTarget(''); }
    });
  };
  return (
    <div className="min-w-0 space-y-2 rounded border border-port-border bg-port-bg/40 p-2">
      <label htmlFor="mv-cast-feedback" className="block text-xs text-port-text-muted">What should change?</label>
      <AutoSizeTextarea
        id="mv-cast-feedback"
        value={text}
        rows={2}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. Fewer light sources, more like eighties analog film"
        className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        {images.length > 0 && (
          <>
            <label htmlFor="mv-cast-feedback-target" className="sr-only">Applies to</label>
            <select id="mv-cast-feedback-target" value={target} onChange={(e) => setTarget(e.target.value)}
              className="min-h-[44px] min-w-0 max-w-full flex-1 rounded border border-port-border bg-port-bg px-2 py-1 text-sm sm:min-h-0 sm:flex-none">
              <option value="">Whole sheet</option>
              {images.map((item) => <option key={item.key} value={item.key}>{item.label || item.key}</option>)}
            </select>
          </>
        )}
        <button type="button" disabled={busy || !text.trim()} onClick={apply} className={`${buttonClass} bg-port-accent text-white`}>
          <MessageSquare size={14} aria-hidden="true" /> Apply feedback
        </button>
      </div>
      {stage.status === 'approved' && <p className="text-xs text-port-text-muted">Applying it re-opens the check-in for review.</p>}
      {summary && (
        <p className="text-xs text-port-text-muted" role="status">
          Revision {stage.revision}: {summary.changes.length ? summary.changes.join(' · ') : 'nothing the images are built from changed'}
          {' · '}{formatCount(summary.rerendered, { fallback: '0' })} {summary.rerendered === 1 ? 'image' : 'images'} re-rendered
        </p>
      )}
      {standing.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-port-text-muted">Standing feedback ({formatCount(standing.length)})</summary>
          <ul className="mt-1 space-y-1">
            {standing.map((f) => (
              <li key={f.id} className="flex items-start gap-2">
                <span className="min-w-0 flex-1 break-words">{f.text}</span>
                <button type="button" disabled={busy} onClick={() => onRemove(f.id)} aria-label={`Stop applying: ${f.text}`}
                  title="Stop applying this to later revisions"
                  className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-port-text-muted hover:text-port-error disabled:opacity-50 sm:min-h-0 sm:min-w-0">
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
