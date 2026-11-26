/** Approve and freeze sprite walks, reopen them and invalidate approvals after reference revisions. */

import { join } from 'path';
import {
  ensureDir, atomicWrite, readJSONFile, pathExists, sha256File, rmGuarded,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { updateRecord } from './records.js';
import { spriteDir, resolveSpriteAssetPath, toRecordRelativeAssetPath, runDirOfPath } from './paths.js';
import {
  requireCharacter, loadManifest,
  assertReferenceAnchorUnlockable, unlockReferenceAnchor,
  assertReferenceMainUnlockable, unlockReferenceMain,
  assertReferenceTurnaroundUnlockable, unlockReferenceTurnaround,
} from './reference.js';
import { SPRITE_DIRECTIONS, anchorIdForDirection } from './prompts.js';
import { WALK_MIN_FRAME_COUNT, WALK_MAX_FRAME_COUNT, WALK_MIN_FPS, WALK_MAX_FPS } from './walkPostprocess.js';
import { WALK_TRACK } from './animationTargets.js';
import { verifyPackagedFrames } from './walkFrames.js';
import { lockedAnchorFor } from './animationWorkflow.js';
import {
  SCANNER_TRACK, sourceReferenceFor,
} from './animationTracks.js';
import { getEffectiveAnimationTracks } from './animationTrackStore.js';
import {
  invalidateTrackDirectionForAnchorRevision, invalidateTrackForTurnaroundRevision,
} from './animationTrackWorkflow.js';
import {
  selectionRelPath, walkSetRelPath, withWalkWriteTail as walkWriteTail, loadWalkSet,
  importedWalkDirections, loadSelection, seedSelection, resolveRunAt,
  resolveWalkRunById, saveRunRecordAt, entryLayoutPath, requireUnfinalized,
} from './walkRecords.js';
import { getWalkState, assertWalkTargetMatch, pinDerivedWalkTarget, resolveUnlockBlock } from './walkState.js';

/**
 * Approve one direction's candidate run. When all 8 directions are approved
 * the finalized walk-set manifest is written and the record advances to
 * walk-complete — after which the set is immutable.
 */
export function approveWalkDirection(recordId, args) {
  return withBackupAssetPublication(() => walkWriteTail(recordId, () => approveWalkDirectionImpl(recordId, args)));
}

/**
 * Unlock (un-freeze) a finalized walk set so it can be revised in place.
 *
 * The finalized walk set is normally one-way — `requireUnfinalized` 409s every
 * mutating walk op while `walk/<id>-walk-set-v1.json` exists — with "a new
 * character version" as the only escape. This gives the single user a
 * deliberate way back to the editable state (#2933 follow-up): it removes the
 * frozen walk-set file and resets the per-direction selection to in-progress,
 * so every direction returns to the generate/regenerate/approve flow with its
 * already-rendered clips preserved on disk (the `runs/<runId>/` run records are
 * never touched). Re-approving all 8 directions re-freezes the set exactly as
 * the original finalize did. The record status drops back to
 * `reference-complete` (all anchors locked, walk in progress).
 *
 * A source-pipeline import (#2895) is refused only when it genuinely has nothing
 * to re-derive from — see `assertSetReDerivable`. `acknowledgeNoClips` is the
 * caller's informed override of exactly that refusal: re-deriving is not the only
 * way back when the directional anchors are still locked, so a user who means to
 * REGENERATE the set can say so.
 */
export function unlockWalkSet(recordId, { acknowledgeNoClips = false } = {}) {
  return withBackupAssetPublication(() => walkWriteTail(recordId, () => unlockWalkSetImpl(recordId, { acknowledgeNoClips })));
}

/**
 * One refusal for "this imported set has nothing on disk to re-derive from".
 *
 * `regenerable` only extends the message with the way past it — the CODE stays
 * the same either way, following the `FORK_SYNC_REQUIRED`/`acknowledgeFork`
 * precedent in the self-update path: a code names WHAT was refused, and the
 * message names the acknowledgement that overrides it. Whether a given block is
 * overridable is carried by the stamped `walkSet.unlock.acknowledgeable` that
 * clients already read, so a second code would be an unread parallel channel for
 * a fact they have — while forking a string three call sites match on (#3043).
 */
const notReDerivable = (detail, {
  regenerable = false,
  acknowledgement = 're-open the set and regenerate each direction from its locked anchor instead (one new render each)',
} = {}) => new ServerError(
  [
    detail,
    regenerable && `Re-submit with acknowledgeNoClips to ${acknowledgement}.`,
    'Re-import this character to bring its walk clips across, or create a new character version to revise it.',
  ].filter(Boolean).join(' '),
  { status: 409, code: 'LEGACY_IMPORTED_WALK_SET' },
);

/**
 * Refuse un-finalizing an imported walk set that has nothing to re-derive from.
 *
 * The original guard refused EVERY imported set, on the stated grounds that it
 * "has no regenerable clips behind it" — true when it was written, and false
 * since #2984 taught the importer to copy each run's `source-video.mp4`. So the
 * gate now keys on the evidence the justification always named: is a clip
 * actually on disk? (#2993)
 *
 * Provenance still selects WHO gets examined, and only that: a native set is
 * never gated, exactly as before — a user who cleaned up their own rendered
 * clips must not suddenly find Unlock refused.
 *
 * The scope is what separates the two callers, and it is not cosmetic. `reopen`
 * un-approves ONE direction, so one direction's clip is the whole question.
 * `unlock` drops EVERY approval and the frozen set with them — and a
 * source-packaged direction with no clip can be neither reprocessed (nothing to
 * re-derive from) nor re-approved (its frames were never imported, so
 * RUN_FRAMES_MISSING), which means unlock must name the dropped directions before
 * it un-approves every run. A usable locked anchor permits the user to
 * acknowledge a fresh-render recovery; otherwise the refusal remains.
 */
async function assertSetReDerivable(recordId, walkSet, { acknowledgeNoClips = false } = {}) {
  // No `isImportedWalkSet` pre-check: the resolver encodes that same answer as
  // `blocked: false`, and enforcing "native sets are never gated" in two places
  // is how the two would eventually disagree.
  const { blocked, stranded, acknowledgeable } = await resolveUnlockBlock(
    recordId,
    walkSet,
    null,
    importedWalkDirections(walkSet),
  );
  if (!blocked) return;
  // Acknowledged: the caller was shown what they lose (re-derivation) and what it
  // costs them instead (a fresh render per stranded direction), and said yes.
  // Honored ONLY where `resolveUnlockBlock` proved a way back exists, so an
  // acknowledgement can never be the thing that strands a set (#3043).
  if (acknowledgeNoClips && acknowledgeable) {
    console.log(`🔓 sprite walk unlock acknowledged without re-derivable clips for ${recordId} · ${stranded.join(', ') || 'set-level import'}`);
    return;
  }
  // "no directions to examine" is the set-level-marker case: an empty or
  // already-re-anchored `directions` map behind a copied selectionPath, where
  // there is no per-direction evidence either way.
  // The "reopen them one at a time" pointer is offered only when some direction
  // actually HAS a clip — for a wholly clipless set that advice names an empty
  // list, and (since the acknowledgement landed) would be strictly worse than the
  // button beside it.
  const partial = stranded.length && stranded.length < importedWalkDirections(walkSet).length;
  const detail = stranded.length
    ? `Unlocking re-opens every direction, and ${stranded.join(', ')} would be left with no source clip to re-derive from and no packaged frames to re-approve — so ${stranded.length === 1 ? 'it' : 'they'} could not be brought back by re-deriving.${partial ? ' Reopen the directions that do have clips one at a time instead.' : ''}`
    : 'This walk set was imported from the source pipeline and carries no directions that can be re-derived here.';
  throw notReDerivable(detail, { regenerable: acknowledgeable });
}

/**
 * Reopen's one-direction use of the shared scope resolver. `walkState` is the
 * frozen set when present, otherwise the editable selection; that selection keeps
 * source-packaged entries after an earlier reopen, so later directions are still
 * protected and offered the same acknowledged regeneration escape.
 */
async function assertDirectionReDerivable(recordId, walkState, direction, { acknowledgeNoClips = false } = {}) {
  const { blocked, acknowledgeable } = await resolveUnlockBlock(
    recordId,
    walkState,
    null,
    [direction],
  );
  if (!blocked) return;
  if (acknowledgeNoClips && acknowledgeable) {
    console.log(`🔓 sprite walk reopen acknowledged without a re-derivable clip for ${recordId}/${direction}`);
    return;
  }
  throw notReDerivable(
    `The ${direction} direction is still packaged by the source pipeline and has no source clip on disk — reopening would leave nothing to re-derive from and its packaged frames were never imported.`,
    {
      regenerable: acknowledgeable,
      acknowledgement: `re-open ${direction} and regenerate it from its locked anchor instead (one new render)`,
    },
  );
}

// Un-finalize: drop the canonical "finalized" signal (the walk-set file) FIRST,
// then downgrade the record status — the exact inverse of finalize's order, so a
// crash mid-unfinalize can only leave a cosmetic stale status, never a
// walk-complete record with no frozen set behind it. Shared by unlock (re-opens
// all directions) and reopen (re-opens one).
async function dropFinalizedWalkSet(recordId, recordStatus = 'reference-complete') {
  await rmGuarded(join(spriteDir(recordId), walkSetRelPath(recordId)), { force: true });
  await updateRecord(recordId, { status: recordStatus });
}

async function unlockWalkSetImpl(recordId, { acknowledgeNoClips = false } = {}) {
  await requireCharacter(recordId);
  const walkSet = await loadWalkSet(recordId);
  if (!walkSet) {
    throw new ServerError('No finalized walk set to unlock', { status: 409, code: 'WALK_SET_NOT_FINAL' });
  }
  await assertSetReDerivable(recordId, walkSet, { acknowledgeNoClips });
  // Validate the selection before removing the intact finalized authority.
  const previous = await loadSelection(recordId);
  await dropFinalizedWalkSet(recordId);
  // Seed a fresh (empty) selection so EVERY direction re-opens: with the walk
  // set gone each direction would still read `approved` from the old selection
  // and keep the generate/regenerate buttons gated off, so reset it. The
  // rendered runs remain on disk, so re-approval is a single click per direction.
  // The set's pinned cycle targets survive: unlocking revises the SAME set, and
  // dropping them would silently re-derive a target from whatever direction the
  // user happened to re-approve first.
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(recordId)), {
    ...seedSelection(recordId),
    animationTargets: previous?.animationTargets || {},
  });
  console.log(`🔓 sprite walk set unlocked for ${recordId}`);
  return getWalkState(recordId);
}

