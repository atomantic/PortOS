/** Assemble sprite walk review state and enforce the set’s cycle and reopening rules. */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { ensureDir, atomicWrite, pathExists } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getRecord } from './records.js';
import { spriteDir, resolveSpriteAssetPath, isSourcePipelinePath } from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS, anchorIdForDirection } from './prompts.js';
import { clampFrameCount, clampFps } from './walkPostprocess.js';
import {
  WALK_TRACK, resolveAnimationTarget, withTrackTarget, targetDrift, describeTargetSource,
} from './animationTargets.js';
import { resolveChromaKey, lockedAnchorFor, runCreatedAtMs } from './animationWorkflow.js';
import { normalizeStaleAnimationRun } from './localAnimationRender.js';
import {
  selectionRelPath, RUN_SCAN_DIRS, withWalkWriteTail as walkWriteTail,
  loadWalkSet, importedWalkDirections, isImportedWalkSet, loadSelection, seedSelection,
  loadRunRecordAt, isWalkRun, runDirRelOf, resolveRunClipRel, requireUnfinalized,
  normalizeMissingStrip, applySourceClip, normalizeRunRecord,
  loadRunForEntry, directionClipRel,
} from './walkRecords.js';

// A 'rendering' run's status is flipped to a terminal state by attachTuiWalkResult
// when executeTuiRun settles — including on grok's 30-min hard timeout. So a run
// still 'rendering' well past that cap can only be stranded: the server process
// died mid-render (the in-memory PTY run and its completion handler went with it).
// Present it as an error at read time — never persisted — so the UI stops polling
// forever, surfaces regenerate, and the in-flight guard in startWalkGeneration
// stops treating it as live.
const STALE_RENDER_ERROR = 'Walk render was interrupted (server restart or timeout) — regenerate to retry.';
// Both lanes' staleness rules live in one place (localAnimationRender.js) so the
// walk and non-walk tracks cannot drift on when a render counts as stranded —
// only the user-facing wording differs.
const normalizeStaleRendering = (run) => normalizeStaleAnimationRun(run, STALE_RENDER_ERROR);

/**
 * The cycle geometry ONE run was packed at.
 *
 * Native runs stamp `frameCount`/`fps` on the run record; imported and redraw
 * runs only carry them inside `stripPreview`, and older native records predate
 * the run-level fields entirely — so every reader has to look through both, and
 * they do it through here rather than each re-deriving the fallback order.
 * Absent reports as null rather than a default, so "unknown" can't masquerade as
 * "packed at the default".
 */
export const runCycleOf = (run) => ({
  frameCount: run?.frameCount ?? run?.stripPreview?.frameCount ?? null,
  fps: run?.fps ?? run?.stripPreview?.fps ?? null,
});

/**
 * The packed geometry of each direction that actually carries one, in ATLAS
 * order (SPRITE_DIRECTIONS) so "the first packaged direction" means the same
 * thing here as it does in the compiler's first-wins rule. An approved run wins
 * over a candidate for the same direction — approval is what the atlas compiles.
 *
 * A run the server flagged `stripMissing` contributes nothing: its packed strip
 * is gone from disk, so it can never compile, and letting it win the
 * first-packaged slot would derive the whole set's target from artwork that no
 * longer exists — badging every healthy direction as drifted against a dead one.
 * It is dropped AFTER the per-direction pick, not filtered out before it, so a
 * direction whose approved run lost its strip reports no geometry rather than
 * silently falling back to a superseded older candidate that will never be
 * frozen. (A stripMissing run keeps its `stripPreview`; only `stripPath` is
 * dropped, so the check has to name the flag.)
 */
function packagedCyclesFrom(runs, approvedDirections) {
  return SPRITE_DIRECTIONS.flatMap((direction) => {
    const forDirection = runs.filter((r) => r.direction === direction && r.stripPreview);
    const approvedRunId = approvedDirections?.[direction]?.runId;
    const run = forDirection.find((r) => r.id === approvedRunId)
      || forDirection.find((r) => r.status === 'approved')
      || forDirection.find((r) => r.status === 'candidate');
    if (!run || run.stripMissing) return [];
    return [{ direction, ...runCycleOf(run) }];
  });
}

