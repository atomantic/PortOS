import { Gauge } from 'lucide-react';
import toast from '../ui/Toast';
import { setSpriteWalkTarget } from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { WALK_FRAME_COUNT_OPTIONS, walkFpsOptionsFor } from '../../lib/spriteTrimmer.js';

/**
 * The SET-level cycle target (#2985) — one control for the whole walk, not a
 * per-render slider that can drift between directions. Saving PUTs the target
 * and refreshes the walk state; while that write is in flight the host disables
 * its own render/re-derive actions (via `onSavingChange`), so a click can't
 * queue against a value the server has not persisted yet.
 *
 * Its own module because two surfaces offer it: the walk workflow's per-set
 * header and the Loop Trimmer's re-derive panel (#2980). A second copy of these
 * two `<select>`s is exactly the drift #2985 exists to prevent — the copies would
 * disagree first about the app-lock hint, then about what the target means.
 *
 * `surfaceClass` lets a host on a `bg-port-bg` panel keep the inputs distinct
 * from their backdrop; `appRetargetHint` names where the bound app's contract is
 * actually edited, which differs per host.
 */
export default function CycleTarget({
  recordId, target, disabled, onChanged, onSavingChange = () => {},
  surfaceClass = 'bg-port-bg', appRetargetHint = 'change it in Publish below',
}) {
  const [save, saving] = useAsyncAction(async (next) => {
    onSavingChange(true);
    try {
      await setSpriteWalkTarget(recordId, next, { silent: true });
      toast.success(`Cycle target set · ${next.frameCount}f @ ${next.fps}fps`);
      onChanged();
    } finally {
      onSavingChange(false);
    }
  }, { errorMessage: 'Could not set the cycle target' });

  const cycleSeconds = (target.frameCount / target.fps).toFixed(2);
  const selectCls = `${surfaceClass} border border-port-border rounded px-2 py-1 text-sm text-white disabled:opacity-60`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <label className="flex items-center gap-1.5 text-xs text-gray-400" htmlFor={`walk-target-frames-${recordId}`}>
        Cycle target
        <select
          id={`walk-target-frames-${recordId}`}
          value={target.frameCount}
          disabled={disabled || saving || target.frameCountLocked}
          onChange={(e) => save({ frameCount: Number(e.target.value), fps: target.fps })}
          title="Frames in the walk cycle — shared by all 8 directions, because the atlas is a rectangular grid"
          className={selectCls}
        >
          {WALK_FRAME_COUNT_OPTIONS.map((n) => <option key={n} value={n}>{n} frames</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-gray-400" htmlFor={`walk-target-fps-${recordId}`}>
        {/* fps is an AUTHORING/preview speed: it drives this page's loop preview
            and is stamped on the manifest, but the consuming app decides how
            fast the sprite actually walks in-game. It lives in the target
            anyway because the atlas requires every direction to agree on it. */}
        <span className="flex items-center gap-1"><Gauge className="w-3 h-3" /> Preview speed</span>
        <select
          id={`walk-target-fps-${recordId}`}
          value={target.fps}
          disabled={disabled || saving || target.fpsLocked}
          onChange={(e) => save({ frameCount: target.frameCount, fps: Number(e.target.value) })}
          title="Preview/authoring speed — the consuming app determines real in-game playback. Pinned per set because the atlas needs every direction to agree."
          className={selectCls}
        >
          {walkFpsOptionsFor(target.fps).map((n) => <option key={n} value={n}>{n} fps</option>)}
        </select>
      </label>
      <span
        className="text-[11px] text-gray-500 tabular-nums"
        title="cycle duration = frames ÷ preview speed"
      >
        {cycleSeconds}s / cycle
      </span>
      <span
        className="text-[10px] text-gray-500"
        title={target.source === 'app'
          ? 'The bound app declares what its atlas may hold — retarget it through the publish binding.'
          : undefined}
      >
        {/* Provenance wording is stamped by the server (describeTargetSource), so
            this label and the 409 the user may hit always agree. */}
        {saving ? 'saving…' : target.sourceLabel || target.source}
        {target.source === 'app' && ` · ${appRetargetHint}`}
      </span>
    </div>
  );
}
