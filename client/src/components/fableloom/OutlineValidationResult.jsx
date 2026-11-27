import { AlertTriangle, CheckCircle2, CircleAlert } from 'lucide-react';
import { asArray } from '../../../../server/lib/arrayUtils.js';

export default function OutlineValidationResult({ validation, teleplayReplacementReady = false }) {
  if (!validation) return null;
  const issues = asArray(validation.issues);
  const hasErrors = !teleplayReplacementReady
    && issues.some((issue) => issue.severity !== 'warning');
  const status = validation.stats
    ? (validation.stats.errorCount ? 'invalid' : 'valid')
    : validation.status || 'draft';
  const label = teleplayReplacementReady
    ? 'Outline is ready to replace the old teleplay'
    : status === 'valid'
      ? 'Outline is structurally valid'
      : status === 'invalid'
        ? 'Outline needs edits'
        : 'Outline is a draft';
  return (
    <div className={`rounded border p-3 space-y-2 ${status === 'valid' ? 'border-port-success/40 bg-port-success/5' : hasErrors ? 'border-port-error/40 bg-port-error/5' : 'border-port-warning/40 bg-port-warning/5'}`} aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-semibold">
        {status === 'valid' ? <CheckCircle2 size={15} className="text-port-success" /> : hasErrors ? <CircleAlert size={15} className="text-port-error" /> : <AlertTriangle size={15} className="text-port-warning" />}
        {label}
        {validation.stats ? <span className="ml-auto text-xs font-normal text-port-text-muted">
          {validation.stats.sceneCount} beats · {validation.stats.decisionCount} choices · {validation.stats.endingCount} endings
        </span> : null}
      </div>
      {issues.length ? (
        <ul className="space-y-1 text-xs text-port-text-muted">
          {issues.map((issue, index) => <li key={`${issue.code || 'issue'}-${issue.sceneKey || 'outline'}-${index}`} className="flex items-start gap-1.5">
            {issue.severity === 'warning' || teleplayReplacementReady ? <AlertTriangle size={12} className="mt-0.5 shrink-0 text-port-warning" /> : <CircleAlert size={12} className="mt-0.5 shrink-0 text-port-error" />}
            <span>{issue.message}</span>
          </li>)}
        </ul>
      ) : status === 'valid' ? (
        <p className="text-xs text-port-success">Every beat is reachable, choices are distinct, and each path reaches an ending.</p>
      ) : null}
    </div>
  );
}