/**
 * Resolve the walk track's pinned cycle target, plus the packaged directions
 * that disagree with it. Pure assembly over state the caller already loaded —
 * `getWalkState` stamps the result so the client never re-derives the precedence
 * chain (nor the provenance wording), and the queue-time guards compare against
 * it. `publishBinding.runtimeContract` is read defensively: it lands with #2982
 * and may be absent on this install, on an older peer's record, or on any record
 * with no binding at all.
 */
function resolveWalkTargetFor({ record, selection, packagedCycles }) {
  const target = resolveAnimationTarget({
    track: WALK_TRACK,
    runtimeContract: record?.publishBinding?.runtimeContract || null,
    animationTargets: selection?.animationTargets,
    packagedCycles,
  });
  const appId = record?.publishBinding?.appId || null;
  return {
    ...target,
    appId,
    // Stamped server-side rather than re-mapped in the client, so the label the
    // user reads and the 409 message they hit can never describe the same
    // target differently.
    sourceLabel: describeTargetSource(target, appId),
    drift: targetDrift(target, packagedCycles),
  };
}

/**
 * Walk-workflow view for the detail endpoint: every animation run (newest
 * first), the per-direction selection, the resolved cycle target, and the
 * finalized set when present.
 *
 * The selection (or the finalized walk set) is the index: each approved
 * direction resolves through `loadRunForEntry`, whatever layout it names.
 * The directory scan (RUN_SCAN_DIRS) then only has to cover runs that have NO
 * selection entry by definition — unapproved candidates and in-flight
 * generations, which PortOS writes under the neutral `runs/` tree.
 */
