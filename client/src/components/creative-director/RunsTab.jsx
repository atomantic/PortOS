import { Link } from 'react-router-dom';

const STATUS_BADGE = {
  running: 'bg-port-accent/30 text-port-accent',
  completed: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};

export default function RunsTab({ project }) {
  const runs = project.runs || [];
  if (!runs.length) {
    return <div className="text-port-text-muted text-sm">No runs yet — start the project to spawn the first agent task.</div>;
  }
  const sorted = runs.slice().sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  return (
    <div className="space-y-2 max-w-4xl">
      {sorted.map((r) => (
        <div key={r.runId} className="bg-port-card border border-port-border rounded p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="font-medium">
              {r.kind} {r.sceneId ? `· ${r.sceneId}` : ''}
            </div>
            <span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[r.status] || ''}`}>{r.status}</span>
          </div>
          <div className="text-xs text-port-text-muted mt-1">
            {r.startedAt && new Date(r.startedAt).toLocaleString()}
            {r.completedAt && ` → ${new Date(r.completedAt).toLocaleString()}`}
          </div>
          {r.taskId && (
            <div className="text-xs text-port-text-muted mt-1">
              Task: <span className="font-mono">{r.taskId}</span>
            </div>
          )}
          {r.agentId && (
            <div className="text-xs text-port-text-muted">
              Agent: <Link to={`/cos/agents?id=${encodeURIComponent(r.agentId)}`} className="text-port-accent font-mono">{r.agentId.slice(0, 8)}…</Link>
            </div>
          )}
          {r.error && <div className="text-xs text-port-error mt-1">{r.error}</div>}
        </div>
      ))}
    </div>
  );
}
