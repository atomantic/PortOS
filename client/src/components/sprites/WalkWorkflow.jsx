import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check, Film, RefreshCw, Scissors, Lock, Unlock, Terminal, Gauge, RotateCcw,
} from 'lucide-react';
import toast from '../ui/Toast';
import {
  approveSpriteWalk, postprocessSpriteWalk, unlockSpriteWalk, reopenSpriteWalk,
} from '../../services/apiSprites.js';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { spriteAssetUrl, checkerboardStyle, PIXELATED } from './spriteAssets.js';
import { WALK_PHASES } from '../../lib/spriteTrimmer.js';

// Walk workflow (issue #2897): one grok image_to_video clip per locked
// directional anchor, deterministic server-side packaging into the 8-phase
// strip, per-direction review (loop preview) and approval. Loop trimming moved
// to its own deep-linkable workspace (#2933) — each card links into it. The
// server's run records / selection / walk-set are the source of truth; this
// component renders them and fires generate/approve.

const CELL_PX = 96; // preview cell size — the strip animates at 96px/frame
// The scrub distance varies with the strip's frame count (a native run packs
// 8, an imported redraw cycle can pack 12 — #2924), so the single keyframe
// rule reads it from a per-preview custom property instead of hardcoding 8.
const LOOP_KEYFRAMES = '@keyframes sprite-walk-loop { to { background-position-x: var(--sprite-walk-loop-end) } }';
// Grok image_to_video clip lengths. In practice grok's tool only honors its
// documented 6s/10s options and clamps anything shorter to ~6s — so the picker
// offers just those two rather than lying about 1/2/3s. A 6s clip yields plenty
// of source frames for the packer; the CYCLE'S look (walk vs run) is set by the
// frame-count + speed controls below, not the clip length. Exported so the
// Sprites page can seed the lifted `duration` state with the same default.
export const WALK_DURATIONS = [6, 10];
export const WALK_DEFAULT_DURATION = 6;

// Deterministic-postprocess authoring knobs (mirror walkPostprocess.js
// WALK_DEFAULT_*/WALK_MIN/MAX_*). Frame count = how many frames the packed cycle
// holds (more = smoother); fps = playback speed (lower = slower, more
// deliberate). Cycle duration = frameCount / fps seconds. Defaults pack a
// fuller, slower cycle (12 frames @ 10fps = 1.2s) so a walk reads as a walk.
export const WALK_DEFAULT_FRAME_COUNT = 12;
export const WALK_DEFAULT_FPS = 10;
export const WALK_FRAME_COUNT_RANGE = { min: 6, max: 16 };
export const WALK_FPS_RANGE = { min: 4, max: 24 };

// Inclusive integer sequence [min..max] by step. Both dropdown option lists are
// derived from module-level constants, so build them once at load rather than
// on every render.
const seq = (min, max, step) => {
  const out = [];
  for (let v = min; v <= max; v += step) out.push(v);
  return out;
};
const FRAME_COUNT_OPTIONS = seq(WALK_FRAME_COUNT_RANGE.min, WALK_FRAME_COUNT_RANGE.max, 1);
const FPS_OPTIONS = seq(WALK_FPS_RANGE.min, WALK_FPS_RANGE.max, 2);

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
  const url = spriteAssetUrl(recordId, stripPreview.stripPath);
  // The strip paints as a CSS background-image, which fires no onError — a
  // missing/404 file just renders blank. The server now surfaces a missing
  // strip as an error run (dropping stripPath so we never get here), but keep a
  // client-side preload probe as defense-in-depth: a strip that fails to load
  // for any other reason shows an explicit placeholder instead of a silent gap.
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const img = new Image();
    img.onerror = () => setFailed(true);
    img.src = url;
    return () => { img.onerror = null; };
  }, [url]);
  if (failed) {
    return (
      <div
        className="border border-port-error/60 rounded flex items-center justify-center text-[9px] leading-tight text-port-error text-center px-1"
        style={{ width: CELL_PX, height }}
      >
        strip missing
      </div>
    );
  }
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
          backgroundImage: `url("${url}")`,
          backgroundSize: `${scrub}px ${height}px`,
          ...PIXELATED,
          '--sprite-walk-loop-end': `-${scrub}px`,
          animation: `sprite-walk-loop ${(frameCount / fps).toFixed(3)}s steps(${frameCount}) infinite`,
        }}
      />
    </div>
  );
}

