import { History } from 'lucide-react';
import { VERDICT_META } from './assessmentDetails';

// A measurement only describes the machine it was taken on. When the recorded
// environment no longer matches the live one — a RAM upgrade, a backend update —
// the reading is silently misleading, and nothing else on this page would say so.
export function StalePill({ staleness }) {
  if (!staleness?.stale) return null;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border text-port-warning border-port-warning/50"
      title={staleness.description || 'Measured on a different machine state.'}
    >
      <History size={9} /> stale
    </span>
  );
}

export function VerdictPill({ verdict }) {
  const meta = VERDICT_META[verdict] || VERDICT_META.unknown;
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded border ${meta.cls}`}>{meta.label}</span>
  );
}