export async function getWalkState(recordId) {
  // The scan is independent of the index — start it first so the two reads
  // overlap, as they did when the scan WAS the entry point. Scan both the
  // neutral runs/ tree and the legacy grok/ tree, remembering each entry's
  // parent so the run loads from where it actually lives (a name could only
  // appear in one post-migration, but a fork/un-migrated install may still
  // have grok/).
  // Any directory, not just PortOS's own `walk-<direction>-<id8>` naming: the
  // source pipeline names its run directories freely (`run-1`, …), and those runs
  // are reachable ONLY through a selection entry — so the moment unlock or reopen
  // drops that entry (which is exactly when the user is about to re-derive them)
  // a name-prefix scan made them vanish from the workflow. A directory with no
  // `animation-run.json` loads as null and is filtered out below, so widening the
  // scan costs one absent-file read per non-run directory and admits nothing new.
  const scanPromise = Promise.all(RUN_SCAN_DIRS.map((base) => readdir(join(spriteDir(recordId), base), { withFileTypes: true })
    .then((entries) => entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => ({ base, name: e.name })))
    .catch(() => []))) // dir absent → no runs there yet
    .then((lists) => lists.flat());
  // The record read (for the publish binding's runtime contract) is independent
  // of everything below — start it here so it overlaps the run resolution
  // instead of tacking a serial round-trip onto the end of this hot read.
  const recordPromise = getRecord(recordId);
  const [selection, walkSet] = await Promise.all([loadSelection(recordId), loadWalkSet(recordId)]);

  const approvedDirections = walkSet?.directions || selection?.directions || {};
  const entryRuns = (await Promise.all(
    Object.entries(approvedDirections)
      // Gate on `approved` because loadRedrawRun stamps that status
      // unconditionally — a rejected/pending entry must not surface as an
      // approved run next to live Generate/Approve buttons. A rejected grok
      // entry still surfaces via the scan below, with its own real status.
      //
      // Deliberately NOT gated on `entry.runId`: that field is written only by
      // approveWalkDirection, so IMPORTED entries — the whole population this
      // read path exists for — never carry one (importer.test.js's walk-set
      // fixtures are runId-less). Gating on it filtered out every imported
      // direction and made the layout dispatch below unreachable for them.
      .filter(([, entry]) => entry?.status === 'approved'
        && (entry.runPath || entry.runManifest))
      .map(([direction, entry]) => loadRunForEntry(recordId, direction, entry)),
  )).filter(Boolean);
  const resolvedRunIds = new Set(entryRuns.map((run) => run.id));

  const scannedRuns = (await Promise.all(
    (await scanPromise)
      .filter(({ name }) => !resolvedRunIds.has(name))
      .map(({ base, name }) => {
        const runDirRel = `${base}/${name}`;
        return loadRunRecordAt(recordId, runDirRel)
          .then((run) => (run ? normalizeRunRecord(recordId, run, runDirRel) : null));
      }),
  )).filter((run) => run && isWalkRun(run))
    // Second pass: a record whose own `id` differs from its directory name is
    // already covered by an entry that named it by id. Dedupe on id too, so a
    // run that somehow exists under both scan roots surfaces once.
    .filter((run, i, all) => !resolvedRunIds.has(run.id) && all.findIndex((r) => r.id === run.id) === i);

  const allRuns = (await Promise.all(
    [...entryRuns, ...scannedRuns]
      .map(normalizeStaleRendering)
      // The strip and the clip are different files, so probe them CONCURRENTLY
      // and merge — chaining would add a serialized stat per run to a read the
      // client polls every few seconds while a run packages.
      .map(async (run) => {
        // Resolved from the ORIGINAL run: normalizeMissingStrip may drop a
        // dangling stripPath, which is one of the fields the run directory is
        // inferred from.
        const runDirRel = runDirRelOf(run);
        const [stripped, clip] = await Promise.all([
          normalizeMissingStrip(recordId, run),
          resolveRunClipRel(recordId, run, runDirRel),
        ]);
        return applySourceClip(stripped, clip, runDirRel);
      }),
  )).sort((a, b) => runCreatedAtMs(b.createdAt) - runCreatedAtMs(a.createdAt));
  // Stamp the imported provenance so the client reads intent instead of
  // re-deriving the source-pipeline path convention itself — and stamp the
  // per-direction LIST alongside the boolean, because that is the precise fact:
  // a direction leaves the list the moment it is re-derived here, so the client
  // can gate each card (and name the blocking directions) on the same evidence
  // the compiler will apply, not on a set-wide approximation.
  // …and stamp WHY unlock is blocked (and whether it can be acknowledged past)
  // from the same resolver the unlock gate uses, so the client can offer the
  // escape rather than re-deriving the rule — or, as before #3043, render a dead
  // "no clips to re-derive" label with no action behind it.
  // The clip evidence is handed over rather than re-resolved: `allRuns` above
  // already stat'd every approved direction's clip, and re-deriving it here would
  // put ~16-32 redundant file ops on a read the client polls every 4s. What is
  // left is a single manifest read, and only on the blocked path.
  const clipByDirection = Object.fromEntries(allRuns
    .filter((run) => resolvedRunIds.has(run.id))
    .map((run) => [run.direction, Boolean(run.sourceVideoPath) && !run.sourceClipMissing]));
  // Reopen has the same informed escape as the set-wide unlock, but its scope is
  // one approved direction. Stamp the resolver's result on that direction's run
  // so the card never recreates the import/clip rule from a second reading. When
  // the frozen set is gone, the selection retains the source-path provenance the
  // resolver needs for the still-approved directions.
  const reopenState = walkSet || selection;
  const reopenByDirection = Object.fromEntries(await Promise.all(
    Object.keys(approvedDirections).map(async (direction) => [
      direction,
      await resolveUnlockBlock(recordId, reopenState, clipByDirection, [direction]),
    ]),
  ));
  const stampedRuns = allRuns.map((run) => (
    run.direction in reopenByDirection ? { ...run, reopen: reopenByDirection[run.direction] } : run
  ));
  const stampedWalkSet = walkSet ? {
    ...walkSet,
    imported: isImportedWalkSet(walkSet),
    importedDirections: importedWalkDirections(walkSet),
    unlock: await resolveUnlockBlock(
      recordId,
      walkSet,
      clipByDirection,
      importedWalkDirections(walkSet),
    ),
  } : null;
  const walkTarget = resolveWalkTargetFor({
    record: await recordPromise,
    selection,
    packagedCycles: packagedCyclesFrom(allRuns, approvedDirections),
  });
  return {
    runs: stampedRuns, selection, walkSet: stampedWalkSet, walkTarget,
  };
}

/**
 * Refuse a render/reprocess whose cycle geometry disagrees with the set's pinned
 * target (#2985). Rejecting rather than clamping is deliberate: a silent clamp
 * hands back an artifact the user did not ask for with no explanation, and the
 * atlas would still refuse to compile later. Enforced server-side because the
 * API is directly reachable — client gating alone would not hold.
 *
 * This moves the FIRST point of detection earlier; it does not move the
 * invariant. atlas.js keeps its own compile-time checks as the backstop for
 * imported and legacy sets that never passed this gate.
 */