/**
 * Re-open ONE approved direction so it returns to the generate / regenerate /
 * reprocess / approve flow — without disturbing the other directions' approvals.
 *
 * This is the finer-grained sibling of unlockWalkSet: the user notices one walk
 * is too fast (or wrong) and wants to redo just that direction. Removing a
 * direction's approval necessarily un-finalizes a frozen set (a walk set is
 * "final" only when all 8 are approved), so when a walk-set file exists we drop
 * it and downgrade the record status the same way unlock does — but we keep
 * every OTHER direction's selection entry intact, so re-freezing is a single
 * re-approval of the one direction rather than all eight. The rendered clip is
 * preserved on disk, so the reopened direction can be reprocessed at a new
 * speed/frame-count with no regeneration. A clipless source-packaged direction
 * requires an acknowledgement only when the shared resolver proves a locked
 * anchor can provide its fresh-render recovery.
 */
export function reopenWalkDirection(recordId, { direction, acknowledgeNoClips = false }) {
  return withBackupAssetPublication(() => walkWriteTail(
    recordId, () => reopenWalkDirectionImpl(recordId, direction, { acknowledgeNoClips }),
  ));
}

/**
 * Drop the approval for a walk whose conditioning anchor is being revised.
 *
 * This differs from the user's "reopen walk" action: a stale walk must be
 * discarded even when an imported run has no source clip, because the next
 * valid action is a fresh generation from the replacement anchor. The old run
 * stays on disk; only its approval pointer is removed.
 */
