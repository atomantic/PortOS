import { formatCount } from '../../utils/formatters';

export default function AuditSourceEvidence({ evidence }) {
  if (!evidence) return null;
  if (evidence.status !== 'captured') {
    return <p className="text-xs text-port-text-muted">Audit source provenance unavailable.</p>;
  }
  return (
    <details className="text-xs text-port-text-muted min-w-0">
      <summary className="cursor-pointer">Audit launch source: {evidence.revision.slice(0, 12)}</summary>
      <div className="space-y-1 break-all mt-1">
        <p>Commit: {evidence.revision}</p>
        <p>Committed inventory: {formatCount(evidence.trackedEntryCount)} entries (including symlinks and submodule references).</p>
        <p>Inventory SHA-256: {evidence.inventorySha256}</p>
        <p>Workspace observed at capture: {evidence.workingTreeState}. Captured: {evidence.capturedAt}.</p>
        <p>Server-observed launch context, not reviewed-file coverage. Uncommitted changes and submodule contents are excluded; assessment scan counts remain model-reported.</p>
      </div>
    </details>
  );
}
