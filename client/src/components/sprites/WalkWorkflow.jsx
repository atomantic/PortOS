import { useLoopConditioning } from './LocalLoopConditioning.jsx';
import { useMemo, useState } from 'react';
import { Film, Lock, Unlock } from 'lucide-react';
import toast from '../ui/Toast';
import {
  approveSpriteWalk, postprocessSpriteWalk, unlockSpriteWalk, reopenSpriteWalk,
} from '../../services/apiSprites.js';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import Banner from '../ui/Banner.jsx';
import CycleTarget from './CycleTarget.jsx';
import AnimationProviderPicker from './AnimationProviderPicker.jsx';
import WalkDirectionCard from './WalkDirectionCard.jsx';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { GROK_VIDEO_DURATIONS } from '../../lib/grokVideoClip.js';
import {
  WALK_DEFAULT_FRAME_COUNT, WALK_DEFAULT_FPS,
} from '../../lib/spriteTrimmer.js';
import { walkUnlockCopy, WALK_UNLOCK_TOAST } from '../../lib/spriteWalkUnlock.js';

// Walk workflow (issue #2897): one grok image_to_video clip per locked
// directional anchor, deterministic server-side packaging into the 8-phase
// strip, per-direction review (loop preview) and approval. Loop trimming moved
// to its own deep-linkable workspace (#2933) — each card links into it. The
// server's run records / selection / walk-set are the source of truth; this
// component renders them and fires generate/approve.

// The scrub distance varies with the strip's frame count (a native run packs
// 8, an imported redraw cycle can pack 12 — #2924), so the single keyframe
// rule reads it from a per-preview custom property instead of hardcoding 8.
const LOOP_KEYFRAMES = '@keyframes sprite-walk-loop { to { background-position-x: var(--sprite-walk-loop-end) } }';
// Clip length only decides how much source footage the packer can choose from;
// the CYCLE'S look (walk vs run) comes from the frame-count + speed controls.
// The offered lengths live in lib/grokVideoClip.js — see there for why 6/10/15 s
// are the only ones (#3022).

/**
 * The set-level Unlock, as a trigger that swaps to an inline confirm.
 *
 * Both frozen-set entry points render this: the header's plain Unlock and the
 * blocked panel's "Unlock anyway". They differ only in copy and tone, and they
 * are mutually exclusive on `unlockBlocked` — sharing the shape keeps a change to
 * the confirm UX (busy text, tone, aria convention) from having to be made twice
 * and landing in only one of the two frozen-set paths.
 */