export function invalidateWalkDirectionForAnchorRevision(recordId, { direction }) {
  return withBackupAssetPublication(() => walkWriteTail(
    recordId, () => invalidateWalkDirectionForAnchorRevisionImpl(recordId, direction),
  ));
}

/**
 * Reopen a directional anchor and invalidate the walk conditioned on it.
 *
 * Preflight before touching the dependent selection, then remove the stale
 * approval before clearing the anchor pointer. If the reference write fails,
 * the safe partial state has no approved walk claiming a stale source; rendered
 * runs and the old locked anchor file both remain recoverable.
 */
export async function unlockDirectionalAnchor(recordId, { direction }) {
  await assertReferenceAnchorUnlockable(recordId, { direction });
  const walkInvalidated = await invalidateWalkDirectionForAnchorRevision(recordId, { direction });
  const tracksInvalidated = await invalidateAnchorDependentTracks(recordId, direction);
  const reference = await unlockReferenceAnchor(recordId, { direction });
  return { ...reference, walkInvalidated, ...tracksInvalidated };
}

/**
 * Drop every non-walk track's approval for one facing, because the anchor those
 * clips were rendered from is being reopened.
 *
 * Iterates the registry rather than naming `scanner`: a stale approved clip whose
 * source image no longer exists would let the atlas compile frames drawn from it,
 * so leaving a second anchor-seeded track out of this loop is silent bad pixels
 * in a published atlas with no error anywhere. Only anchor-seeded tracks are
 * affected — a main-seeded one has no dependency on a directional anchor.
 *
 * Returns `{ tracksInvalidated: { <trackId>: bool }, scannerInvalidated }`; the
 * scalar is kept because `ReferenceWorkflow.jsx` and the route tests read it.
 */
