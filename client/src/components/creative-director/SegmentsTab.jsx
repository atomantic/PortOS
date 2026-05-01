import { Link } from 'react-router-dom';
import { Bot } from 'lucide-react';
import { extractKind } from './ActiveAgentsBanner.jsx';

const STATUS_BADGE = {
  pending: 'bg-port-border text-port-text-muted',
  rendering: 'bg-port-accent/30 text-port-accent',
  evaluating: 'bg-port-warning/30 text-port-warning',
  accepted: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};

export default function SegmentsTab({ project, activeAgents = [] }) {
  const scenes = project.treatment?.scenes;
  if (!scenes?.length) {
    return <div className="text-port-text-muted text-sm">No scenes yet — the treatment hasn't been generated.</div>;
  }
  const sorted = scenes.slice().sort((a, b) => a.order - b.order);

  // Scene rendering runs server-side now (no `scene` CoS task), so the only
  // CD agent we'd see attached to a specific scene is `evaluate` — it reads
  // the rendered thumbnail and judges it against the project's style spec.
  // Use the explicit sceneId from the agent's task metadata (set by
  // agentBridge#enqueueEvaluateTask) when available — that pins the active
  // agent to the exact scene being judged. Fall back to the orchestrator's
  // "next non-terminal scene" guess only when metadata is missing.
  const sceneAgents = activeAgents.filter((a) => extractKind(a.taskId) === 'evaluate');
  const inflightScene = sorted.find((s) => s.status === 'pending' || s.status === 'rendering' || s.status === 'evaluating');
  const agentSceneIds = new Set(
    sceneAgents
      .map((a) => a.task?.metadata?.creativeDirector?.sceneId)
      .filter(Boolean),
  );
  const fallbackInflightSceneId = sceneAgents.length ? inflightScene?.sceneId : null;
  const isSceneInflight = (sceneId) =>
    agentSceneIds.has(sceneId) || (agentSceneIds.size === 0 && sceneId === fallbackInflightSceneId);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {sorted.map((s) => {
        const isInflight = isSceneInflight(s.sceneId);
        const decoratedStatus = isInflight && s.status === 'pending' ? 'rendering' : s.status;
        return (
          <div key={s.sceneId} className={`bg-port-card border rounded overflow-hidden ${isInflight ? 'border-port-accent/60' : 'border-port-border'}`}>
            {s.renderedJobId ? (
              <a href={`/data/videos/${s.renderedJobId}.mp4`} target="_blank" rel="noopener noreferrer" className="block bg-port-bg aspect-video">
                <img
                  src={`/data/video-thumbnails/${s.renderedJobId}.jpg`}
                  alt={`Scene ${s.order + 1}`}
                  className="w-full h-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              </a>
            ) : (
              <div className="bg-port-bg aspect-video flex items-center justify-center text-port-text-muted text-xs">
                {isInflight ? (
                  <span className="text-port-accent flex items-center gap-1">
                    <Bot className="w-3 h-3 animate-pulse" /> agent working…
                  </span>
                ) : decoratedStatus === 'rendering' || decoratedStatus === 'evaluating' ? 'rendering…' : 'no render yet'}
              </div>
            )}
            <div className="p-2 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Scene {s.order + 1}</div>
                <span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[decoratedStatus] || ''}`}>{decoratedStatus}</span>
              </div>
              <div className="text-xs text-port-text-muted truncate" title={s.intent}>{s.intent}</div>
              <div className="text-xs text-port-text-muted">
                {s.durationSeconds}s • retries: {s.retryCount || 0}
              </div>
              {isInflight && sceneAgents.length > 0 && (
                <div className="text-xs text-port-accent font-mono mt-1 flex flex-wrap gap-x-2">
                  {sceneAgents.map((a) => (
                    <Link key={a.id} to={`/cos/agents?id=${encodeURIComponent(a.id)}`} className="hover:underline">
                      {a.id?.slice(0, 14) || 'agent'}
                    </Link>
                  ))}
                </div>
              )}
              {s.evaluation?.notes && (
                <div className="text-xs text-port-text-muted italic truncate" title={s.evaluation.notes}>
                  {s.evaluation.notes}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