export function assertWalkTargetMatch(target, { frameCount, fps }, what = 'render') {
  if (frameCount === target.frameCount && fps === target.fps) return;
  throw new ServerError(
    `This walk set targets ${target.frameCount} frames @ ${target.fps}fps (${target.sourceLabel}). `
    + `Requested ${frameCount} frames @ ${fps}fps — change the set's cycle target, `
    + `or ${what} at ${target.frameCount} frames @ ${target.fps}fps.`,
    { status: 409, code: 'WALK_TARGET_MISMATCH' },
  );
}

/**
 * Resolve the geometry ONE render/reprocess will actually pack: an omitted knob
 * adopts the set target, a supplied one must agree with it, and resolving a
 * previously-implicit target records it. Shared by both queue paths so the
 * adopt/enforce/pin contract cannot drift between them.
 */
export async function resolveRenderGeometry(recordId, { walkTarget, selection }, overrides = {}) {
  const frameCount = overrides.frameCount === undefined
    ? walkTarget.frameCount : clampFrameCount(overrides.frameCount);
  const fps = overrides.fps === undefined ? walkTarget.fps : clampFps(overrides.fps);
  assertWalkTargetMatch(walkTarget, { frameCount, fps });
  await pinDerivedWalkTarget(recordId, walkTarget, selection);
  return { frameCount, fps };
}

/**
 * Write an inferred ('derived') target back onto the selection the first time a
 * write path resolves one, so the value stops being implicit — the same
 * first-approved-direction rule the compiler applies, but recorded. Deliberately
 * lazy (write-on-first-resolve from a write path, never from a read) rather than
 * an eager backfill, so a record an older peer holds stays byte-identical until
 * PortOS actually acts on it. Never persists an 'app' target: the contract is
 * the app's to change, and copying it here would strand a stale value on the
 * record when the binding moves.
 *
 * Callers must already hold the per-record write tail.
 */
export async function pinDerivedWalkTarget(recordId, target, loadedSelection) {
  if (target.source !== 'derived') return;
  // A 'derived' target means the set already HAS packaged geometry, so the walk
  // is underway even when no direction is approved yet — seed the selection
  // rather than skipping the pin and letting the target stay implicit. Callers
  // resolving the target through `getWalkState` already hold the selection;
  // reuse it rather than re-reading the same file inside the write tail.
  const selection = loadedSelection || (await loadSelection(recordId)) || seedSelection(recordId);
  const pinned = selection.animationTargets?.[WALK_TRACK];
  if (pinned?.frameCount === target.frameCount && pinned?.fps === target.fps) return;
  selection.animationTargets = withTrackTarget(selection.animationTargets, WALK_TRACK, {
    frameCount: target.frameCount, fps: target.fps, source: 'derived',
  });
  await ensureDir(join(spriteDir(recordId), 'walk'));
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(recordId)), selection);
  console.log(`📌 sprite walk target pinned for ${recordId} · ${target.frameCount}f @ ${target.fps}fps (derived)`);
}

/**
 * Pin the walk track's cycle target explicitly — a deliberate SET-level action,
 * not a per-render slider. Changing it does not mutate existing runs; it makes
 * already-packaged directions *drift*, which `getWalkState`'s `walkTarget.drift`
 * surfaces per direction so they can be re-derived from their clips.
 *
 * Refused when the bound app's `runtimeContract` pins a different frame count:
 * changing the target then means changing the binding, which is the honest
 * requirement.
 */
export function setWalkTarget(recordId, body) {
  return walkWriteTail(recordId, () => setWalkTargetImpl(recordId, body));
}

