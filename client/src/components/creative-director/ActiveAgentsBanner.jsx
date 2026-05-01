import { Link } from 'react-router-dom';
import { Bot, ExternalLink } from 'lucide-react';

/**
 * Banner shown at the top of the project detail page whenever there are
 * CoS agents running for this project. The parent (CreativeDirectorDetail)
 * polls /api/cos/agents and passes the filtered list down — keeping the
 * fetch in one place so the banner and SegmentsTab share state.
 */
export default function ActiveAgentsBanner({ agents }) {
  if (!agents?.length) return null;

  return (
    <div className="mb-4 bg-port-card border border-port-accent/40 rounded p-3 flex items-start justify-between gap-3">
      <div className="flex items-start gap-2 min-w-0">
        <Bot className="w-4 h-4 text-port-accent shrink-0 mt-0.5" />
        <div className="min-w-0">
          <div className="text-sm">
            <span className="font-medium text-port-accent">{agents.length} agent{agents.length === 1 ? '' : 's'} running</span>
            <span className="text-port-text-muted"> for this project</span>
          </div>
          <div className="text-xs text-port-text-muted truncate mt-0.5 font-mono">
            {agents.map((a) => `${a.id?.slice(0, 14) || 'agent'} · ${extractKind(a.taskId)}`).join(' • ')}
          </div>
        </div>
      </div>
      <Link
        to="/cos/agents"
        className="shrink-0 inline-flex items-center gap-1 text-xs text-port-accent hover:underline whitespace-nowrap"
      >
        Live progress <ExternalLink className="w-3 h-3" />
      </Link>
    </div>
  );
}

// Pull the task kind (treatment / scene / stitch) out of the
// cd-<projectId>-<kind>-<ts> task id. Project UUIDs contain hex segments,
// so a token-includes match is more reliable than counting separators.
export function extractKind(taskId) {
  if (!taskId) return 'task';
  const parts = taskId.split('-');
  for (const k of ['treatment', 'scene', 'stitch']) {
    if (parts.includes(k)) return k;
  }
  return 'task';
}
