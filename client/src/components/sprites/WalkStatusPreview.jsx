import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Check, Cpu, Terminal } from 'lucide-react';
import { WALK_PHASES } from '../../lib/spriteTrimmer.js';
import SpritePreview from './SpritePreview.jsx';
import { spriteAssetUrl, checkerboardStyle, PIXELATED } from './spriteAssets.js';

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
  // missing/404 file just renders blank. The server drops stripPath when it
  // detects a missing strip. The preload also catches failures after the
  // manifest was read and shows an explicit placeholder.
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

export default function WalkStatusPreview({
  recordId, direction, anchorLocked, anchorPath, run, approved, finalized, pending,
  candidate, rendering, supersededAnchor, hasSourceClip, drift, cycleLabel, imported,
}) {
  // Before a packaged animation exists, keep the exact locked directional
  // anchor visible in the card. It is the idle/source pose the walk will be
  // conditioned on, and reviewing it here prevents spending a render on a
  // direction whose identity or anatomy is already wrong. A candidate or
  // approved strip replaces it as soon as there is an animation to inspect.
  const hasWalkPreview = Boolean((approved || candidate) && run?.stripPreview?.stripPath);
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
    <>
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
    </>
  );
}
