/**
 * A scene card's render status: "Queued" until the media-job queue reports the
 * job started, then "Running" with a bar once it reports progress (fraction
 * 0..1, from `*-gen:progress` socket events — never polled). Renders nothing
 * while no render is in flight for the scene. `retry` (from the lane) replaces
 * the bar while a busy provider's lane waits to resend.
 */
export default function SceneRenderProgress({ kind, generating, progress, retry = null }) {
  if (!generating) return null;
  if (retry) {
    const seconds = Math.max(0, Math.ceil((retry.inMs || 0) / 1000));
    const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds} s`;
    return (
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-port-warning" data-testid="scene-render-progress"
        title="The provider is busy. PortOS resends the render on its own.">
        {kind} busy · retry {retry.attempt}/{retry.of} in {wait}
      </span>
    );
  }
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