function UnlockAffordance({
  armed, onArm, onCancel, onConfirm, busy, label, prompt, ariaLabel, title, className,
}) {
  if (armed) {
    return (
      <ConfirmButtonPair
        prompt={prompt}
        confirmText={label}
        confirmIcon={Unlock}
        busy={busy}
        busyText="Unlocking…"
        tone="warning"
        ariaLabel={ariaLabel}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }
  return (
    <button
      type="button"
      onClick={onArm}
      title={title}
      className={`flex items-center gap-1 px-1.5 py-0.5 text-xs pointer-coarse:min-h-11 border rounded ${className}`}
    >
      <Unlock className="w-3 h-3" /> {label}
    </button>
  );
}

export default function WalkWorkflow({
  record, reference, walk, renders, duration, onDurationChange, onGenerate,
  onOpenTrimmer = () => {}, onChanged, corrections = null, onCorrectionChange = null,
  providers = null, provider = 'grok', onProviderChange = () => {},
  providersError = null, onRetryProviders = null,
}) {
  const recordId = record.id;
  const loopConditioning = useLoopConditioning(recordId, 'walk');
  const conditioningSupported = providers?.find((row) => row.id === 'local')?.returnToIdleAnchorSupported === true;
  // The cycle target is server-resolved (app contract → set pin → first approved
  // direction → default) so the client never re-derives the precedence chain.
  // The fallback only covers a walk state fetched by an older client/peer.
  const target = walk?.walkTarget || {
    frameCount: WALK_DEFAULT_FRAME_COUNT, fps: WALK_DEFAULT_FPS, source: 'default', drift: [],
  };
  const { frameCount, fps } = target;
  const driftByDirection = useMemo(
    () => Object.fromEntries((target.drift || []).map((d) => [d.direction, d])),
    [target.drift],
  );
  // Every render action is gated on the target PATCH settling — otherwise the
  // user picks a new target and clicks Generate before the server has it, and
  // the queue-time guard 409s on a value they already changed.
  const [targetSaving, setTargetSaving] = useState(false);
  const manifest = reference?.manifest || null;
  const runs = walk?.runs || [];
  const selection = walk?.selection || null;
  const finalized = Boolean(walk?.walkSet);
  // A source-pipeline import (#2895) still carries directions PortOS cannot
  // compile from. The server stamps both the set-level flag and the precise
  // per-direction list, so the client never re-derives the path convention — and
  // a card reads the fact about ITS OWN direction rather than a set-wide
  // approximation, since directions leave the list one at a time as they are
  // re-derived. An older peer's walk state may carry only the boolean; fall back
  // to it so every direction still reads as imported there.
  const importedWalkSet = Boolean(walk?.walkSet?.imported);
  const importedDirections = walk?.walkSet?.importedDirections || null;
  const isImportedDirection = (direction) => (importedDirections
    ? importedDirections.includes(direction) : importedWalkSet);
  // Whether unlock is refused, and whether that refusal can be acknowledged past,
  // is stamped by the server from the same resolver its own gate uses (#3043) —
  // so the button offered here and the 409 it might hit can never be computed
  // from two different readings of the same set. The copy is shared with the Loop
  // Trimmer's lock block; null means "not blocked, offer the ordinary Unlock".
  const unlockCopy = walkUnlockCopy(walk?.walkSet?.unlock);
  const unlockBlocked = Boolean(unlockCopy);

  // direction → jobId for in-flight video renders. The hook instance is owned
  // by the Sprites page and shared with the asset collection (#2931) so both
  // Generate buttons gate on ONE map — a second instance here would let a
  // Regenerate fired from an asset card leave this button enabled, inviting a
  // duplicate paid render for the same direction. The generate ACTION lives up
  // there too, so both entry points submit through one code path.
  const { pendingJobs } = renders;

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
  // Geometry is deliberately NOT sent: the server adopts the set's pinned target
  // for an omitted count/fps, so the request can't 409 against a target this
  // page's state is one refetch behind on (#2985).
  const postprocessRun = (run) => postprocessSpriteWalk(recordId, { runId: run.id }, { silent: true });

  // Retry a wedged/errored run so a recovery also picks up the chosen cycle look.
  const [retryPostprocess, retrying] = useAsyncAction(async (run) => {
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
  const [reopen] = useAsyncAction(async (direction, acknowledgeNoClips = false, successMessage = null) => {
    await reopenSpriteWalk(recordId, { direction, acknowledgeNoClips }, { silent: true });
    toast.success(successMessage || `Walk ${direction} reopened — regenerate or reprocess it`);
    onChanged();
  }, { errorMessage: 'Reopen failed' });

  // Unlock (un-freeze) the finalized walk set. Irreversible-ish (it re-opens
  // every direction), so it's gated behind an inline confirm per the repo's
  // confirmation UX — not a hidden two-click arm or a browser dialog.
  // ONE flag for both entry points below (the header's plain Unlock and the
  // blocked panel's "Unlock anyway"): they are mutually exclusive on
  // `unlockBlocked`, so only one is ever mounted. A third entry point would need
  // its own flag, or it would arm silently alongside whichever of these is live.
  const [unlockConfirm, setUnlockConfirm] = useState(false);
  // `acknowledgeNoClips` is sent ONLY from the blocked-but-regenerable branch,
  // whose panel names what it costs (a fresh render per direction). Every other
  // unlock omits it and keeps the server's refusal — an override the user was
  // never warned about is exactly what the guard exists to prevent.
  const [unlock, unlocking] = useAsyncAction(async (acknowledgeNoClips = false) => {
    await unlockSpriteWalk(recordId, { acknowledgeNoClips }, { silent: true });
    setUnlockConfirm(false);
    toast.success((acknowledgeNoClips && unlockCopy?.toast) || WALK_UNLOCK_TOAST);
    onChanged();
  }, { errorMessage: 'Unlock failed' });

  // The walk workflow only becomes actionable once the main is frozen (the
  // south anchor IS the main); hide it entirely before that.
  if (!manifest?.mainReference?.locked) return null;

  const approvedCount = Object.values(selection?.directions || {})
    .filter((d) => d?.status === 'approved').length;

  const cycleLabel = `${frameCount}f @ ${fps}fps`;
  const driftCount = (target.drift || []).length;

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
            {unlockBlocked ? (
              // The block itself is explained (and acted on) in the panel below —
              // it needs more room than this dense row, and a consequence this
              // expensive must not live in a tooltip.
              <span className="text-[10px] text-gray-500">imported · no clips to re-derive</span>
            ) : (
              <UnlockAffordance
                armed={unlockConfirm}
                onArm={() => setUnlockConfirm(true)}
                onCancel={() => setUnlockConfirm(false)}
                onConfirm={() => unlock()}
                busy={unlocking}
                label="Unlock"
                prompt="Re-open all directions?"
                ariaLabel="Confirm unlock walk set"
                title="Un-freeze the walk set to regenerate or re-approve directions (rendered clips are kept)"
                className="bg-port-bg border-port-border text-gray-400 hover:border-port-accent hover:text-white"
              />
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <CycleTarget
              recordId={recordId}
              target={target}
              disabled={finalized}
              onChanged={onChanged}
              onSavingChange={setTargetSaving}
            />
            <AnimationProviderPicker
              id={`walk-provider-${recordId}`}
              providers={providers}
              provider={provider}
              onChange={onProviderChange}
              disabled={finalized}
              error={providersError}
              onRetry={onRetryProviders}
            />
            <label className="flex items-center gap-1.5 text-xs text-gray-400" htmlFor={`walk-clip-${recordId}`} title={provider === 'local'
                ? "The local model renders on a fixed frame grid, so this length is snapped to the nearest legal clip. Length only affects how much source footage the packer has to choose from, not the walk's speed."
                : "grok renders 6, 10 or 15 s clips — these are the only lengths it offers, and a shorter request comes back as 6s. Length only affects how much source footage the packer has to choose from, not the walk's speed."}>
              Clip
              <select
                id={`walk-clip-${recordId}`}
                value={duration}
                onChange={(e) => onDurationChange(Number(e.target.value))}
                className="bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white"
              >
                {GROK_VIDEO_DURATIONS.map((d) => <option key={d} value={d}>{d}s</option>)}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Why the frozen set refuses a plain Unlock, and the one action that gets
          past it. Before #3043 this was a tooltip on a dead label, which left a
          fully-imported set with no reachable way to revise anything — not the
          cycle target, not one direction. The cost is stated as visible text
          rather than a title, per the repo's "tooltip-only warnings are missed on
          touch" rule; `copy.action` is null when even regeneration is out, and
          then there is genuinely nothing to offer. */}
      {unlockBlocked && (
        <Banner tone="warning" size="sm" icon={Unlock} className="space-y-1.5">
          <p className="leading-relaxed">{unlockCopy.text}</p>
          {unlockCopy.action && (
            <UnlockAffordance
              armed={unlockConfirm}
              onArm={() => setUnlockConfirm(true)}
              onCancel={() => setUnlockConfirm(false)}
              onConfirm={() => unlock(true)}
              busy={unlocking}
              label={unlockCopy.action}
              prompt={unlockCopy.prompt}
              ariaLabel="Confirm unlock walk set without source clips"
              className="bg-port-bg border-port-warning/60 text-port-warning hover:bg-port-warning/10"
            />
          )}
        </Banner>
      )}

      {/* Set-level drift summary: visible BEFORE eight renders are spent, rather
          than as an atlas-compile wall afterwards. Legacy mixed sets (generated
          back when the count/fps were per-render page state) land here on load. */}
      {driftCount > 0 && (
        <p className="text-xs text-port-warning border border-port-warning/60 rounded px-2 py-1.5">
          {driftCount === 1
            ? `1 of 8 packaged directions differs from the ${cycleLabel} target — re-derive it before compiling the atlas.`
            : `${driftCount} of 8 packaged directions differ from the ${cycleLabel} target — re-derive them before compiling the atlas.`}
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(manifest.anchors || []).map((anchor) => (
          <WalkDirectionCard
            key={anchor.direction}
            recordId={recordId}
            direction={anchor.direction}
            anchorLocked={anchor.status === 'locked'}
            anchorPath={anchor.path}
            run={latestRunByDirection[anchor.direction] || null}
            approved={selection?.directions?.[anchor.direction]?.status === 'approved'}
            finalized={finalized}
            pending={Boolean(pendingJobs[anchor.direction])}
            targetSaving={targetSaving}
            drift={driftByDirection[anchor.direction] || null}
            imported={isImportedDirection(anchor.direction)}
            onOpenTrimmer={onOpenTrimmer}
            provider={provider}
            conditioning={loopConditioning.selected(anchor.direction, latestRunByDirection[anchor.direction])}
            onConditioningChange={(value) => loopConditioning.change(anchor.direction, value)}
            conditioningSupported={conditioningSupported}
            onGenerate={onGenerate}
            onApprove={approve}
            onRetry={retryPostprocess}
            retrying={retrying}
            onReprocess={reprocess}
            onReopen={reopen}
            reprocessing={reprocessingDir === anchor.direction}
            cycleLabel={cycleLabel}
            corrections={corrections}
            onCorrectionChange={onCorrectionChange}
          />
        ))}
      </div>
    </div>
  );
}
