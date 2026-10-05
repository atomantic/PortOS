/**
 * A scene card's render status: "Queued" until the media-job queue reports the
 * job started, then "Running" with a bar once it reports progress (fraction
 * 0..1, from `*-gen:progress` socket events — never polled). Renders nothing
 * while no render is in flight for the scene.
 */
export default function SceneRenderProgress({ kind, generating, progress }) {
  if (!generating) return null;
  const running = !!progress;
  const fraction = typeof progress?.progress === 'number' ? progress.progress : null;
  const pct = fraction == null ? null : Math.round(fraction * 100);
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-port-text-muted" data-testid="scene-render-progress">
      <span>{kind} {running ? 'running' : 'queued'}{pct != null ? ` ${pct}%` : ''}</span>
      {pct != null && (
        <span className="h-1.5 w-12 overflow-hidden rounded bg-port-border" role="progressbar" aria-label={`${kind} render progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span className="block h-full bg-port-accent" style={{ width: `${pct}%` }} />
        </span>
      )}
    </span>
  );
}
