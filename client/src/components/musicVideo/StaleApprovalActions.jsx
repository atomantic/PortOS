import { CheckCircle2, ChevronRight, RotateCcw } from 'lucide-react';
import { formatCount } from '../../utils/formatters.js';

const buttonClass = 'flex items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';
const keepClass = 'flex items-center gap-1 rounded bg-port-accent px-3 py-1.5 text-sm font-medium text-white min-h-[44px] sm:min-h-0 disabled:opacity-50';
const chipClass = 'flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs min-h-[36px] sm:min-h-0 disabled:opacity-50';
// More reverts than this fold behind one "See N changes" toggle, so the main choice stays obvious.
const INLINE_REVERTS = 2;

/**
 * The ways out of a stale approval. Keep approved (`onKeep`) re-stamps the
 * approval on the current inputs; an `alternative` ({ label, hint, onClick })
 * is the other way out (Rebuild, Review), shown as an equal choice beside Keep,
 * each button with its one-line `hint` underneath so the director can see what
 * a tap does before making it. A Revert per changed input whose approved value
 * was kept (`revertible` → `onRevert(field)`) follows, folded behind "See N
 * changes" when there are more than a couple. `label` names the approval in
 * each button's accessible name, for a surface that lists several. Renders
 * nothing when no way out applies.
 */
export default function StaleApprovalActions({ revertible, busy = false, onKeep, onRevert, alternative = null, keepHint = null, label = null, keepTitle = 'Keep this approved on the current inputs' }) {
  const reverts = onRevert ? revertible || [] : [];
  if (!onKeep && !alternative && !reverts.length) return null;
  const folded = reverts.length > INLINE_REVERTS;
  // Folded, each revert is a compact chip naming just the input, so a long list stays a few rows on a phone.
  const revertButtons = reverts.map((field) => (
    <button key={field} type="button" disabled={busy} onClick={() => onRevert(field)} title="Put this back to the value you approved"
      aria-label={`Revert ${field}${label ? ` on ${label}` : ''}`} className={folded ? chipClass : buttonClass}>
      <RotateCcw size={folded ? 12 : 14} aria-hidden="true" /> {folded ? field : `Revert ${field}`}
    </button>
  ));
  const choice = !!(alternative || keepHint);
  const keep = onKeep && (
    <button type="button" disabled={busy} onClick={onKeep} title={keepTitle} aria-label={label ? `Keep ${label} approved` : undefined} className={choice ? `${keepClass} w-full justify-center` : keepClass}>
      <CheckCircle2 size={14} aria-hidden="true" /> Keep approved
    </button>
  );
  const foldedReverts = folded && (
    <details className="group min-w-0 basis-full">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1 text-sm text-port-text-muted hover:text-port-accent sm:min-h-0 sm:py-1">
        <ChevronRight size={14} aria-hidden="true" className="transition-transform group-open:rotate-90" />
        {`See ${formatCount(reverts.length)} changes${label ? ` to ${label}` : ''} you can undo`}
      </summary>
      <div className="mt-1 flex flex-wrap gap-1.5">{revertButtons}</div>
    </details>
  );
  if (!choice) {
    return (
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {keep}
        {folded ? foldedReverts : revertButtons}
      </div>
    );
  }
  // Two equal choices side by side (two columns even on a phone), each saying what it does.
  return (
    <div className="min-w-0 space-y-2">
      <div className="grid max-w-md grid-cols-2 gap-2" role="group" aria-label={label ? `Settle ${label}` : 'Keep or redo this approval'}>
        {keep && (
          <div className="min-w-0 space-y-1">
            {keep}
            {keepHint && <p className="text-[11px] text-port-text-muted">{keepHint}</p>}
          </div>
        )}
        {alternative && (
          <div className="min-w-0 space-y-1">
            <button type="button" disabled={busy} onClick={alternative.onClick} title={alternative.title}
              className={`${buttonClass} w-full justify-center text-port-accent`}>
              <RotateCcw size={14} aria-hidden="true" /> {alternative.label}
            </button>
            {alternative.hint && <p className="text-[11px] text-port-text-muted">{alternative.hint}</p>}
          </div>
        )}
      </div>
      {reverts.length > 0 && (folded ? foldedReverts : <div className="flex flex-wrap gap-2">{revertButtons}</div>)}
    </div>
  );
}
