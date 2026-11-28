import { spriteAssetUrl } from './spriteAssets.js';

export default function WalkErrorRecovery({
  recordId, direction, run, hasSourceClip, pending, targetSaving, retrying, onRetry,
}) {
  // Retry also covers interrupted packaging. The endpoint checks readiness.
  if (run?.status !== 'error' && run?.status !== 'postprocessing') return null;

  return (
    <div className="space-y-1">
      {/* Even when packaging failed, grok still produced a clip — show it so
          the render isn't a dead end. The raw clip carries its own magenta
          matte (not transparent), so no checkerboard behind it. */}
      {run.status === 'error' && hasSourceClip && (
        <video
          src={spriteAssetUrl(recordId, run.sourceVideoPath)}
          className="w-full rounded border border-port-border"
          autoPlay
          loop
          muted
          playsInline
          controls
          aria-label={`raw grok walk clip (${direction})`}
        />
      )}
      {run.status === 'error' && (
        <p role="status" className="text-[10px] text-port-error break-words">{run.postprocessError || 'postprocess failed'}</p>
      )}
      {/* Gated on the in-flight target write (it repacks against the set
          target, so firing it before a target PATCH lands would use the
          value the server still holds) — but deliberately NOT on `busy`:
          that includes status==='postprocessing', which is precisely the
          wedged state this button exists to recover (attachTuiWalkResult
          persists 'postprocessing' before packaging, and nothing normalizes
          it if the server dies mid-package). Disabling on `busy` would make
          the "Re-run postprocess" branch permanently unclickable and leave
          that direction with no enabled action at all. */}
      <button type="button" onClick={() => onRetry(run)} disabled={pending || targetSaving || retrying} className="px-2 py-0.5 text-[10px] pointer-coarse:min-h-11 bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50">
        {retrying ? 'Repacking…' : run.status === 'postprocessing' ? 'Re-run postprocess' : 'Retry postprocess'}
      </button>
    </div>
  );
}
