/**
 * Matrix cell + verdict chip shared by the capability matrix and the (eagerly
 * loaded) Local Model Assessments table. Kept as a small leaf so the
 * ModelCapabilityTests panel can be lazy-loaded without dragging this along.
 */
import { Play, Check, X, AlertTriangle } from 'lucide-react';
import Pill from '../ui/Pill';

// A verdict's colour and word. `null` is NOT a verdict — it means the test has
// not been run, which every caller renders as its own thing rather than folding
// into "failed".
const VERDICT_META = {
  passed: { label: 'passed', cls: 'text-emerald-400 border-emerald-400/40', Icon: Check },
  partial: { label: 'partial', cls: 'text-port-warning border-port-warning/40', Icon: AlertTriangle },
  failed: { label: 'failed', cls: 'text-port-error border-port-error/40', Icon: X },
};

function VerdictChip({ verdict, children, title }) {
  const meta = VERDICT_META[verdict];
  if (!meta) return null;
  // `bare` because the tone is per-verdict rather than one of Pill's semantic
  // trio — Pill still owns the shape, size and icon slot.
  return (
    <Pill tone="bare" size="xs" icon={meta.Icon} title={title} className={meta.cls}>
      {children || meta.label}
    </Pill>
  );
}

/**
 * One cell of the matrix — and the only control that opens the drawer.
 *
 * The four states are deliberately visually distinct: a result is coloured, an
 * unclaimed capability is muted italic text with the reason in its tooltip, a
 * blocked test says what PortOS cannot do, and an untested applicable pairing is
 * a button that offers the run.
 */
function TestCell({ slot, onOpen, disabled }) {
  if (!slot) return null;
  if (slot.state === 'not-applicable') {
    return <span className="text-[11px] text-gray-600 italic" title={slot.reason || undefined}>{slot.reason || 'not applicable'}</span>;
  }
  if (slot.state === 'unavailable') {
    return <span className="text-[11px] text-gray-600 italic" title={slot.reason || undefined}>can&rsquo;t run here</span>;
  }
  const verdict = slot.result?.verdict || null;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      className="text-left pointer-coarse:min-h-11 disabled:opacity-50"
      title={slot.result ? slot.result.summary : 'Not run yet — open to see what this test does'}
    >
      {verdict
        ? <VerdictChip verdict={verdict}>{slot.result.summary}</VerdictChip>
        : (
          <Pill tone="bare" size="xs" icon={Play} className="border-port-border text-gray-400 hover:border-port-accent hover:text-white transition-colors">
            not run
          </Pill>
        )}
    </button>
  );
}

export { VerdictChip, TestCell };