async function invalidateAnchorDependentTracks(recordId, direction) {
  const tracksInvalidated = {};
  for (const row of anchorSeededTracks()) {
    // ordered: each track's selection write settles before the next
    tracksInvalidated[row.id] = await invalidateTrackDirectionForAnchorRevision(row.id, recordId, { direction });
  }
  return { tracksInvalidated, scannerInvalidated: tracksInvalidated[SCANNER_TRACK] ?? false };
}

/**
 * Every non-walk track seeded from a directional anchor — the ones a reference
 * anchor revision invalidates. Walk is excluded because it owns its own
 * invalidation path above.
 */
const anchorSeededTracks = () => {
  const tracks = getEffectiveAnimationTracks();
  return Object.values(tracks)
    .filter((row) => row.id !== WALK_TRACK && sourceReferenceFor(row.id, tracks) === 'anchor');
};

/**
 * Reopen the main (south) reference and invalidate only animations conditioned
 * on it. The locked turnaround and every non-south anchor remain usable.
 */
export async function unlockMainReference(recordId) {
  await assertReferenceMainUnlockable(recordId);
  const direction = 'south';
  const walkInvalidated = await invalidateWalkDirectionForAnchorRevision(recordId, { direction });
  const tracksInvalidated = await invalidateAnchorDependentTracks(recordId, direction);
  const reference = await unlockReferenceMain(recordId);
  return { ...reference, walkInvalidated, ...tracksInvalidated };
}

/**
 * Reopen the turnaround and invalidate every approved walk descended from it.
 *
 * The reference preflight runs before any dependent state is touched. Approved
 * walks are then removed under one walk write tail before the reference layer
 * clears the turnaround, main, and anchor pointers. Old reference PNGs, clips,
 * packaged strips, and runtime atlases remain as versioned history.
 */
export async function unlockTurnaroundReference(recordId) {
  await assertReferenceTurnaroundUnlockable(recordId);
  const walkInvalidatedDirections = await invalidateWalkForTurnaroundRevision(recordId);
  // Same registry sweep as the per-anchor path, across every facing: a
  // regenerated turnaround resets the whole identity chain, so no anchor-seeded
  // track may keep an approval descended from the old sheet.
  const tracksInvalidatedDirections = {};
  for (const row of anchorSeededTracks()) {
    // ordered: each track's selection write settles before the next
    tracksInvalidatedDirections[row.id] = await invalidateTrackForTurnaroundRevision(row.id, recordId);
  }
  const reference = await unlockReferenceTurnaround(recordId);
  return {
    ...reference,
    walkInvalidatedDirections,
    tracksInvalidatedDirections,
    scannerInvalidatedDirections: tracksInvalidatedDirections[SCANNER_TRACK] ?? [],
  };
}

