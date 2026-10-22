import { AlertTriangle } from 'lucide-react';

/** The native clip's usable duration compared with the authored shot span. */
export default function SceneClipCoverageNotice({ scene, playback, onChange }) {
  const { underCovered, spanSec, playedSec, canLoop } = playback;
  return underCovered && (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1.5 text-xs text-port-warning">
      <AlertTriangle size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 basis-48">
        Shot runs {spanSec.toFixed(1)}s but its clip is {playedSec.toFixed(1)}s — the render won&apos;t repeat it.
        Trim the shot, continue or regenerate a longer clip{canLoop ? ', or loop it on purpose.' : '.'}
      </span>
      <button type="button" onClick={() => onChange({ endSec: Math.round((scene.startSec + playedSec) * 1000) / 1000 })}
        className="rounded bg-port-bg border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0 text-port-text">Trim to clip</button>
      {canLoop && (
        <button type="button" onClick={() => onChange({ loop: true })}
          className="rounded bg-port-bg border border-port-border px-2 py-1 min-h-[44px] sm:min-h-0 text-port-text">Loop clip</button>
      )}
    </div>
  );
}