function DirectionCard({
  recordId, direction, anchorLocked, run, approved, finalized, pending,
  onOpenTrimmer, onGenerate, onApprove, onRetry, onReprocess, onReopen,
  reprocessing, cycleLabel,
}) {
  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState(false);
  const candidate = run?.status === 'candidate' ? run : null;
  // grok renders as an observable TUI session while status is 'rendering'; the
  // deterministic packaging follows as 'postprocessing'. Both block a second
  // Generate (server truth, since the client pending flag drops once the run is
  // persisted). Only 'rendering' has a live Shell session to link to.
  const rendering = run?.status === 'rendering';
  const busy = pending || rendering || run?.status === 'postprocessing';
  // Any run that carries a packed strip preview is trimmable — the trim service
  // resolves geometry from the run's own manifest/stripPreview regardless of
  // on-disk layout (native `runs/`, legacy `grok/`, imported `runs/`, or an
  // imagegen redraw), so there's no vendor-directory coupling here anymore. The
  // link stands for approved and finalized runs too, since a trim is a
  // non-destructive derived artifact under `walk/trims/`.
  const trimmable = Boolean(run?.stripPreview?.stripPath);
  const statusLabel = approved ? 'approved'
    : (pending || rendering) ? 'rendering…'
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

      {/* The server dropped this run's stripPath because its packed strip is
          gone on disk (stripMissing) — render an explicit indicator in place of
          the blank loop, pointing at the recovery that actually works for this
          direction's state: a finalized set must be unlocked first, an
          unapproved candidate can just be regenerated (the Generate button
          below). Deliberately not the status==='error' path, which offers a
          "Retry postprocess" that 409s for a finalized/approved run. */}
      {(approved || candidate) && run?.stripMissing && (
        <p className="text-[10px] text-port-error border border-port-error/60 rounded px-1.5 py-1 leading-tight">
          Walk strip missing on disk — {finalized ? 'unlock the set to regenerate this direction' : 'regenerate to repack it'}.
        </p>
      )}

      {/* grok animates in an observable TUI session — link into the Shell page
          to watch it, and (if needed) type to course-correct or Stop it. The
          session exists only while the render is live ('rendering'). */}
      {rendering && run?.shellSession && (
        <Link
          to={`/shell/${run.shellSession}`}
          title="Watch grok render this walk in the Shell (observe / course-correct / stop)"
          className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs bg-port-card border border-port-accent rounded text-port-accent hover:bg-port-accent hover:text-white"
        >
          <Terminal className="w-3 h-3" /> Watch in Shell
        </Link>
      )}

      {/* Retry also covers a run wedged at 'postprocessing' (crash between
          the video copy and the packaged save) — the endpoint is the
          documented recovery path and validates readiness server-side. */}
      {(run?.status === 'error' || run?.status === 'postprocessing') && (
        <div className="space-y-1">
          {/* Even when packaging failed, grok still produced a clip — show it so
              the render isn't a dead end. The raw clip carries its own magenta
              matte (not transparent), so no checkerboard behind it. */}
          {run.status === 'error' && run.sourceVideoPath && (
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
            disabled={!anchorLocked || busy}
            title={anchorLocked ? undefined : 'Lock this direction\'s reference anchor first'}
            className="flex items-center gap-1 w-full justify-center px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
          >
            {busy
              ? <><RefreshCw className="w-3 h-3 animate-spin" /> {run?.status === 'postprocessing' ? 'Packaging…' : 'Rendering…'}</>
              : <><Film className="w-3 h-3" /> {candidate ? 'Regenerate' : 'Generate walk'}</>}
          </button>
          {/* Re-derive the loop from the clip ALREADY on disk at the current
              frame-count/speed — no grok call, no new paid render. This is the
              "make a better/slower cycle from what we have" action. */}
          {candidate && (
            <button
              onClick={() => onReprocess(run)}
              disabled={busy || reprocessing}
              title={`Rebuild this loop from the existing clip at ${cycleLabel} (no regeneration)`}
              className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
            >
              {reprocessing
                ? <><RefreshCw className="w-3 h-3 animate-spin" /> Reprocessing…</>
                : <><Gauge className="w-3 h-3" /> Reprocess · {cycleLabel}</>}
            </button>
          )}
          {candidate && (
            confirming ? (
              <div className="flex items-center gap-1 text-xs">
                <span className="text-port-warning">Approve?</span>
                <button onClick={() => { setConfirming(false); onApprove(direction, candidate.id); }} className="px-1.5 py-0.5 bg-port-accent text-white rounded">Yes</button>
                <button onClick={() => setConfirming(false)} className="px-1.5 py-0.5 text-gray-400 hover:text-white">No</button>
              </div>
            ) : (
              <button onClick={() => setConfirming(true)} className="w-full px-2 py-0.5 text-xs bg-port-success/20 border border-port-success rounded text-port-success">
                Approve
              </button>
            )
          )}
        </div>
      )}

      {/* Re-open just THIS approved direction so it can be regenerated /
          reprocessed / re-approved — for when one walk is too fast or wrong and
          the rest are fine. Un-freezes a finalized set but keeps the other seven
          approvals; the rendered clip is preserved, so re-approval is one click.
          Inline confirm (not a hidden two-click arm) per the repo's UX. */}
      {approved && (
        reopening ? (
          <ConfirmButtonPair
            prompt={finalized ? 'Reopen (un-freezes set)?' : 'Reopen this direction?'}
            confirmText="Reopen"
            confirmIcon={RotateCcw}
            tone="warning"
            ariaLabel={`Confirm reopen ${direction}`}
            onConfirm={() => { setReopening(false); onReopen(direction); }}
            onCancel={() => setReopening(false)}
          />
        ) : (
          <button
            onClick={() => setReopening(true)}
            title="Re-open this direction to regenerate or reprocess it (rendered clip is kept)"
            className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs bg-port-bg border border-port-border rounded text-gray-400 hover:border-port-accent hover:text-white"
          >
            <RotateCcw className="w-3 h-3" /> Reopen
          </button>
        )
      )}

      {/* The single trim UI now lives in the Loop Trimmer workspace (#2933);
          each card just links into it, deep-linked to this run. Shown for
          approved and finalized directions too — the trim is a non-destructive
          derived artifact, so trimming an approved loop is always allowed. */}
      {trimmable && (
        <button
          onClick={() => onOpenTrimmer(run.id)}
          title="Open this run in the Loop Trimmer"
          className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
        >
          <Scissors className="w-3 h-3" /> Edit in Loop Trimmer
        </button>
      )}
    </div>
  );
}

export default function WalkWorkflow({
  record, reference, walk, renders, duration, onDurationChange, onGenerate,
  frameCount = WALK_DEFAULT_FRAME_COUNT, fps = WALK_DEFAULT_FPS,
  onFrameCountChange = () => {}, onFpsChange = () => {},
  onOpenTrimmer = () => {}, onChanged,
}) {
  const recordId = record.id;
  const manifest = reference?.manifest || null;
  const runs = walk?.runs || [];
  const selection = walk?.selection || null;
  const finalized = Boolean(walk?.walkSet);
  // A source-pipeline import (#2895) has no regenerable grok clips behind its
  // frozen set, so the server refuses to unlock it — hide the affordance and
  // show why rather than offering a button that always 409s. The server stamps
  // this flag on the walk state so the client doesn't re-derive the path convention.
  const importedWalkSet = Boolean(walk?.walkSet?.imported);

  // direction → jobId for in-flight video renders. The hook instance is owned
  // by the Sprites page and shared with the asset collection (#2931) so both
  // Generate buttons gate on ONE map — a second instance here would let a
  // Regenerate fired from an asset card leave this button enabled, inviting a
  // duplicate paid render for the same direction. The generate ACTION lives up
  // there too, so both entry points submit through one code path.
  const { pendingJobs } = renders;

  // Keep the card in sync with server-side run progress. Three long-ish states
  // need polling: 'rendering' (the observable grok-tui clip render, up to
  // ~10 min — the client pending flag drops as soon as the run persists, so
  // this poll is what carries the card through the render), 'postprocessing'
  // (the deterministic frame-extraction/un-key, seconds-to-minutes), and a
  // stale 'queued' with no live job (an attach waiting behind the write tail —
  // bounded to ~60s so a genuinely dead job doesn't poll forever). 'rendering'
  // and 'postprocessing' are legitimately long, so they poll unbounded until
  // they flip (executeTuiRun's 30-min hard cap guarantees 'rendering' resolves).
  // Booleans (not the runs array) as deps: refetches produce fresh array
  // identities every 4s, which would otherwise reset the bounded tick count.
  // 'rendering' and 'postprocessing' are legitimately long — poll unbounded
  // until they flip; only the stale-'queued' case is bounded (~60s).
  const unbounded = runs.some((r) => r.status === 'rendering' || r.status === 'postprocessing');
  const awaitingAttach = runs.some((r) => r.status === 'queued' && !pendingJobs[r.direction]);
  useEffect(() => {
    if (!unbounded && !awaitingAttach) return undefined;
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
      if (!unbounded && ticks > 15) {
        clearInterval(timer);
        return;
      }
      onChanged();
    }, 4000);
    return () => clearInterval(timer);
  }, [unbounded, awaitingAttach, onChanged]);

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

  const [approve] = useAsyncAction(async (direction, runId) => {
    await approveSpriteWalk(recordId, { direction, runId }, { silent: true });
    toast.success(`Walk ${direction} approved`);
    onChanged();
  }, { errorMessage: 'Approve failed' });

  // Re-run the deterministic packer on a run's ON-DISK clip at the CURRENT
  // frame-count/speed — the one call shared by the errored-run "Retry" and the
  // candidate "Reprocess" buttons (no grok, no regeneration).
  const postprocessRun = (run) => postprocessSpriteWalk(recordId, { runId: run.id, frameCount, fps }, { silent: true });

  // Retry a wedged/errored run so a recovery also picks up the chosen cycle look.
  const [retryPostprocess] = useAsyncAction(async (run) => {
    await postprocessRun(run);
    toast.success('Postprocess complete');
    onChanged();
  }, { errorMessage: 'Postprocess failed' });

  // Reprocess a candidate. Track the in-flight direction so only that card spins.
  const [reprocessingDir, setReprocessingDir] = useState(null);
  const [reprocess] = useAsyncAction(async (run) => {
    setReprocessingDir(run.direction);
    try {
      await postprocessRun(run);
      toast.success(`Walk ${run.direction} reprocessed · ${frameCount}f @ ${fps}fps`);
      onChanged();
    } finally {
      setReprocessingDir(null);
    }
  }, { errorMessage: 'Reprocess failed' });

  // Re-open ONE approved direction (finer-grained than the set-wide Unlock).
  const [reopen] = useAsyncAction(async (direction) => {
    await reopenSpriteWalk(recordId, { direction }, { silent: true });
    toast.success(`Walk ${direction} reopened — regenerate or reprocess it`);
    onChanged();
  }, { errorMessage: 'Reopen failed' });

  // Unlock (un-freeze) the finalized walk set. Irreversible-ish (it re-opens
  // every direction), so it's gated behind an inline confirm per the repo's
  // confirmation UX — not a hidden two-click arm or a browser dialog.
  const [unlockConfirm, setUnlockConfirm] = useState(false);
  const [unlock, unlocking] = useAsyncAction(async () => {
    await unlockSpriteWalk(recordId, { silent: true });
    setUnlockConfirm(false);
    toast.success('Walk set unlocked — directions are editable again');
    onChanged();
  }, { errorMessage: 'Unlock failed' });

  // The walk workflow only becomes actionable once the main is frozen (the
  // south anchor IS the main); hide it entirely before that.
  if (!manifest?.mainReference?.locked) return null;

  const approvedCount = Object.values(selection?.directions || {})
    .filter((d) => d?.status === 'approved').length;

  const cycleSeconds = (frameCount / fps).toFixed(2);
  const cycleLabel = `${frameCount}f @ ${fps}fps`;

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
          <div className="flex items-center gap-2">
            <p className="text-xs text-port-success flex items-center gap-1">
              <Lock className="w-3 h-3" /> walk set frozen · immutable
            </p>
            {importedWalkSet ? (
              <span className="text-[10px] text-gray-500" title="Imported from the source pipeline — no regenerable clips">
                imported · new version to revise
              </span>
            ) : unlockConfirm ? (
              <ConfirmButtonPair
                prompt="Re-open all directions?"
                confirmText="Unlock"
                confirmIcon={Unlock}
                busy={unlocking}
                busyText="Unlocking…"
                tone="warning"
                ariaLabel="Confirm unlock walk set"
                onConfirm={() => unlock()}
                onCancel={() => setUnlockConfirm(false)}
              />
            ) : (
              <button
                onClick={() => setUnlockConfirm(true)}
                title="Un-freeze the walk set to regenerate or re-approve directions (rendered clips are kept)"
                className="flex items-center gap-1 px-1.5 py-0.5 text-xs bg-port-bg border border-port-border rounded text-gray-400 hover:border-port-accent hover:text-white"
              >
                <Unlock className="w-3 h-3" /> Unlock
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              Frames
              <select
                value={frameCount}
                onChange={(e) => onFrameCountChange(Number(e.target.value))}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {FRAME_COUNT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <span className="flex items-center gap-1"><Gauge className="w-3 h-3" /> Speed</span>
              <select
                value={fps}
                onChange={(e) => onFpsChange(Number(e.target.value))}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {FPS_OPTIONS.map((n) => <option key={n} value={n}>{n} fps</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-400" title="grok renders 6s or 10s clips; length only affects how much source footage the packer has to choose from">
              Clip
              <select
                value={duration}
                onChange={(e) => onDurationChange(Number(e.target.value))}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {WALK_DURATIONS.map((d) => <option key={d} value={d}>{d}s</option>)}
              </select>
            </label>
            <span className="text-[11px] text-gray-500 tabular-nums" title="cycle duration = frames ÷ speed">
              {cycleSeconds}s / cycle
            </span>
          </div>
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
            onOpenTrimmer={onOpenTrimmer}
            onGenerate={onGenerate}
            onApprove={approve}
            onRetry={retryPostprocess}
            onReprocess={reprocess}
            onReopen={reopen}
            reprocessing={reprocessingDir === anchor.direction}
            cycleLabel={cycleLabel}
          />
        ))}
      </div>
    </div>
  );
}
