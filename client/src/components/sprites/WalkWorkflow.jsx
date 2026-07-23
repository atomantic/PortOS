import { useEffect, useMemo, useState } from 'react';
import { Check, Film, RefreshCw, Scissors, Lock } from 'lucide-react';
import toast from '../ui/Toast';
import {
  generateSpriteWalk, approveSpriteWalk, postprocessSpriteWalk, trimSpriteWalk,
} from '../../services/apiSprites.js';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { useSpritePendingRenders } from '../../hooks/useSpritePendingRenders.js';
import { spriteAssetUrl, checkerboardStyle, PIXELATED } from './spriteAssets.js';
import SpritePreview from './SpritePreview.jsx';

// Walk workflow (issue #2897): one grok image_to_video clip per locked
// directional anchor, deterministic server-side packaging into the 8-phase
// strip, per-direction review (loop preview + optional trim) and approval.
// The server's run records / selection / walk-set are the source of truth;
// this component renders them and fires generate/approve/trim.

// Mirrors server/services/sprites/walkPostprocess.js WALK_PHASES.
const WALK_PHASES = [
  'left-contact', 'left-down', 'left-passing', 'left-up',
  'right-contact', 'right-down', 'right-passing', 'right-up',
];
const CELL_PX = 96; // preview cell size — the strip animates at 96px/frame
// The scrub distance varies with the strip's frame count (a native run packs
// 8, an imported redraw cycle can pack 12 — #2924), so the single keyframe
// rule reads it from a per-preview custom property instead of hardcoding 8.
const LOOP_KEYFRAMES = '@keyframes sprite-walk-loop { to { background-position-x: var(--sprite-walk-loop-end) } }';
// Grok image_to_video clip lengths (videoGen/grok.js GROK_VIDEO_DURATIONS).
const WALK_DURATIONS = [6, 10];

/**
 * Strip geometry for a preview/trim UI, defaulting to the native 8-phase
 * packaging when a run predates (or omits) the richer stripPreview fields.
 */
function stripGeometry(stripPreview) {
  const rawCount = Math.round(Number(stripPreview?.frameCount));
  const frameCount = rawCount > 1 ? rawCount : WALK_PHASES.length; // NaN > 1 is false
  const fps = Number(stripPreview?.fps) > 0 ? Number(stripPreview.fps) : 12;
  const cellWidth = Number(stripPreview?.cellWidth);
  const cellHeight = Number(stripPreview?.cellHeight);
  const aspect = cellWidth > 0 && cellHeight > 0 ? cellHeight / cellWidth : 1;
  return { frameCount, fps, height: Math.round(CELL_PX * aspect) };
}

// Animated preview of a packed strip: the strip PNG as a stepped background
// animation (8 frames at 12fps ≈ 0.67s per loop for a native run; an imported
// 12-frame redraw cycle steps 12 times over 1s).
function StripLoop({ recordId, stripPreview }) {
  const { frameCount, fps, height } = stripGeometry(stripPreview);
  const scrub = CELL_PX * frameCount;
  return (
    // The loop paints the strip as its OWN background-image, so it can't also
    // carry the checkerboard — that goes on a wrapper sized to match, and shows
    // through the frame's alpha (#2930). SpritePreview doesn't fit here: there
    // is no <img>, the animation is a stepped background scrub.
    // `overflow-hidden` matters: the strip is painted by the INNER div, whose
    // corners are square, so without clipping it covers the rounded corners.
    <div
      className="border border-port-border rounded overflow-hidden"
      style={{ width: CELL_PX, height, ...checkerboardStyle(6) }}
    >
      <div
        role="img"
        aria-label="walk loop preview"
        className="w-full h-full"
        style={{
          // Quoted: encodeURIComponent leaves `(`/`)` intact, and an externally
          // authored redraw filename containing one would end the url() token early.
          backgroundImage: `url("${spriteAssetUrl(recordId, stripPreview.stripPath)}")`,
          backgroundSize: `${scrub}px ${height}px`,
          ...PIXELATED,
          '--sprite-walk-loop-end': `-${scrub}px`,
          animation: `sprite-walk-loop ${(frameCount / fps).toFixed(3)}s steps(${frameCount}) infinite`,
        }}
      />
    </div>
  );
}

