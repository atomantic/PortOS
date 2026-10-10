import { CheckCircle2, RotateCcw } from 'lucide-react';

const buttonClass = 'flex items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';

/**
 * The two ways out of a stale approval, side by side: Keep approved (`onKeep`,
 * the approval stands on the current inputs) and a Revert per changed input
 * whose approved value was kept (`revertible` → `onRevert(field)`). Renders
 * nothing when neither applies.
 */
export default function StaleApprovalActions({ revertible = [], busy = false, onKeep, onRevert, keepTitle = 'Keep this approved on the current inputs' }) {
  const reverts = onRevert ? revertible : [];
  if (!onKeep && !reverts.length) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {onKeep && (
        <button type="button" disabled={busy} onClick={onKeep} title={keepTitle} className={`${buttonClass} text-port-accent`}>
          <CheckCircle2 size={14} aria-hidden="true" /> Keep approved
        </button>
      )}
      {reverts.map((field) => (
        <button key={field} type="button" disabled={busy} onClick={() => onRevert(field)} title="Put this back to the value you approved" className={buttonClass}>
          <RotateCcw size={14} aria-hidden="true" /> Revert {field}
        </button>
      ))}
    </div>
  );
}
