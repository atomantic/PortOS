import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Bot, ExternalLink } from 'lucide-react';
import { extractKind } from './ActiveAgentsBanner.jsx';

const STATUS_BADGE = {
  pending: 'bg-port-border text-port-text-muted',
  rendering: 'bg-port-accent/30 text-port-accent',
  evaluating: 'bg-port-warning/30 text-port-warning',
  accepted: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};

// Renders the preview area for a scene that has a rendered video.
// Uses <video controls poster> so the thumbnail is shown when idle and the
// user can play the clip in-tab without leaving the page. The browser handles
// a missing poster (ffmpeg/thumbnail not generated) by showing its own blank
// poster — controls remain fully accessible either way.
//
// `renderedJobId` survives even after the underlying mp4 is deleted from
// history, so the <video> can fail to load. We track that with onError and
// fall back to a "missing media" placeholder (matches the prior <a><img>
// onError-hides-tile behavior) instead of leaving a broken control.
function ScenePreview({ jobId, label }) {
  const [missing, setMissing] = useState(false);
  // `attempt` is bumped manually by the user-clickable Retry button below
  // (and indirectly by the jobId reset effect — a re-render with the same
  // jobId would otherwise leave a transient load error stuck for the rest
  // of the session). Each bump remounts <video> via the keyed `?retry=N`
  // suffix so the browser re-fetches instead of using its cached error.
  const [attempt, setAttempt] = useState(0);
  // Reset the missing flag when jobId changes so a re-rendered scene gets
  // a fresh load attempt instead of inheriting the prior scene's "media
  // missing" state. attempt resets too so the cache-busting param starts
  // fresh per scene.
  useEffect(() => {
    setMissing(false);
    setAttempt(0);
  }, [jobId]);
  const cacheBust = attempt > 0 ? `?retry=${attempt}` : '';
  const videoSrc = `/data/videos/${jobId}.mp4${cacheBust}`;
  const posterSrc = `/data/video-thumbnails/${jobId}.jpg${cacheBust}`;
  if (missing) {
    return (
      <div className="bg-port-bg aspect-video flex flex-col items-center justify-center text-port-text-muted text-xs gap-2">
        <span>media missing</span>
        <button
          type="button"
          onClick={() => { setMissing(false); setAttempt((a) => a + 1); }}
          className="px-2 py-0.5 rounded border border-port-border hover:bg-port-card text-port-text"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="relative bg-port-bg aspect-video">
      <video
        key={attempt}
        src={videoSrc}
        poster={posterSrc}
        controls
        preload="none"
        playsInline
        aria-label={label}
        onError={() => setMissing(true)}
        className="w-full h-full object-cover"
      />
      <a
        href={videoSrc}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${label} in new tab`}
        title="Open video in new tab"
        className="absolute top-1 right-1 p-1 rounded bg-black/50 text-white hover:bg-black/80"
      >
        <ExternalLink className="w-3 h-3" />
      </a>
    </div>
  );
}

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
  // Pick out only the agents whose task metadata names this exact scene.
  // Without this filter the row would render every evaluate agent in the
  // project — confusing if multiple evaluates run concurrently or if an
  // earlier agent's metadata is stale. When metadata is missing for all
  // agents (older runs / queued pre-spawn), fall back to the orchestrator's
  // single inflight guess so the row still shows *something*.
  const agentsForScene = (sceneId) => {
    const tagged = sceneAgents.filter((a) => a.task?.metadata?.creativeDirector?.sceneId === sceneId);
    if (tagged.length) return tagged;
    if (agentSceneIds.size === 0 && sceneId === fallbackInflightSceneId) return sceneAgents;
    return [];
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {sorted.map((s) => {
        const isInflight = isSceneInflight(s.sceneId);
        const decoratedStatus = isInflight && s.status === 'pending' ? 'rendering' : s.status;
        return (
          <div key={s.sceneId} className={`bg-port-card border rounded overflow-hidden ${isInflight ? 'border-port-accent/60' : 'border-port-border'}`}>
            {s.renderedJobId ? (
              <ScenePreview jobId={s.renderedJobId} label={`Scene ${s.order + 1}`} />
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
              {isInflight && (() => {
                const myAgents = agentsForScene(s.sceneId);
                if (!myAgents.length) return null;
                return (
                  <div className="text-xs text-port-accent font-mono mt-1 flex flex-wrap gap-x-2">
                    {myAgents.map((a) => (
                      <Link key={a.id} to={`/cos/agents?id=${encodeURIComponent(a.id)}`} className="hover:underline">
                        {a.id?.slice(0, 14) || 'agent'}
                      </Link>
                    ))}
                  </div>
                );
              })()}
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
