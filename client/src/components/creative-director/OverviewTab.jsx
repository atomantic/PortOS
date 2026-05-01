import { Link } from 'react-router-dom';

export default function OverviewTab({ project }) {
  const collectionLink = `/media/collections/${project.collectionId}`;
  const final = project.finalVideoId
    ? <Link to={`/media/history?selected=${project.finalVideoId}`} className="text-port-accent">{project.finalVideoId}</Link>
    : <span className="text-port-text-muted">not yet rendered</span>;

  return (
    <div className="space-y-4 max-w-3xl">
      <section className="bg-port-card border border-port-border rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide">Configuration</h2>
        <Field label="Aspect ratio" value={project.aspectRatio} />
        <Field label="Quality" value={project.quality} />
        <Field label="Model" value={project.modelId} />
        <Field label="Target duration" value={`${project.targetDurationSeconds}s (~${Math.round(project.targetDurationSeconds / 60)} min)`} />
        <Field label="Starting image" value={project.startingImageFile || '—'} />
        <Field label="Collection" value={<Link to={collectionLink} className="text-port-accent">{project.collectionId}</Link>} />
        <Field label="Final video" value={final} />
        {project.timelineProjectId && (
          <Field label="Timeline" value={<Link to={`/media/timeline/${project.timelineProjectId}`} className="text-port-accent">{project.timelineProjectId}</Link>} />
        )}
      </section>

      {project.styleSpec && (
        <section className="bg-port-card border border-port-border rounded p-4">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide mb-2">Style spec</h2>
          <pre className="whitespace-pre-wrap text-sm text-port-text font-mono">{project.styleSpec}</pre>
        </section>
      )}

      {project.userStory && (
        <section className="bg-port-card border border-port-border rounded p-4">
          <h2 className="text-sm font-semibold text-port-text-muted uppercase tracking-wide mb-2">User-supplied story</h2>
          <pre className="whitespace-pre-wrap text-sm text-port-text font-mono">{project.userStory}</pre>
        </section>
      )}

      {project.failureReason && (
        <section className="bg-port-card border border-port-error rounded p-4">
          <h2 className="text-sm font-semibold text-port-error uppercase tracking-wide mb-2">Failure reason</h2>
          <p className="text-sm text-port-text break-all">{project.failureReason}</p>
        </section>
      )}
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-sm">
      <div className="text-port-text-muted">{label}</div>
      <div className="col-span-2 text-port-text break-all">{value}</div>
    </div>
  );
}