function invalidateWalkForTurnaroundRevision(recordId) {
  return withBackupAssetPublication(() => walkWriteTail(recordId, async () => {
    const invalidated = [];
    for (const direction of SPRITE_DIRECTIONS) {
      if (await invalidateWalkDirectionForAnchorRevisionImpl(recordId, direction)) {
        invalidated.push(direction);
      }
    }
    return invalidated;
  }));
}

async function invalidateWalkDirectionForAnchorRevisionImpl(recordId, direction) {
  await requireCharacter(recordId);
  const [walkSet, loaded] = await Promise.all([loadWalkSet(recordId), loadSelection(recordId)]);
  const approved = loaded?.directions?.[direction] || walkSet?.directions?.[direction];
  if (approved?.status !== 'approved') return false;

  const selection = loaded || {
    ...seedSelection(recordId),
    directions: { ...(walkSet?.directions || {}) },
  };
  if (walkSet) await dropFinalizedWalkSet(recordId, 'reference');
  delete selection.directions[direction];
  selection.status = 'in-progress';
  await ensureDir(join(spriteDir(recordId), 'walk'));
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(recordId)), selection);
  // Preserve the run as reviewable history, but remove its candidate status so
  // the UI and approval endpoint cannot promote an animation conditioned on
  // the superseded anchor. Redraw-manifest imports have no mutable run record;
  // once their selection pointer is gone they are no longer addressable here.
  const runDirRel = runDirOfPath(entryLayoutPath(recordId, approved));
  if (runDirRel) {
    const found = await resolveRunAt(recordId, runDirRel);
    if (found?.run?.direction === direction) {
      await saveRunRecordAt(recordId, {
        ...found.run,
        status: 'superseded-anchor',
        supersededAt: new Date().toISOString(),
        supersededReason: 'directional-anchor-revised',
      }, found.runDirRel);
    }
  }
  console.log(`♻️ sprite walk direction ${recordId}/${direction} invalidated after anchor revision`);
  return true;
}

async function reopenWalkDirectionImpl(recordId, direction, { acknowledgeNoClips = false } = {}) {
  await requireCharacter(recordId);
  const [walkSet, loaded] = await Promise.all([loadWalkSet(recordId), loadSelection(recordId)]);
  const selection = loaded || seedSelection(recordId);
  // The frozen set is canonical until the first reopen; afterwards its editable
  // selection retains the source-path entry the scope resolver reads.
  await assertDirectionReDerivable(recordId, walkSet || selection, direction, { acknowledgeNoClips });
  if (selection.directions?.[direction]?.status !== 'approved') {
    throw new ServerError(`Direction ${direction} is not approved`, { status: 409, code: 'DIRECTION_NOT_APPROVED' });
  }
  // If the set was finalized, un-finalize it FIRST (a set is "final" only when
  // all 8 are approved) — keeping every OTHER direction's approval intact, so
  // re-freezing is a single re-approval rather than all eight.
  if (walkSet) await dropFinalizedWalkSet(recordId);
  delete selection.directions[direction];
  selection.status = 'in-progress';
  await ensureDir(join(spriteDir(recordId), 'walk'));
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(recordId)), selection);
  console.log(`🔓 sprite walk direction ${recordId}/${direction} reopened`);
  return getWalkState(recordId);
}