async function setWalkTargetImpl(recordId, { frameCount, fps }) {
  const record = await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  // Only the app-contract rung can REFUSE a retarget, and that rung is derived
  // from the record alone — so resolve it directly rather than paying for a full
  // getWalkState (a two-tree run scan plus every approved direction's manifest)
  // inside the write tail just to read two booleans.
  const locked = resolveAnimationTarget({
    track: WALK_TRACK,
    runtimeContract: record?.publishBinding?.runtimeContract || null,
  });
  const appId = record?.publishBinding?.appId || 'bound app';
  for (const [knob, label, requested] of [
    ['frameCount', 'Frame count', frameCount],
    ['fps', 'Playback fps', fps],
  ]) {
    if (locked[`${knob}Locked`] && locked[knob] !== requested) {
      throw new ServerError(
        `${label} is locked to ${locked[knob]} by the publish binding (${appId}) — change the binding's runtime contract to target ${requested}.`,
        { status: 409, code: 'WALK_TARGET_LOCKED' },
      );
    }
  }
  const selection = (await loadSelection(recordId)) || seedSelection(recordId);
  // `withTrackTarget` merges rather than replaces so a sibling track key written
  // by a newer PortOS (or a peer) round-trips untouched.
  selection.animationTargets = withTrackTarget(selection.animationTargets, WALK_TRACK, {
    frameCount, fps, source: 'set',
  });
  await ensureDir(join(spriteDir(recordId), 'walk'));
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(recordId)), selection);
  console.log(`🎯 sprite walk target set for ${recordId} · ${frameCount}f @ ${fps}fps`);
  return getWalkState(recordId);
}

/**
 * Whether a fresh walk render is possible for ONE direction: its anchor must be
 * locked, and the set must carry the frozen chroma key the i2v input is
 * composited onto.
 *
 * Shared by the render path (which throws `error` and then uses `anchor`/
 * `chromaKey`) and the un-finalize gate's regenerability probe (which only reads
 * whether there IS an error). That sharing is load-bearing, not tidiness: the
 * gate tells the user "every direction can be regenerated" and then drops all
 * eight approvals on the strength of it, so a predicate that checked less than
 * the render actually requires would walk them into exactly the dead end the
 * acknowledgement promises can't happen (#3043). `error` is a factory so the
 * probe never builds a ServerError it discards.
 *
 * The chroma key falls back `manifest → record`, which is the resolution order
 * the rest of the sprite code already uses (reference.js resolves it that way at
 * eight sites). Reading `manifest.chromaKey` alone made every SOURCE-PIPELINE
 * IMPORT unrenderable: the importer stamps the key it used on the record and the
 * imported manifest carries none, so a fully-locked imported set reported "no
 * frozen chroma key" and refused every Generate. Absent on BOTH is still the
 * genuine "main was never locked" refusal.
 *
 * Deliberately I/O-free: the on-disk anchor probe (`ANCHOR_MISSING`) stays in the
 * render path, since this runs per-direction from a read.
 */
export function resolveWalkRenderability(manifest, record, direction) {
  const anchor = lockedAnchorFor(manifest, direction);
  if (!anchor) {
    return {
      anchor: null,
      chromaKey: null,
      error: () => new ServerError(`Lock the ${anchorIdForDirection(direction)} anchor before animating it`, { status: 409, code: 'ANCHOR_NOT_LOCKED' }),
    };
  }
  const chromaKey = resolveChromaKey({ manifest, record });
  if (!chromaKey) {
    return {
      anchor,
      chromaKey: null,
      error: () => new ServerError('Reference set has no frozen chroma key', { status: 409, code: 'MAIN_NOT_LOCKED' }),
    };
  }
  return { anchor, chromaKey, error: null };
}

/**
 * The directions among `scope` that have no clip on disk to re-derive from.
 * Bounded at eight, so fan out rather than walking them serially — the path that
 * examines every direction is the refusal path.
 */
async function directionsWithoutClip(recordId, walkSet, scope) {
  const clips = await Promise.all(scope
    .map((direction) => directionClipRel(recordId, walkSet.directions?.[direction])));
  return scope.filter((_, i) => !clips[i]);
}

/**
 * Which of `scope` has no clip to re-derive from, using a caller's pre-resolved
 * clip map where it covers a direction and probing disk where it doesn't.
 *
 * The partition is the whole point. `getWalkState` builds its map from the runs
 * it resolved, and it only resolves entries whose status is `approved` — while
 * `importedWalkDirections` filters on provenance alone and so includes entries
 * in any state. So a direction can be legitimately absent from the map, and
 * reading absent as "proven to have no clip" is the repo's own absent-vs-empty
 * conflation: a `pending` source-anchored entry whose clip is sitting on disk
 * would be reported stranded, and the client would either quote the user eight
 * needless renders or (with an unlocked anchor anywhere) hide the unlock
 * entirely — re-creating, through a different door, the dead end #3043 removes.
 * `in` distinguishes resolved-false from unresolved; the probe answers the rest.
 */
