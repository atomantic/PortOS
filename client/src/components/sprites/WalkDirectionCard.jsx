import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Check, Film, RefreshCw, Scissors, Terminal, Gauge, RotateCcw, Cpu } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import Banner from '../ui/Banner.jsx';
import LocalLoopConditioning from './LocalLoopConditioning.jsx';
import { CorrectionNoteToggle, walkCorrectionKey } from './CorrectionNote.jsx';
import SpritePreview from './SpritePreview.jsx';
import { spriteAssetUrl, checkerboardStyle, PIXELATED } from './spriteAssets.js';
import { WALK_PHASES } from '../../lib/spriteTrimmer.js';
import { walkUnlockCopy } from '../../lib/spriteWalkUnlock.js';

const CELL_PX = 96; // preview cell size — the strip animates at 96px/frame

// Delivered clip length for a run, when the server managed to probe it
// (`sourceVideoSeconds` is absent on older runs and when ffprobe is missing —
// absent means UNKNOWN, so render nothing rather than implying a 0s clip).
// A mismatch against the requested `duration` is worth surfacing: it is the
// visible evidence that grok rendered something other than what was asked for.
function clipLengthLabel(run) {
  const delivered = Number(run?.sourceVideoSeconds);
  if (!(delivered > 0)) return null;
  const requested = Number(run?.duration);
  const mismatch = requested > 0 && Math.abs(requested - delivered) >= 0.5;
  // A truncated clip (a real but near-zero-length file) must not round to the
  // "0.0s" that would read as the absent case handled above — give sub-0.05s
  // lengths the extra digit so a broken clip looks broken, not unknown.
  const shown = delivered.toFixed(delivered < 0.05 ? 2 : 1);
  return {
    text: `${shown}s clip${mismatch ? ` (asked ${requested}s)` : ''}`,
    mismatch,
  };
}

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
  // Content-token the URL (#3020) — a CSS background-image at an unchanged URL
  // is reused from the already-decoded image without issuing a request, so a
  // reprocessed strip would keep painting stale until a manual reload. See
  // spriteAssets.js for the full why.
  const url = spriteAssetUrl(recordId, stripPreview.stripPath, stripPreview.stripVersion);
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
        className="border border-port-error/60 rounded flex items-center justify-center text-xs leading-tight text-port-error text-center px-1"
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

// The one remedy for an imported direction with nothing behind it. The clip is
// the importer's to bring across, so authoring a new version by hand isn't it.
const REIMPORT_REMEDY = 're-import this character to bring its source clip across';

const driftRemedy = ({ approved, hasSourceClip, imported }) => {
  // Evidence, not provenance: the server gates re-derivation on whether the
  // direction's clip is actually on disk, so an imported direction whose clip
  // came across re-derives exactly like a native one. Only a direction with no
  // clip behind it is a dead end — and for an import the fix is re-importing the
  // character, not authoring a new version by hand.
  if (!hasSourceClip) {
    return imported ? REIMPORT_REMEDY : 'import this direction\'s source clip to re-derive it';
  }
  if (approved) return 'reopen this direction to re-derive it from its clip';
  return 'reprocess it from its clip';
};