async function approveWalkDirectionImpl(recordId, { direction, runId }) {
  await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  // Layout-aware, like the rerun above: a re-derived import stays in the run
  // directory it was imported into, and its approval must record THAT path.
  const found = await resolveWalkRunById(recordId, runId);
  if (!found) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  const { run, runDirRel } = found;
  if (run.direction !== direction) {
    throw new ServerError(`Run ${runId} animates "${run.direction}", not "${direction}"`, { status: 400, code: 'RUN_DIRECTION_MISMATCH' });
  }
  if (run.status !== 'candidate' || !run.postprocessManifest) {
    throw new ServerError('Run has no packaged candidate to approve', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  }
  // A candidate is valid only for the exact locked anchor that conditioned its
  // render. Native runs carry the anchor hash; imported legacy runs may not, so
  // retain their existing compatibility path while still requiring a current
  // locked anchor. This backstops the revision flow even if an old candidate
  // remains addressable outside the normal UI.
  const referenceManifest = await loadManifest(recordId);
  const currentAnchor = lockedAnchorFor(referenceManifest, direction);
  if (!currentAnchor) {
    throw new ServerError(`Lock the ${anchorIdForDirection(direction)} anchor before approving its walk`, { status: 409, code: 'ANCHOR_NOT_LOCKED' });
  }
  if (run.anchorSha256) {
    const currentAnchorSha256 = currentAnchor.sha256
      || await sha256File(resolveSpriteAssetPath(recordId, currentAnchor.path));
    if (run.anchorSha256 !== currentAnchorSha256) {
      throw new ServerError('This walk was rendered from an older directional anchor — generate a new walk from the current anchor', { status: 409, code: 'RUN_ANCHOR_STALE' });
    }
  }
  // Tamper check: the packaged manifest and strip must still be on disk with
  // self-consistent geometry before their approval is frozen into the selection.
  // Frame count / fps are no longer pinned to a single value (variable-frame
  // walks) — instead they must fall inside the supported authoring range and the
  // declared frameCount must match the actual packed frames. Cross-direction
  // consistency against the SET target is enforced below (#2985); atlas.js keeps
  // its own compile-time check as the backstop for imported/legacy sets.
  // `resolveRunById` deliberately returns the RAW record (its results flow into
  // saveRunRecordAt elsewhere, and an imported manifest's bytes are hash-pinned
  // to the source), so re-anchor the repo-anchored path here at the point of use
  // rather than in the loader — same fixup normalizeRunRecord applies to the
  // read-only view (#2978).
  const manifestRel = toRecordRelativeAssetPath(recordId, run.postprocessManifest)
    || run.postprocessManifest;
  const manifestAbs = resolveSpriteAssetPath(recordId, manifestRel);
  // Approval validates this immutable evidence below; it never writes back the fallback.
  const packaged = await readJSONFile(manifestAbs, null);
  const frameCountValid = Number.isInteger(packaged?.frameCount)
    && packaged.frameCount >= WALK_MIN_FRAME_COUNT && packaged.frameCount <= WALK_MAX_FRAME_COUNT
    // If the manifest carries its frames[], they must agree with the declared
    // count (deep per-frame validation happens at atlas compile). A minimal
    // manifest that omits frames[] still approves — the strip sha below is the
    // primary tamper check.
    && (!Array.isArray(packaged.frames) || packaged.frames.length === packaged.frameCount);
  const fpsValid = Number.isFinite(packaged?.frameRate)
    && packaged.frameRate >= WALK_MIN_FPS && packaged.frameRate <= WALK_MAX_FPS;
  if (!packaged || !frameCountValid || !fpsValid
    || packaged.direction !== direction || packaged.characterId !== recordId) {
    throw new ServerError('Packaged run manifest is missing or inconsistent', { status: 409, code: 'RUN_MANIFEST_INVALID' });
  }
  // An imported manifest's OWN stripPath is repo-anchored too — re-anchor before
  // resolving, or the tamper check 409s on a strip that is present and intact.
  const packagedStripRel = toRecordRelativeAssetPath(recordId, packaged.stripPath)
    || packaged.stripPath;
  const stripAbs = resolveSpriteAssetPath(recordId, packagedStripRel);
  if (!await pathExists(stripAbs) || await sha256File(stripAbs) !== packaged.stripSha256) {
    throw new ServerError('Packed strip is missing or was modified after packaging', { status: 409, code: 'RUN_STRIP_INVALID' });
  }
  // The per-frame images the manifest declares must be on disk too. Approval is
  // what freezes this direction into the set the compiler reads, and the compiler
  // verifies every frame's BYTES — so a manifest whose frames were never written
  // here (exactly the shape a source-pipeline import has: its manifest was copied,
  // its frames/ was not) would sail through the strip check above and surface at
  // compile time as an unexplained sha mismatch. Refuse it where the cause is
  // still legible, and name the remedy. This is the SAME frame-validity definition
  // the compiler uses (verifyPackagedFrames) run in its existence-only mode, so
  // the approve gate is a strict prefix of the compile gate and the two can no
  // longer disagree (#3001). A minimal manifest that declares no frames[] is
  // unchanged — the strip sha stays the primary tamper check. (#2993)
  const { total: declaredFrames, missing: missingFrames } = await verifyPackagedFrames(recordId, packaged);
  if (missingFrames) {
    throw new ServerError(
      `${missingFrames} of this run's ${declaredFrames} packaged frames are missing on disk — reprocess the direction from its source clip to re-derive them before approving.`,
      { status: 409, code: 'RUN_FRAMES_MISSING' },
    );
  }

  // Approval — not generation — is the moment a direction's geometry gets frozen
  // into the set the compiler will read, so the target has to hold HERE too. The
  // queue-time gate alone leaves a real hole: retargeting the set mid-run is a
  // sanctioned action, so a user could approve one direction at the old target,
  // retarget, then approve the rest — and only find out at atlas-compile time,
  // which is exactly the failure this issue exists to move earlier.
  const { walkTarget, selection: currentSelection } = await getWalkState(recordId);
  assertWalkTargetMatch(
    walkTarget,
    { frameCount: packaged.frameCount, fps: packaged.frameRate },
    'reprocess this direction',
  );
  await pinDerivedWalkTarget(recordId, walkTarget, currentSelection);

  const selection = (await loadSelection(recordId)) || seedSelection(recordId);
  selection.directions[direction] = {
    status: 'approved',
    runId,
    runPath: runDirRel,
    // Store the re-anchored path: the selection is PortOS-owned state (unlike the
    // hash-pinned imported manifest), and every reader already normalizes it.
    runManifest: manifestRel,
    runManifestSha256: await sha256File(manifestAbs),
    approvedAt: new Date().toISOString(),
  };
  const allApproved = SPRITE_DIRECTIONS.every((d) => selection.directions[d]?.status === 'approved');
  // Freezing is the LAST moment the set can still be fixed, so the per-direction
  // gate above is not sufficient on its own: retargeting mid-set is sanctioned,
  // so a direction approved under the OLD target stays drifted while every later
  // approval matches the new one. Without this check the 8th approval would
  // happily freeze that ragged set and hand the failure to atlas.js — the exact
  // outcome this issue moves earlier. Reuse the drift the state read already
  // computed, minus the direction being approved: its geometry was verified
  // against the target above, and `packagedCyclesFrom` may have resolved a
  // different (newer candidate) run for it, which would otherwise false-block.
  if (allApproved) {
    const drifted = walkTarget.drift.filter((d) => d.direction !== direction);
    if (drifted.length) {
      throw new ServerError(
        `Cannot finalize: ${drifted.map((d) => d.direction).join(', ')} ${drifted.length === 1 ? 'is' : 'are'} `
        + `packaged at a different cycle than the set's ${walkTarget.frameCount} frames @ ${walkTarget.fps}fps `
        + `(${walkTarget.sourceLabel}) — reopen and reprocess ${drifted.length === 1 ? 'it' : 'them'} to the target first.`,
        { status: 409, code: 'WALK_TARGET_MISMATCH' },
      );
    }
  }
  selection.status = allApproved ? 'complete' : 'in-progress';
  const selectionAbs = join(spriteDir(recordId), selectionRelPath(recordId));
  await ensureDir(join(spriteDir(recordId), 'walk'));
  await atomicWrite(selectionAbs, selection);

  if (allApproved) {
    const walkSet = {
      schemaVersion: 1,
      kind: 'finalized-eight-direction-walk-set',
      characterId: recordId,
      status: 'final',
      directionOrder: SPRITE_DIRECTIONS,
      selectionPath: selectionRelPath(recordId),
      selectionSha256: await sha256File(selectionAbs),
      directions: selection.directions,
      finalizedAt: new Date().toISOString(),
    };
    await atomicWrite(join(spriteDir(recordId), walkSetRelPath(recordId)), walkSet);
    // Walk-set before record: the walk-set file is the canonical "finalized"
    // signal (requireUnfinalized and the UI key off it), so a crash between
    // the two leaves only a cosmetic stale record status — the reverse order
    // would advertise walk-complete with no frozen set behind it.
    await updateRecord(recordId, { status: 'walk-complete' });
    console.log(`🏁 sprite walk set finalized for ${recordId}`);
  }
  console.log(`✅ sprite walk ${recordId}/${direction} approved from ${runId}`);
  return getWalkState(recordId);
}
