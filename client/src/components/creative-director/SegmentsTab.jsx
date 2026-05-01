const STATUS_BADGE = {
  pending: 'bg-port-border text-port-text-muted',
  rendering: 'bg-port-accent/30 text-port-accent',
  evaluating: 'bg-port-warning/30 text-port-warning',
  accepted: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};

export default function SegmentsTab({ project }) {
  const scenes = project.treatment?.scenes;
  if (!scenes?.length) {
    return <div className="text-port-text-muted text-sm">No scenes yet — the treatment hasn't been generated.</div>;
  }
  const sorted = scenes.slice().sort((a, b) => a.order - b.order);
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {sorted.map((s) => (
        <div key={s.sceneId} className="bg-port-card border border-port-border rounded overflow-hidden">
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
              {s.status === 'rendering' || s.status === 'evaluating' ? 'rendering…' : 'no render yet'}
            </div>
          )}
          <div className="p-2 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Scene {s.order + 1}</div>
              <span className={`text-xs px-2 py-0.5 rounded ${STATUS_BADGE[s.status] || ''}`}>{s.status}</span>
            </div>
            <div className="text-xs text-port-text-muted truncate">{s.intent}</div>
            <div className="text-xs text-port-text-muted">
              {s.durationSeconds}s • retries: {s.retryCount || 0}
            </div>
            {s.evaluation?.notes && (
              <div className="text-xs text-port-text-muted italic truncate" title={s.evaluation.notes}>
                {s.evaluation.notes}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