export default function WalkDirectionCard({
  recordId, direction, anchorLocked, anchorPath, run, approved, finalized, pending,
  onOpenTrimmer, onGenerate, onApprove, onRetry, onReprocess, onReopen,
  reprocessing, retrying, cycleLabel, drift, targetSaving, imported,
  corrections, onCorrectionChange, provider, conditioning, onConditioningChange, conditioningSupported,
}) {
  const [confirming, setConfirming] = useState(false);
  const [reopening, setReopening] = useState(false);
  const candidate = run?.status === 'candidate' ? run : null;
  // grok renders as an observable TUI session while status is 'rendering'; the
  // deterministic packaging follows as 'postprocessing'. Both block a second
  // Generate (server truth, since the client pending flag drops once the run is
  // persisted). Only 'rendering' has a live Shell session to link to.
  const rendering = run?.status === 'rendering';
  const supersededAnchor = run?.status === 'superseded-anchor';
  // `targetSaving` blocks the render actions without claiming the direction is
  // rendering: the set's cycle target is mid-PATCH, so a queue now would be
  // gated against a value the server hasn't persisted yet (409 target mismatch).
  const inFlight = pending || rendering || run?.status === 'postprocessing';
  const busy = inFlight || targetSaving;
  // Any run that carries a packed strip preview is trimmable — the trim service
  // resolves geometry from the run's own manifest/stripPreview regardless of
  // on-disk layout (native `runs/`, legacy `grok/`, imported `runs/`, or an
  // imagegen redraw), so there's no vendor-directory coupling here anymore. The
  // link stands for approved and finalized runs too, since a trim is a
  // non-destructive derived artifact under `walk/trims/`.
  const trimmable = Boolean(run?.stripPreview?.stripPath) && !supersededAnchor;
  // Before a packaged animation exists, keep the exact locked directional
  // anchor visible in the card. It is the idle/source pose the walk will be
  // conditioned on, and reviewing it here prevents spending a render on a
  // direction whose identity or anatomy is already wrong. A candidate or
  // approved strip replaces it as soon as there is an animation to inspect.
  const hasWalkPreview = Boolean((approved || candidate) && run?.stripPreview?.stripPath);
  const hasSourceClip = Boolean(run?.sourceVideoPath) && !run?.sourceClipMissing;
  // The server stamps the reopen block with the exact same resolver that will
  // validate the POST. A missing block from an older peer remains an ordinary
  // reopen; only a stamped block changes the affordance.
  const reopenCopy = walkUnlockCopy(run?.reopen, { mode: 'reopen', direction });
  const reopenBlocked = Boolean(reopenCopy);
  const statusLabel = approved ? 'approved'
    : (pending || rendering) ? 'rendering…'
      : run?.status === 'postprocessing' ? 'packaging…'
        : supersededAnchor ? 'anchor revised'
          : run?.status || (anchorLocked ? 'ready' : 'anchor not locked');
  // What grok actually delivered, probed server-side — the durable answer to
  // "does the clip length picker do anything?", which used to live only in
  // contradicting code comments (#3022).
  const clipLength = clipLengthLabel(run);

  return (
    <div className="bg-port-bg border border-port-border rounded p-2 space-y-1.5">
      <p className="text-xs text-gray-400 flex items-center justify-between">
        {direction}
        <span className={`text-[10px] ${approved ? 'text-port-success' : run?.status === 'error' ? 'text-port-error' : 'text-gray-400'}`}>
          {approved && <Check className="w-3 h-3 inline mr-0.5" />}{statusLabel}
        </span>
      </p>

      {clipLength && (
        <p
          className={`text-[10px] ${clipLength.mismatch ? 'text-port-warning' : 'text-gray-400'}`}
          title={clipLength.mismatch
            ? 'grok delivered a different clip length than requested — its image_to_video tool renders only 6, 10 or 15 s'
            : 'Source clip length grok delivered (probed from the file)'}
        >
          {clipLength.text}
        </p>
      )}

      {hasWalkPreview && (
        <StripLoop recordId={recordId} stripPreview={run.stripPreview} />
      )}
      {run?.conditioningMode && (
        <p className="text-[10px] text-gray-400">
          Rendered: {run.conditioningMode === 'fflf' ? 'paired idle anchors' : 'first idle anchor'}
        </p>
      )}
      {!hasWalkPreview && anchorLocked && anchorPath && (
        <div className="flex items-end gap-2">
          <SpritePreview
            recordId={recordId}
            path={anchorPath}
            alt={`${direction} reference idle pose`}
            className="h-24 w-24 shrink-0 rounded border border-port-border"
            zoomable
          />
          <span className="pb-1 text-xs leading-tight text-gray-400">reference idle</span>
        </div>
      )}
      {supersededAnchor && (
        <p className="rounded border border-port-warning/40 px-1.5 py-1 text-[10px] leading-tight text-port-warning">
          Previous walk kept in history · generate again from the current anchor.
        </p>
      )}

      {/* This direction is packaged at a geometry the set is no longer targeting
          (#2985) — surfaced HERE rather than at atlas-compile time, which used to
          be the first and only place a ragged set showed up. The remedy depends
          on what the direction still has behind it: an unapproved candidate can
          be re-derived from its on-disk clip with the Reprocess button below, an
          approved one has to be reopened first, and a clipless import follows
          the server-backed reopen recovery shown below. */}
      {drift && (
        <p className="text-[10px] text-port-warning border border-port-warning/60 rounded px-1.5 py-1 leading-tight">
          {[drift.frameCountDrifts && `${drift.frameCount}f`, drift.fpsDrifts && `${drift.fps}fps`]
            .filter(Boolean).join(' · ')} · re-derive to {cycleLabel}
          <span className="block text-gray-400">
            {driftRemedy({ approved, hasSourceClip, imported })}
          </span>
        </p>
      )}

      {/* The server dropped this run's stripPath because its packed strip is
          gone on disk (stripMissing) — render an explicit indicator in place of
          the blank loop, pointing at the recovery that actually works for this
          direction's state: a finalized direction uses its server-backed walk
          action, while an unapproved candidate can just be regenerated (the
          Generate button below). Deliberately not the status==='error' path, which offers a
          "Retry postprocess" that 409s for a finalized/approved run. */}
      {(approved || candidate) && run?.stripMissing && (
        <p className="text-[10px] text-port-error border border-port-error/60 rounded px-1.5 py-1 leading-tight">
          {/* A missing strip has its own recovery path. The action below carries
              the server's exact reopen/unlock decision, including whether a
              clipless import can be regenerated from its locked anchor. */}
          Walk strip missing on disk — {finalized
            ? 'use the walk action below to regenerate this direction' : 'regenerate to repack it'}.
        </p>
      )}

      {/* grok animates in an observable TUI session — link into the Shell page
          to watch it, and (if needed) type to course-correct or Stop it. The
          session exists only while the render is live ('rendering'). */}
      {rendering && run?.shellSession && (
        <Link
          to={`/shell/${run.shellSession}`}
          title="Watch grok render this walk in the Shell (observe / course-correct / stop)"
          className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-card border border-port-accent rounded text-port-accent hover:bg-port-accent hover:text-white"
        >
          <Terminal className="w-3 h-3" /> Watch in Shell
        </Link>
      )}

      {/* The local lane has no PTY to attach to, so its observability is the
          Render Queue row for the job — same slot, same shape, so a rendering
          card is never a dead end on either lane. Mutually exclusive with the
          Shell link above: a run carries a shellSession OR a jobId. */}
      {rendering && !run?.shellSession && run?.jobId && (
        <Link
          to="/system-resources/queues"
          title="Watch this local render in the Render Queue (progress / cancel)"
          className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-card border border-port-accent rounded text-port-accent hover:bg-port-accent hover:text-white"
        >
          <Cpu className="w-3 h-3" /> Watch in Render Queue
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
      )}

      {!finalized && !approved && (
        <div className="space-y-1.5">
          {/* Correction note for the NEXT render (#3134) — the same key the
              asset-collection walk card writes, so a note typed on either
              surface is visible on both and rides whichever Generate fires.
              Hidden when this direction can't be rendered at all. */}
          {provider === 'local' && (
            <LocalLoopConditioning
              recordId={recordId}
              direction={direction}
              anchor={{ path: anchorPath }}
              enabled={conditioning}
              onChange={onConditioningChange}
              disabled={busy || !anchorLocked}
              supported={conditioningSupported}
            />
          )}
          {anchorLocked && onCorrectionChange && (
            <CorrectionNoteToggle
              noteKey={walkCorrectionKey(direction)}
              label={`${direction} walk cycle`}
              corrections={corrections}
              onChange={onCorrectionChange}
              placeholder="Correction (optional), e.g. the legs barely lift"
            />
          )}
          <button
            type="button"
            onClick={() => provider === 'local'
              ? onGenerate(direction, { returnToIdleAnchor: conditioning }) : onGenerate(direction)}
            disabled={!anchorLocked || busy || (provider === 'local' && conditioning && !conditioningSupported)}
            title={anchorLocked ? undefined : 'Lock this direction\'s reference anchor first'}
            className="flex items-center gap-1 w-full justify-center px-2 py-1 text-xs pointer-coarse:min-h-11 bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
          >
            {inFlight
              ? <><RefreshCw className="w-3 h-3 animate-spin" /> {run?.status === 'postprocessing' ? 'Packaging…' : 'Rendering…'}</>
              : <><Film className="w-3 h-3" /> {candidate ? 'Regenerate' : 'Generate walk'}</>}
          </button>
          {/* Re-derive the loop from the clip ALREADY on disk at the current
              frame-count/speed — no grok call, no new paid render. This is the
              "make a better/slower cycle from what we have" action. */}
          {candidate && (
            <button
              type="button"
              onClick={() => onReprocess(run)}
              disabled={busy || reprocessing}
              title={`Rebuild this loop from the existing clip at ${cycleLabel} (no regeneration)`}
              className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-bg border border-port-border rounded text-gray-300 hover:border-port-accent disabled:opacity-50"
            >
              {reprocessing
                ? <><RefreshCw className="w-3 h-3 animate-spin" /> Reprocessing…</>
                : <><Gauge className="w-3 h-3" /> Reprocess · {cycleLabel}</>}
            </button>
          )}
          {candidate && (
            confirming ? (
              <ConfirmButtonPair
                className="flex-wrap"
                prompt="Approve?"
                confirmText="Approve"
                cancelText="Cancel"
                confirmIcon={Check}
                tone="success"
                ariaLabel={`Confirm approve ${direction}`}
                onConfirm={() => { setConfirming(false); onApprove(direction, candidate.id); }}
                onCancel={() => setConfirming(false)}
              />
            ) : (
              // Approval is where a direction's geometry gets frozen into the
              // set the atlas compiles, so a drifted candidate can't be approved
              // — the server refuses it, and offering the button anyway would
              // just hand back a 409 after the click. Same for a run still
              // packaged by the source pipeline: its per-frame images were never
              // imported, so approving it 409s RUN_FRAMES_MISSING however well its
              // geometry happens to match. Reprocessing from the clip is the way
              // through, and it clears the flag.
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={Boolean(drift) || Boolean(run?.importedPackaging)}
                title={run?.importedPackaging
                  ? 'This run was packaged by the source pipeline, which kept its frames — reprocess it from its clip first'
                  : drift ? `Re-derive this direction to ${cycleLabel} before approving it` : undefined}
                className="min-h-[36px] w-full px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-success/20 border border-port-success rounded text-port-success disabled:opacity-50"
              >
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
          A stamped blocked branch names the fresh-render cost before sending the
          acknowledgement; an ordinary branch stays the compact existing action. */}
      {approved && (reopenBlocked ? (
        <Banner tone="warning" size="sm" icon={RotateCcw} className="space-y-1.5">
          <p className="leading-relaxed">{reopenCopy.text}</p>
          {reopenCopy.action && (reopening ? (
            <ConfirmButtonPair
              prompt={reopenCopy.prompt}
              confirmText={reopenCopy.action}
              confirmIcon={RotateCcw}
              tone="warning"
              ariaLabel={`Confirm reopen ${direction} without source clips`}
              onConfirm={() => {
                setReopening(false);
                onReopen(direction, reopenCopy.acknowledgeNoClips, reopenCopy.toast);
              }}
              onCancel={() => setReopening(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setReopening(true)}
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-bg border border-port-warning/60 rounded text-port-warning hover:bg-port-warning/10"
            >
              <RotateCcw className="w-3 h-3" /> {reopenCopy.action}
            </button>
          ))}
        </Banner>
      ) : (
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
            type="button"
            onClick={() => setReopening(true)}
            title="Re-open this direction to regenerate or reprocess it (rendered clip is kept)"
            className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-bg border border-port-border rounded text-gray-400 hover:border-port-accent hover:text-white"
          >
            <RotateCcw className="w-3 h-3" /> Reopen
          </button>
        )
      ))}

      {/* The single trim UI now lives in the Loop Trimmer workspace (#2933);
          each card just links into it, deep-linked to this run. Shown for
          approved and finalized directions too — the trim is a non-destructive
          derived artifact, so trimming an approved loop is always allowed. */}
      {trimmable && (
        <button
          type="button"
          onClick={() => onOpenTrimmer(run.id)}
          title="Open this run in the Loop Trimmer"
          className="flex items-center gap-1 w-full justify-center px-2 py-0.5 text-xs pointer-coarse:min-h-11 bg-port-card border border-port-border rounded text-gray-300 hover:border-port-accent"
        >
          <Scissors className="w-3 h-3" /> Edit in Loop Trimmer
        </button>
      )}
    </div>
  );
}