// Frame enable/disable trimmer for one packaged run — non-destructive: the
// server derives the strip geometry from the run manifest and re-packs the
// enabled frames into a versioned strip + GIF.
function TrimPanel({ recordId, run, onClose }) {
  // Column count follows the packaged strip rather than the 8-phase constant,
  // so a longer imported cycle trims every frame it actually contains (#2924).
  const columns = useMemo(() => {
    const { frameCount } = stripGeometry(run?.stripPreview);
    return Array.from({ length: frameCount }, (_, i) => i);
  }, [run?.stripPreview]);
  const [enabled, setEnabled] = useState(() => new Set(columns));
  // Re-seed when the strip changes under a mounted panel — a stale `enabled`
  // holding out-of-range indices 400s the trim endpoint.
  useEffect(() => setEnabled(new Set(columns)), [columns]);
  const [result, setResult] = useState(null);
  const toggle = (i) => setEnabled((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });
  const [save, saving] = useAsyncAction(async () => {
    const trim = await trimSpriteWalk(recordId, {
      runId: run.id,
      enabledColumns: [...enabled].sort((a, b) => a - b),
    }, { silent: true });
    setResult(trim);
    toast.success(`Trim saved (${trim.frameCount} frames)`);
  }, { errorMessage: 'Trim failed' });

  return (
    <div className="bg-port-bg border border-port-border rounded p-2 space-y-2">
      <div className="grid grid-cols-4 gap-1">
        {columns.map((i) => {
          const phase = WALK_PHASES[i] || `frame ${i}`;
          return (
            <label key={i} className="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer">
              <input type="checkbox" checked={enabled.has(i)} onChange={() => toggle(i)} />
              <span className="truncate" title={phase}>{i}·{phase}</span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={saving || enabled.size < 2}
          className="px-2 py-0.5 text-xs bg-port-accent text-white rounded disabled:opacity-50"
        >
          {saving ? 'Saving…' : `Save trim (${enabled.size}/${columns.length})`}
        </button>
        <button onClick={onClose} className="px-2 py-0.5 text-xs text-gray-400 hover:text-white">Close</button>
      </div>
      {result && (
        <div className="flex items-center gap-2">
          <SpritePreview
            recordId={recordId}
            path={result.loop}
            alt="trimmed loop"
            className="w-24 h-24 shrink-0 border border-port-border rounded"
          />
          <p className="text-[10px] text-gray-500 break-all">{result.loop}</p>
        </div>
      )}
    </div>
  );
}

function DirectionCard({
  recordId, direction, anchorLocked, run, approved, finalized, pending, onGenerate, onApprove, onRetry,
}) {
  const [confirming, setConfirming] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const candidate = run?.status === 'candidate' ? run : null;
  const statusLabel = approved ? 'approved'
    : pending ? 'rendering…'
      : run?.status === 'postprocessing' ? 'packaging…'
        : run?.status || (anchorLocked ? 'ready' : 'anchor not locked');

  return (
    <div className="bg-port-bg border border-port-border rounded p-2 space-y-1.5">
      <p className="text-xs text-gray-400 flex items-center justify-between">
        {direction}
        <span className={`text-[10px] ${approved ? 'text-port-success' : run?.status === 'error' ? 'text-port-error' : 'text-gray-500'}`}>
          {approved && <Check className="w-3 h-3 inline mr-0.5" />}{statusLabel}
        </span>
      </p>

      {(approved || candidate) && run?.stripPreview?.stripPath && (
        <StripLoop recordId={recordId} stripPreview={run.stripPreview} />
      )}

      {/* Retry also covers a run wedged at 'postprocessing' (crash between
          the video copy and the packaged save) — the endpoint is the
          documented recovery path and validates readiness server-side. */}
      {(run?.status === 'error' || run?.status === 'postprocessing') && (
        <div className="space-y-1">
          {run.status === 'error' && (
            <p className="text-[10px] text-port-error break-words">{run.postprocessError || 'postprocess failed'}</p>
          )}
          <button onClick={() => onRetry(run)} className="px-2 py-0.5 text-[10px] bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent">
            {run.status === 'postprocessing' ? 'Re-run postprocess' : 'Retry postprocess'}
          </button>
        </div>
      )}

      {!finalized && !approved && (
        <div className="space-y-1.5">
          <button
            onClick={() => onGenerate(direction)}
            disabled={!anchorLocked || pending}
            title={anchorLocked ? undefined : 'Lock this direction\'s reference anchor first'}
            className="flex items-center gap-1 w-full justify-center px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
          >
            {pending
              ? <><RefreshCw className="w-3 h-3 animate-spin" /> Rendering…</>
              : <><Film className="w-3 h-3" /> {candidate ? 'Regenerate' : 'Generate walk'}</>}
          </button>
          {candidate && (
            confirming ? (
              <div className="flex items-center gap-1 text-xs">
                <span className="text-port-warning">Approve?</span>
                <button onClick={() => { setConfirming(false); onApprove(direction, candidate.id); }} className="px-1.5 py-0.5 bg-port-accent text-white rounded">Yes</button>
                <button onClick={() => setConfirming(false)} className="px-1.5 py-0.5 text-gray-400 hover:text-white">No</button>
              </div>
            ) : (
              <div className="flex gap-1">
                <button onClick={() => setConfirming(true)} className="flex-1 px-2 py-0.5 text-xs bg-port-success/20 border border-port-success rounded text-port-success">
                  Approve
                </button>
                <button
                  onClick={() => setTrimming((t) => !t)}
                  title="Trim loop frames"
                  className="px-2 py-0.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
                >
                  <Scissors className="w-3 h-3" />
                </button>
              </div>
            )
          )}
          {trimming && candidate && (
            <TrimPanel recordId={recordId} run={candidate} onClose={() => setTrimming(false)} />
          )}
        </div>
      )}
    </div>
  );
}

export default function WalkWorkflow({ record, reference, walk, onChanged }) {
  const recordId = record.id;
  const manifest = reference?.manifest || null;
  const runs = walk?.runs || [];
  const selection = walk?.selection || null;
  const finalized = Boolean(walk?.walkSet);
  const [duration, setDuration] = useState(WALK_DURATIONS[0]);

  // direction → jobId for in-flight video renders — rehydrated + polled by
  // the shared sprite render-tracking hook. The deterministic postprocess
  // runs server-side after the job completes, so the sweeps land later (and
  // twice) compared to the reference workflow's instant candidate copy.
  const { pendingJobs, beginSubmit, resolveSubmit, cancelSubmit } = useSpritePendingRenders({
    recordId,
    kind: 'video',
    tagKey: 'spriteWalk',
    tagField: 'direction',
    onChanged,
    sweepDelays: () => [1500, 8000],
    failMessage: (direction, job) => `Walk render failed for ${direction}: ${job?.error || 'see media jobs'}`,
  });

  // The deterministic postprocess runs server-side AFTER the video job
  // completes (frame extraction + per-pixel un-key can take many seconds on
  // slower machines) — the job-completion sweeps alone can both land while a
  // run is still 'postprocessing', which would strand the card on
  // "packaging…" forever. Keep refreshing until no run is packaging. A run
  // still 'queued' with no live job is an attach waiting behind the record's
  // write tail (e.g. a long rerun ahead of it) — poll for that too, but give
  // up after ~60s so a genuinely dead job doesn't poll indefinitely.
  // Booleans (not the runs array) as deps: refetches produce fresh array
  // identities every 4s, which would otherwise reset the bounded tick count.
  const packaging = runs.some((r) => r.status === 'postprocessing');
  const awaitingAttach = runs.some((r) => r.status === 'queued' && !pendingJobs[r.direction]);
  useEffect(() => {
    if (!packaging && !awaitingAttach) return undefined;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (!packaging && ticks > 15) {
        clearInterval(timer);
        return;
      }
      onChanged();
    }, 4000);
    return () => clearInterval(timer);
  }, [packaging, awaitingAttach, onChanged]);

  const latestRunByDirection = useMemo(() => {
    const byDir = {};
    for (const run of runs) {
      // runs arrive newest-first; prefer the approved run when one exists.
      if (!byDir[run.direction]) byDir[run.direction] = run;
    }
    for (const [direction, sel] of Object.entries(selection?.directions || {})) {
      const approvedRun = runs.find((r) => r.id === sel.runId);
      if (approvedRun) byDir[direction] = approvedRun;
    }
    return byDir;
  }, [runs, selection]);

  const generate = async (direction) => {
    beginSubmit(direction);
    try {
      const { jobId } = await generateSpriteWalk(recordId, { direction, duration }, { silent: true });
      resolveSubmit(direction, jobId);
    } catch (err) {
      cancelSubmit(direction);
      toast.error(err?.message || `Failed to queue ${direction} walk`);
    }
  };

  const [approve] = useAsyncAction(async (direction, runId) => {
    await approveSpriteWalk(recordId, { direction, runId }, { silent: true });
    toast.success(`Walk ${direction} approved`);
    onChanged();
  }, { errorMessage: 'Approve failed' });

  const [retryPostprocess] = useAsyncAction(async (run) => {
    await postprocessSpriteWalk(recordId, { runId: run.id }, { silent: true });
    toast.success('Postprocess complete');
    onChanged();
  }, { errorMessage: 'Postprocess failed' });

  // The walk workflow only becomes actionable once the main is frozen (the
  // south anchor IS the main); hide it entirely before that.
  if (!manifest?.mainReference?.locked) return null;

  const approvedCount = Object.values(selection?.directions || {})
    .filter((d) => d?.status === 'approved').length;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <style>{LOOP_KEYFRAMES}</style>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <Film className="w-4 h-4" /> Walk Cycles
          <span className="text-xs font-normal text-gray-500">
            {finalized ? 'finalized' : `${approvedCount}/8 approved`}
          </span>
        </h3>
        {finalized ? (
          <p className="text-xs text-port-success flex items-center gap-1">
            <Lock className="w-3 h-3" /> walk set frozen · immutable
          </p>
        ) : (
          <label className="flex items-center gap-2 text-xs text-gray-400">
            Clip length
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
            >
              {WALK_DURATIONS.map((d) => <option key={d} value={d}>{d}s</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(manifest.anchors || []).map((anchor) => (
          <DirectionCard
            key={anchor.direction}
            recordId={recordId}
            direction={anchor.direction}
            anchorLocked={anchor.status === 'locked'}
            run={latestRunByDirection[anchor.direction] || null}
            approved={selection?.directions?.[anchor.direction]?.status === 'approved'}
            finalized={finalized}
            pending={Boolean(pendingJobs[anchor.direction])}
            onGenerate={generate}
            onApprove={approve}
            onRetry={retryPostprocess}
          />
        ))}
      </div>
    </div>
  );
}
