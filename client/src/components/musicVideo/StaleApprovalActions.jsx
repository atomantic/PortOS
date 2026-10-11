import { CheckCircle2, ChevronRight, RotateCcw } from 'lucide-react';
import { formatCount } from '../../utils/formatters.js';

const buttonClass = 'flex items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';
const keepClass = 'flex items-center gap-1 rounded bg-port-accent px-3 py-1.5 text-sm font-medium text-white min-h-[44px] sm:min-h-0 disabled:opacity-50';
const chipClass = 'flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs min-h-[36px] sm:min-h-0 disabled:opacity-50';
// More reverts than this fold behind one "See N changes" toggle, so Keep approved stays the one obvious choice.
const INLINE_REVERTS = 2;

/**
 * The two ways out of a stale approval, side by side: Keep approved (`onKeep`,
 * the approval stands on the current inputs) and a Revert per changed input
 * whose approved value was kept (`revertible` → `onRevert(field)`), folded
 * behind "See N changes" when there are more than a couple. `label`
 * names the approval in each button's accessible name, for a surface that lists
 * several. Renders nothing when neither applies.
 */
export default function StaleApprovalActions({ revertible, busy = false, onKeep, onRevert, label = null, keepTitle = 'Keep this approved on the current inputs' }) {
  const reverts = onRevert ? revertible || [] : [];
  if (!onKeep && !reverts.length) return null;
  const folded = reverts.length > INLINE_REVERTS;
  // Folded, each revert is a compact chip naming just the input, so a long list stays a few rows on a phone.
  const revertButtons = reverts.map((field) => (
    <button key={field} type="button" disabled={busy} onClick={() => onRevert(field)} title="Put this back to the value you approved"
      aria-label={`Revert ${field}${label ? ` on ${label}` : ''}`} className={folded ? chipClass : buttonClass}>
      <RotateCcw size={folded ? 12 : 14} aria-hidden="true" /> {folded ? field : `Revert ${field}`}
    </button>
  ));
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      {onKeep && (
        <button type="button" disabled={busy} onClick={onKeep} title={keepTitle} aria-label={label ? `Keep ${label} approved` : undefined} className={keepClass}>
          <CheckCircle2 size={14} aria-hidden="true" /> Keep approved
        </button>
      )}
      {folded ? (
        <details className="group min-w-0 basis-full">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-1 text-sm text-port-text-muted hover:text-port-accent sm:min-h-0 sm:py-1">
            <ChevronRight size={14} aria-hidden="true" className="transition-transform group-open:rotate-90" />
            {`See ${formatCount(reverts.length)} changes${label ? ` to ${label}` : ''} you can undo`}
          </summary>
          <div className="mt-1 flex flex-wrap gap-1.5">{revertButtons}</div>
        </details>
      ) : revertButtons}
    </div>
  );
}
