import { orchestratorReviewRows } from '../../lib/musicVideoAutonomous.js';
import { formatTimecode } from '../../utils/formatters.js';

const VERDICT_TONES = { approve: 'text-port-success', revise: 'text-port-warning', retake: 'text-port-warning', noted: 'text-port-text-muted' };

/**
 * What the orchestrator decided at each review point of an orchestrated run,
 * newest first: the latest decision stays in view, the rest fold away.
 */
export default function OrchestratorReviewLog({ run }) {
  const rows = orchestratorReviewRows(run);
  if (!rows.length) return null;
  const renderRow = (row) => (
    <li key={row.id} className="min-w-0 space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium text-port-text">{row.checkpoint}</span>
        <span className={VERDICT_TONES[row.verdict] || ''}>{row.verdictLabel}</span>
        {row.score != null && <span className="text-port-text-muted">{row.score}/10</span>}
        {row.measured && <span className="text-port-text-muted">measured</span>}
      </div>
      {row.notes && <p className="text-xs text-port-text-muted break-words">{row.notes}</p>}
      {(row.changes.length > 0 || row.issues.length > 0) && (
        <ul className="pl-3 text-[11px] text-port-text-muted list-disc space-y-0.5">
          {row.changes.map((change) => <li key={change} className="break-words">{change}</li>)}
          {row.issues.map((issue) => (
            <li key={`${issue.atSec}-${issue.text}`} className="break-words">
              {Number.isFinite(issue.atSec) ? `${formatTimecode(issue.atSec)} ` : ''}{issue.text}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
  const [latest, ...earlier] = rows;
  return (
    <div aria-label="Orchestrator decisions" className="rounded border border-port-border p-2 space-y-2 min-w-0">
      <ul className="space-y-2">{renderRow(latest)}</ul>
      {earlier.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-port-accent min-h-[44px] sm:min-h-0 flex items-center">Earlier decisions ({earlier.length})</summary>
          <ul className="mt-2 space-y-2">{earlier.map(renderRow)}</ul>
        </details>
      )}
    </div>
  );
}