async function strandedDirections(recordId, walkSet, scope, clipByDirection) {
  if (!clipByDirection) return directionsWithoutClip(recordId, walkSet, scope);
  const unresolved = scope.filter((direction) => !(direction in clipByDirection));
  const probed = new Set(unresolved.length
    ? await directionsWithoutClip(recordId, walkSet, unresolved)
    : []);
  // Filtered over `scope` rather than concatenated, so the reported order stays
  // the walk set's own — it is read aloud in the refusal message.
  return scope.filter((direction) => (direction in clipByDirection
    ? !clipByDirection[direction]
    : probed.has(direction)));
}

/**
 * Why a walk re-open action is (or is not) blocked for a scope, and whether that
 * block can be acknowledged past. Set-wide unlock passes every imported
 * direction; per-direction reopen passes one direction. One resolver for both
 * gates and the reads clients render, so the button they offer and the 409 they
 * might hit are computed from the same evidence rather than two copies of the
 * rule.
 *
 * `blocked` is its own field rather than something a reader infers from
 * `stranded`: the evidence-free set-level-marker case IS blocked and strands an
 * EMPTY list, so `stranded.length` would read that as "fine" — the exact
 * empty-vs-absent conflation the repo's sentinel rule exists to prevent.
 * `acknowledgeable` says whether regeneration is a real way back, resolved
 * through the render path's own precondition (`resolveWalkRenderability`).
 *
 * `clipByDirection` lets a caller that has ALREADY resolved every approved
 * direction's clip hand that evidence over instead of paying for it twice —
 * `getWalkState` stamps this field and had just done exactly that work. Omit it
 * and the clips are resolved here, which is what the write path does.
 *
 * Returns a fresh object per call: this value is stamped onto a walk-state
 * response, so a hoisted shared constant would be one downstream mutation away
 * from poisoning every later response process-wide.
 */

export async function resolveUnlockBlock(
  recordId,
  walkSet,
  clipByDirection = null,
  scope = importedWalkDirections(walkSet),
) {
  const notBlocked = { blocked: false, stranded: [], acknowledgeable: false };
  const imported = importedWalkDirections(walkSet);
  // A source selection pointer with no source-packaged entry is the legacy
  // evidence-free import shape. It is set-level for unlock (all eight directions
  // must be renderable) and one-direction for reopen; once any explicit source
  // entry exists, a native direction in the same mixed set is not blocked by a
  // different direction's provenance.
  const stale = scope.filter((direction) => imported.includes(direction));
  const setLevelImport = isSourcePipelinePath(walkSet?.selectionPath);
  if (!stale.length && (!setLevelImport || imported.length)) return notBlocked;
  // `resolveWalkRenderability` is deliberately I/O-free, so it checks the
  // manifest's CLAIM that an anchor is locked but not that the file is still
  // there — and the render path's own `ANCHOR_MISSING` probe does. A manifest
  // that still marks a since-deleted anchor locked would therefore pass the
  // gate, drop all eight approvals on the acknowledged unlock, and then fail
  // every Generate — precisely the stranding the acknowledgement promises can't
  // happen. So the promise is only made after probing the files too. Bounded at
  // eight stats, and only on the blocked path.
  const regenerable = async (scope) => {
    const [manifest, record] = await Promise.all([loadManifest(recordId), getRecord(recordId)]);
    const resolved = scope.map((direction) => resolveWalkRenderability(manifest, record, direction));
    if (resolved.some((r) => r.error)) return false;
    const present = await Promise.all(resolved
      .map((r) => pathExists(resolveSpriteAssetPath(recordId, r.anchor.path))));
    return present.every(Boolean);
  };
  // No per-direction evidence to examine: unlock re-opens the whole set, while a
  // reopen has already supplied its one-direction scope. Each action only promises
  // regeneration for exactly what it will re-open.
  if (!stale.length) {
    const regenerationScope = scope.length ? scope : SPRITE_DIRECTIONS;
    return { blocked: true, stranded: [], acknowledgeable: await regenerable(regenerationScope) };
  }
  const stranded = await strandedDirections(recordId, walkSet, stale, clipByDirection);
  if (!stranded.length) return notBlocked;
  return { blocked: true, stranded, acknowledgeable: await regenerable(stranded) };
}
