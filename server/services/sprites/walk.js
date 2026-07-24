/**
 * Sprites — walk-animation workflow orchestration (issue #2897, phase 3).
 *
 * Per-direction lifecycle on top of the locked reference set (#2896):
 * generate ONE grok image_to_video walk clip per direction (user-triggered,
 * cloud lane), then the completion hook runs the fully deterministic Node
 * postprocess (walkPostprocess.js) into a candidate run. The user reviews,
 * optionally loop-trims, and approves per direction; when all 8 directions
 * are approved the finalized walk-set manifest freezes the set.
 *
 * Disk layout (vendor-neutral runs/ tree; the provider is a run-record field):
 *   runs/walk-<direction>-<runId8>/animation-run.json + generated/…
 *   walk/<id>-walk-selection-v1.json, walk/<id>-walk-set-v1.json
 *   walk/trims/<slug>-vNNN-{strip.png,.gif,.json}
 *
 * Immutability: a finalized walk set 409s generation/approval/postprocess —
 * revisions require a new character version, matching the reference contract.
 */

import { join } from 'path';
import { readdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  ensureDir, atomicWrite, readJSONFile, pathExists, sha256File,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { executeTuiRun } from '../../lib/tuiPromptRunner.js';
import { GROK_TUI_ID } from '../../lib/grok.js';
import { getSettings } from '../settings.js';
import { getRecord, updateRecord } from './records.js';
import {
  spriteDir, resolveSpriteAssetPath, toRecordRelativeAssetPath, RUN_DIR_MATCH,
} from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS, anchorIdForDirection, buildWalkVideoPrompt } from './prompts.js';
import {
  prepareWalkAnchorChromaInput, runWalkPostprocess, WALK_CELL_SIZE, WALK_FPS,
  WALK_DEFAULT_FRAME_COUNT, WALK_DEFAULT_FPS,
  WALK_MIN_FRAME_COUNT, WALK_MAX_FRAME_COUNT, WALK_MIN_FPS, WALK_MAX_FPS,
  clampFrameCount, clampFps,
} from './walkPostprocess.js';
import {
  WALK_TRACK, resolveAnimationTarget, withTrackTarget, targetDrift, describeTargetSource,
} from './animationTargets.js';
import { GROK_VIDEO_DURATIONS } from '../videoGen/grok.js';

// grok's image_to_video honors only 6s/10s and clamps shorter requests to ~6s,
// so 6 is both the floor and the sensible default: a 6s clip yields plenty of
// source frames (~70) for the cycle selector, and the walk's look is tuned by
// frame count + fps, not clip length.
const WALK_DEFAULT_DURATION = 6;

// grok's walk render runs as an OBSERVABLE TUI session (issue: user wants to
// watch/course-correct grok in the Shell) rather than a headless mediaJobQueue
// spawn. The idle threshold must be long enough that grok's narration lulls
// during the multi-minute image_to_video render aren't mistaken for completion;
// the hard cap mirrors the old headless GROK_VIDEO_TIMEOUT_MS.
const WALK_TUI_IDLE_MS = 90_000;
const WALK_TUI_TIMEOUT_MS = 30 * 60_000;

const selectionRelPath = (id) => `walk/${id}-walk-selection-v1.json`;
// Exported: atlas.js (phase 4) reads the finalized walk set as compile input.
export const walkSetRelPath = (id) => `walk/${id}-walk-set-v1.json`;
// Native generations store one run per directory under a VENDOR-NEUTRAL `runs/`
// tree — the provider (grok, or a future agent service) is recorded as the run
// record's `provider` field, never encoded in the path. Migration 202 renamed
// the historical `grok/<runId>/` layout into this one; the reader still scans
// `grok/` too (RUN_SCAN_DIRS) for pre-migration installs and forks, and
// RUN_DIR_MATCH (paths.js) still accepts both prefixes.
const runRelPath = (runId) => `runs/${runId}`;
// The two on-disk homes a native candidate run can be found in: the neutral
// `runs/` layout (all new generations, post-migration) and the legacy `grok/`
// layout (a straggler on an un-migrated install/fork). Approved runs resolve
// through their selection entry regardless, so this scan only has to cover
// unapproved candidates.
const RUN_SCAN_DIRS = ['runs', 'grok'];
const RUN_RECORD_NAME = 'animation-run.json';

// Serialize walk-state read-modify-writes per record (run records, the
// selection file, the walk set, and trim versioning share one lifecycle) —
// same convention as reference.js's manifestWriteTail. Exported for
// walkTrims.js so its scan-then-write version claim can't race an attach or
// a concurrent trim.
const walkWriteTail = createKeyCachedQueue();

export const withWalkWriteTail = (recordId, fn) => walkWriteTail(recordId, fn);

async function loadWalkSet(recordId) {
  return readJSONFile(join(spriteDir(recordId), walkSetRelPath(recordId)), null);
}

// A phase-1 imported walk set (#2895) is copied verbatim from the source
// pipeline: its selectionPath is repo-root-anchored (`art-source/sprites/…`)
// and its packaged per-frame PNGs were never imported. Such a set has no
// regenerable clips behind it, so it can neither be recompiled (atlas.js) nor
// unlocked (unlockWalkSet) — both surface `LEGACY_IMPORTED_WALK_SET`. Single
// source of truth for the marker so the three call sites (here, atlas.js, and
// the client via the getWalkState flag) can't drift. The marker can sit at any
// index (absolute/repo-prefixed variants), matching the importer's own
// relToCharacterDir recognition — hence `includes`, not a prefix test.
export const isImportedWalkSet = (walkSet) => (
  typeof walkSet?.selectionPath === 'string' && walkSet.selectionPath.includes('art-source/sprites/')
);

async function loadSelection(recordId) {
  return readJSONFile(join(spriteDir(recordId), selectionRelPath(recordId)), null);
}

function seedSelection(recordId) {
  return {
    schemaVersion: 1,
    kind: 'reviewed-directional-walk-selection',
    characterId: recordId,
    status: 'in-progress',
    // Per-track cycle targets (#2985), keyed by animation track — `walk` is the
    // only member today. Seeded EMPTY and filled lazily on first resolve so a
    // selection record stays byte-identical to what an older peer expects until
    // there is an actual target to pin.
    animationTargets: {},
    directions: {},
  };
}

// Read a run record by its directory (record-relative), so `grok/<id>/` and
// the importer's `runs/<id>/` share one reader.
async function loadRunRecordAt(recordId, runDirRel) {
  return readJSONFile(join(spriteDir(recordId), runDirRel, RUN_RECORD_NAME), null);
}

async function loadRunRecord(recordId, runId) {
  // Runs the write-actions (generate/attach/rerun/approve) touch always live
  // under the neutral runs/ layout: new generations write there, and migration
  // 202 moves every legacy grok/ run there at boot before the first request.
  // So resolve runs/ only — do NOT fall back to grok/ here. A grok/ straggler
  // (un-migrated fork, or a record migration 202 skipped on a collision) is
  // still DISPLAYED via getWalkState's dual-dir scan, but a mutation would need
  // its files where the persisted runPath (runs/) and packageRun's output dir
  // point, so acting on it before migration completes returns RUN_NOT_FOUND
  // rather than silently splitting the run across two directories.
  return loadRunRecordAt(recordId, runRelPath(runId));
}

async function saveRunRecord(recordId, run) {
  const dir = join(spriteDir(recordId), runRelPath(run.id));
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
}

async function requireUnfinalized(recordId) {
  if (await loadWalkSet(recordId)) {
    throw new ServerError('Walk set is finalized — revisions require a new character version', { status: 409, code: 'WALK_SET_FINAL' });
  }
}

// PortOS stamps createdAt as an ISO string (Date.parse handles it); imported
// source-pipeline run records (issue #2895 importer) stamp it as a Python
// time.time() epoch-seconds float instead — .localeCompare on that throws
// and 500s the whole detail endpoint. Normalize both to comparable ms.
function runCreatedAtMs(createdAt) {
  if (typeof createdAt === 'number') return createdAt * 1000;
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

// A 'rendering' run's status is flipped to a terminal state by attachTuiWalkResult
// when executeTuiRun settles — including on grok's 30-min hard timeout. So a run
// still 'rendering' well past that cap can only be stranded: the server process
// died mid-render (the in-memory PTY run and its completion handler went with it).
// Present it as an error at read time — never persisted — so the UI stops polling
// forever, surfaces regenerate, and the in-flight guard in startWalkGeneration
// stops treating it as live. RENDER_STALE_MS is the hard cap plus a buffer.
const RENDER_STALE_MS = WALK_TUI_TIMEOUT_MS + 60_000;
function normalizeStaleRendering(run) {
  if (run?.status !== 'rendering') return run;
  if (Date.now() - runCreatedAtMs(run.createdAt) <= RENDER_STALE_MS) return run;
  return { ...run, status: 'error', postprocessError: 'Walk render was interrupted (server restart or timeout) — regenerate to retry.' };
}

// PortOS's own postprocess stamps `stripPreview.stripPath` record-relative
// (walkPostprocess.js). The imported source pipeline stamps the same field
// as `stripPreview.path`, anchored at ITS repo root — the importer copies
// manifests byte-for-byte (hashes are pinned and verified against the
// source, so importer.js never rewrites them), so the mismatch is fixed up
// here, in memory, at read time instead. Never written back to disk.
function normalizeStripPreview(recordId, run) {
  if (!run?.stripPreview) return run;
  const raw = run.stripPreview.stripPath ?? run.stripPreview.path;
  const stripPath = toRecordRelativeAssetPath(recordId, raw);
  if (!stripPath) return run;
  return { ...run, stripPreview: { ...run.stripPreview, stripPath } };
}

// Same fixup as normalizeStripPreview, for the OTHER repo-anchored path fields
// an imported run record carries. `postprocessManifest` names the packaged
// manifest as `art-source/sprites/<id>/runs/<run-id>/generated/…json`, and
// `sourceVideoPath` names the run's i2v clip the same way. Left raw,
// `resolveSpriteAssetPath` appends the value whole to the record dir —
// producing `data/sprites/<id>/art-source/sprites/<id>/…`, which is still
// INSIDE the record (so the traversal gate passes) but does not exist. That
// 409'd every loop-trim save on an imported record (#2978), would have failed
// approveRun the same way, and would leave an imported run's freshly-imported
// clip (#2984) unfindable. Normalizing here — the one choke point every run
// reader passes through — fixes every consumer at once. In memory only, never
// written back to the hash-pinned record.
// A path toRecordRelativeAssetPath can't re-anchor (it returns null for a
// repo-anchored path belonging to some OTHER record, e.g. pipeline provenance)
// is left untouched rather than blanked, so a genuinely foreign pointer stays
// readable instead of being rewritten into a bogus record-relative one.
const REPO_ANCHORED_RUN_FIELDS = ['postprocessManifest', 'sourceVideoPath'];

function normalizeRunAssetPaths(recordId, run) {
  let out = run;
  for (const field of REPO_ANCHORED_RUN_FIELDS) {
    const rel = out[field] && toRecordRelativeAssetPath(recordId, out[field]);
    if (rel && rel !== out[field]) out = { ...out, [field]: rel };
  }
  return out;
}

// A candidate/approved run's stripPreview names a packed strip PNG on disk. If
// that file has since gone missing — a botched migration dropped it, a manual
// cleanup nuked it — the run record still advertises the path, so the native
// render path (unlike loadRedrawRun, which returns null on a missing strip)
// hands the client a healthy-looking run and StripLoop paints a blank
// background-image with no signal that anything is wrong. That's exactly how the
// pioneer north/west strips vanished silently. Flag it at read time — never
// persisted — so the card renders an explicit "strip missing" indicator instead
// of a mystery blank, and drop the dangling stripPath so StripLoop and the trim
// button don't try to render it. A run with no stripPreview
// (rendering/postprocessing/pre-package) is untouched.
//
// Deliberately does NOT flip status to 'error': the run's status is orthogonal
// to whether its strip survived on disk. Overloading 'error' here mis-drives the
// UI — DirectionCard's error block offers "Retry postprocess", which 409s
// (WALK_SET_FINAL / RUN_APPROVED) for exactly the finalized/approved directions
// this guard most often fires on (the pioneer north/west population), and pairs a
// red error with the green "approved" badge. Keeping the status lets the client
// route recovery correctly off `stripMissing` + the direction's approved/finalized
// state (regenerate an unapproved candidate; unlock the set for a finalized one).
async function normalizeMissingStrip(recordId, run) {
  const stripPath = run?.stripPreview?.stripPath;
  if (!stripPath) return run;
  if (await pathExists(join(spriteDir(recordId), stripPath))) return run;
  const { stripPath: _dropped, ...stripPreviewRest } = run.stripPreview;
  return { ...run, stripMissing: true, stripPreview: stripPreviewRest };
}

// PortOS stamps `id` on every run record it writes; imported source-pipeline
// records don't carry one at all (see importer.test.js's fixtures). The run
// DIRECTORY is the run id under both layouts, so fall back to it. Two
// consumers break on an undefined id, which is why this isn't cosmetic:
//   - WalkWorkflow.jsx's `runs.find((r) => r.id === sel.runId)` — an imported
//     entry's `sel.runId` is ALSO undefined, so `undefined === undefined`
//     matches the first idless run in the list whatever its direction, and
//     that run gets pinned to the wrong direction's card.
//   - the `resolvedRunIds` dedup below, where every idless run collapses onto
//     the single `undefined` key.
// In-memory only, like normalizeStripPreview — never written back to disk.
function normalizeRunRecord(recordId, run, runDirRel) {
  const withId = run.id ? run : { ...run, id: runDirRel.split('/')[1] };
  return normalizeRunAssetPaths(recordId, normalizeStripPreview(recordId, withId));
}

// Strip candidates on an imported redraw manifest, in preference order. The
// clean straight-alpha derivative comes first so the preview matches native
// runs (which are always transparent); the keyed matte is the last resort
// because it renders with the chroma background baked in.
const REDRAW_STRIP_FIELDS = ['stripAlpha', 'stripAlphaOriginal', 'stripKeyed'];

/**
 * Synthesize a preview-only run object for a direction approved from an
 * imagegen **redraw** manifest (issue #2924) rather than a grok walk run.
 *
 * The source pipeline's video-first redraw path (e.g. pioneer's east, packaged
 * as `imagegen/vN/…-manifest.json` with a 12-frame cycle) predates PortOS's own
 * grok-direct walk workflow, so the selection's `runPath` points at an
 * `imagegen/` directory with no matching `grok/` run record — `getWalkState`
 * surfaced nothing and the direction rendered its "approved" badge with no
 * loop preview. Rather than model a second full run-record type, read the
 * redraw manifest's `cycle` block and shape the minimum the UI needs. Returns
 * null when the manifest isn't a redraw cycle or its strip is missing on disk,
 * so a genuinely absent run stays absent instead of rendering a broken image.
 */
async function loadRedrawRun(recordId, direction, entry) {
  const manifestRel = toRecordRelativeAssetPath(recordId, entry.runManifest);
  if (!manifestRel) return null;
  const manifest = await readJSONFile(join(spriteDir(recordId), manifestRel), null);
  const cycle = manifest?.cycle;
  const frameCount = Number(cycle?.frameCount);
  if (!Number.isInteger(frameCount) || frameCount < 2) return null;

  let stripPath = null;
  for (const field of REDRAW_STRIP_FIELDS) {
    const rel = toRecordRelativeAssetPath(recordId, cycle[field]);
    // eslint-disable-next-line no-await-in-loop -- ordered preference: stop at the first strip that exists
    if (rel && await pathExists(join(spriteDir(recordId), rel))) {
      stripPath = rel;
      break;
    }
  }
  if (!stripPath) return null;

  const cellSize = Number(manifest.cellSize) > 0 ? Number(manifest.cellSize) : WALK_CELL_SIZE;
  const fps = Number(cycle.referenceFps) > 0 ? Number(cycle.referenceFps) : WALK_FPS;
  return {
    schemaVersion: 1,
    kind: 'imported-redraw-walk-cycle',
    status: 'approved',
    // Imported entries carry no runId (it is an approveWalkDirection field),
    // so fall back to the manifest path — stable across reads and unique per
    // direction, which is all the client's list key needs.
    id: entry.runId || manifestRel,
    characterId: recordId,
    direction,
    createdAt: entry.approvedAt,
    // Deliberately NOT `postprocessManifest`: that field names a packaged grok
    // manifest (frames[] + alignment), and approve/trim resolve it as one. A
    // redraw manifest is a different schema, so it gets a distinct field.
    redrawManifest: manifestRel,
    stripPreview: {
      stripPath,
      frameCount,
      fps,
      cellWidth: cellSize,
      cellHeight: cellSize,
      row: 0,
      startColumn: 0,
    },
  };
}

/**
 * Resolve the run behind ONE selection/walk-set entry (issue #2928). The
 * entry names its own storage layout via `runPath`/`runManifest`, so this is
 * the single dispatch point every walk source routes through — adding a
 * fourth layout means another branch here, not another append-and-dedupe
 * block in `getWalkState`:
 *
 *   runs/<run-id>/  → PortOS's own generations + the importer's layout
 *   grok/<run-id>/  → legacy native generations (pre-migration-202 / forks)
 *   anything else   → an imagegen/vN redraw manifest (#2924), synthesized
 *
 * Every branch returns the same run-shaped object, so routes and the client
 * are layout-agnostic. Returns null when the entry names nothing readable.
 */
async function loadRunForEntry(recordId, direction, entry) {
  // The run directory names the layout; fall back to the manifest's own path
  // for an entry that carries only a manifest.
  const layoutPath = toRecordRelativeAssetPath(recordId, entry.runPath)
    || toRecordRelativeAssetPath(recordId, entry.runManifest);
  if (!layoutPath) return null;
  const runDirRel = RUN_DIR_MATCH.exec(layoutPath)?.[0];
  if (runDirRel) {
    const run = await loadRunRecordAt(recordId, runDirRel);
    return run ? normalizeRunRecord(recordId, run, runDirRel) : null;
  }
  return loadRedrawRun(recordId, direction, entry);
}

/**
 * The packed geometry of each direction that actually carries one, in ATLAS
 * order (SPRITE_DIRECTIONS) so "the first packaged direction" means the same
 * thing here as it does in the compiler's first-wins rule. An approved run wins
 * over a candidate for the same direction — approval is what the atlas compiles.
 *
 * Native runs stamp `frameCount`/`fps` on the run record; imported and redraw
 * runs only carry them inside `stripPreview`, so read through both or every
 * imported set would resolve as "no packaged geometry" and drift silently.
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
    return [{
      direction,
      frameCount: run.frameCount ?? run.stripPreview?.frameCount,
      fps: run.fps ?? run.stripPreview?.fps,
    }];
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
  const scanPromise = Promise.all(RUN_SCAN_DIRS.map((base) => readdir(join(spriteDir(recordId), base), { withFileTypes: true })
    .then((entries) => entries.filter((e) => e.isDirectory() && e.name.startsWith('walk-')).map((e) => ({ base, name: e.name })))
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
  )).filter(Boolean)
    // Second pass: a record whose own `id` differs from its directory name is
    // already covered by an entry that named it by id. Dedupe on id too, so a
    // run that somehow exists under both scan roots surfaces once.
    .filter((run, i, all) => !resolvedRunIds.has(run.id) && all.findIndex((r) => r.id === run.id) === i);

  const allRuns = (await Promise.all(
    [...entryRuns, ...scannedRuns]
      .map(normalizeStaleRendering)
      .map((run) => normalizeMissingStrip(recordId, run)),
  )).sort((a, b) => runCreatedAtMs(b.createdAt) - runCreatedAtMs(a.createdAt));
  // Stamp the imported flag so the client reads intent (`walkSet.imported`)
  // instead of re-deriving the source-pipeline path convention itself.
  const stampedWalkSet = walkSet ? { ...walkSet, imported: isImportedWalkSet(walkSet) } : null;
  const walkTarget = resolveWalkTargetFor({
    record: await recordPromise,
    selection,
    packagedCycles: packagedCyclesFrom(allRuns, approvedDirections),
  });
  return {
    runs: allRuns, selection, walkSet: stampedWalkSet, walkTarget,
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
function assertWalkTargetMatch(target, { frameCount, fps }, what = 'render') {
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
async function resolveRenderGeometry(recordId, { walkTarget, selection }, overrides = {}) {
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
async function pinDerivedWalkTarget(recordId, target, loadedSelection) {
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
 * Start one observable grok walk-video render for a direction whose anchor is
 * locked. User-triggered only (route-invoked); exactly one image_to_video call
 * per run — all derivatives are deterministic local work.
 *
 * grok runs as an interactive TUI session (executeTuiRun) rather than a headless
 * job so the user can pop into the Shell page to watch it, and — if needed —
 * type to course-correct or Stop it. The session id IS the run id, so the walk
 * card can deep-link to `/shell/<runId>` the moment the render starts. The
 * render itself runs OUTSIDE the per-record write tail (a ~10-min PTY run must
 * not block other walk ops); its completion re-enters the tail to attach.
 */
export function startWalkGeneration(recordId, body) {
  return walkWriteTail(recordId, () => startWalkGenerationImpl(recordId, body));
}

async function startWalkGenerationImpl(recordId, body) {
  const record = await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  const direction = body.direction;
  const manifest = await loadManifest(recordId);
  const anchor = manifest?.anchors?.find((a) => a.direction === direction);
  if (!anchor || anchor.status !== 'locked' || !anchor.path) {
    throw new ServerError(`Lock the ${anchorIdForDirection(direction)} anchor before animating it`, { status: 409, code: 'ANCHOR_NOT_LOCKED' });
  }
  const chromaKey = manifest.chromaKey;
  if (!chromaKey) {
    throw new ServerError('Reference set has no frozen chroma key', { status: 409, code: 'MAIN_NOT_LOCKED' });
  }
  // Refuse a second render for a direction already in flight. A fresh runId per
  // call is the only reservation, and the client's Generate button can briefly
  // re-enable between the media-poll eviction of its optimistic key and the next
  // getWalkState refetch — without this backstop, a click in that window fires a
  // second paid grok render for the same direction. Serialized by the write tail,
  // so no TOCTOU. getWalkState normalizes a stale 'rendering' run (server died
  // mid-render) to 'error', so this blocks only a genuinely live render.
  const { runs: inFlight, walkTarget, selection } = await getWalkState(recordId);
  if (inFlight.some((r) => r.direction === direction && (r.status === 'rendering' || r.status === 'postprocessing'))) {
    throw new ServerError(`A walk render for ${direction} is already in progress`, { status: 409, code: 'WALK_RENDER_IN_PROGRESS' });
  }
  // Cycle geometry is pinned at the SET level (#2985) — every direction in one
  // atlas must share it. An omitted count/fps adopts the target; a disagreeing
  // one is refused here rather than at atlas-compile time, eight renders later.
  const { frameCount, fps } = await resolveRenderGeometry(recordId, { walkTarget, selection }, body);
  const anchorAbs = resolveSpriteAssetPath(recordId, anchor.path);
  if (!await pathExists(anchorAbs)) {
    throw new ServerError('Locked anchor file is missing on disk', { status: 500, code: 'ANCHOR_MISSING' });
  }

  const runId = `walk-${direction}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const runAbs = join(spriteDir(recordId), runRel);
  const generatedAbs = join(runAbs, 'generated');
  await ensureDir(generatedAbs);

  // i2v motion input: the anchor composited onto the SOLID chroma matte grok
  // must animate over (NOT a transparent PNG — that made grok composite over
  // black and reinvent an off-spec magenta from the prompt text; see
  // prepareWalkAnchorChromaInput). Saved without mutating the locked anchor.
  // Overlap the input prep with the (independent) settings read.
  const inputAbs = join(generatedAbs, 'input-anchor-chroma.png');
  const [{ preparation, sha256: inputSha256 }, settings] = await Promise.all([
    prepareWalkAnchorChromaInput(anchorAbs, inputAbs, chromaKey),
    getSettings(),
  ]);
  const duration = GROK_VIDEO_DURATIONS.includes(Number(body.duration)) ? Number(body.duration) : WALK_DEFAULT_DURATION;
  // Frame count + playback fps are the deterministic-postprocess knobs, not the
  // grok clip's — grok animates the same clip regardless, and the packer
  // resamples/labels the cycle afterward. Resolved from the set target above and
  // stored on the run so the completion hook's packageRun (and any later
  // reprocess) applies exactly what the set is pinned to.
  const prompt = buildWalkVideoPrompt({ name: record.name, direction, chromaKey });
  const videoAbs = join(generatedAbs, 'source-video.mp4');
  const grokPath = settings.imageGen?.grok?.grokPath;

  // Run record BEFORE the render starts: a crash between the two leaves an inert
  // 'rendering' run (harmless, regenerable) rather than a session the attach
  // can't file. `shellSession` is the id the walk card deep-links to.
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    // Vendor recorded as metadata, not baked into the storage path — a future
    // non-grok source stamps its own provider and stores under the same runs/ tree.
    provider: GROK_TUI_ID,
    status: 'rendering',
    id: runId,
    // The TUI run id doubles as the attachable Shell session id (executeTuiRun
    // registers the PTY under this id), so the card can link to /shell/<id>.
    shellSession: runId,
    characterId: recordId,
    direction,
    chromaKey,
    duration,
    frameCount,
    fps,
    anchorPath: anchor.path,
    anchorSha256: anchor.sha256 || await sha256File(anchorAbs),
    animationInputPath: `${runRel}/generated/input-anchor-chroma.png`,
    animationInputSha256: inputSha256,
    animationInputPreparation: preparation,
    createdAt: now,
  };
  await saveRunRecord(recordId, run);

  // Fire the observable grok-tui render fire-and-forget (do NOT await — this
  // impl holds the per-record write tail, which a ~10-min render must not).
  // Completion re-enters the tail via attachTuiWalkResult; errors are captured
  // onto the run record (no request lifecycle to bubble to).
  runWalkTuiRender(recordId, {
    runId, direction, grokPath, task: buildWalkTuiTask({ prompt, inputAbs, videoAbs, duration }),
    generatedAbs, videoAbs,
  }).catch((err) => console.error(`❌ sprite walk grok-tui render crashed ${recordId}/${runId}: ${err?.message || err}`));

  console.log(`🚶 sprite walk grok-tui render started ${recordId}/${runId} (shell session ${runId})`);
  return { runId, direction, duration, shellSession: runId };
}

// The single-turn TUI task: reuse the shared motion/matte prompt, then point
// grok at the concrete input path and the exact MP4 output path. executeTuiRun
// wraps this with its "write your final response to the response file when done"
// instruction, so grok saves the MP4 first and its completion signal is the
// response file (with the long idle threshold as a backstop).
function buildWalkTuiTask({ prompt, inputAbs, videoAbs, duration }) {
  return `${prompt}\n\n`
    + `Use your built-in image_to_video tool to animate the image at this exact path for ${duration} seconds:\n${inputAbs}\n\n`
    + `Save the resulting animation as an MP4 file at exactly this path:\n${videoAbs}\n\n`
    + 'Do not create or modify any other files, and do not run any tools beyond what is needed to render and save that MP4.';
}

/**
 * Drive the observable grok-tui render to completion, then attach its result.
 * executeTuiRun spawns grok in a PTY and registers it as a Shell session under
 * `runId`; its promise resolves on success OR failure, so the attach decides
 * outcome from whether the directed MP4 actually landed on disk.
 */
async function runWalkTuiRender(recordId, { runId, direction, grokPath, task, generatedAbs, videoAbs }) {
  // args:[] is intentional — buildTuiInvocation → applyCommandDefaults routes a
  // grok command through ensureGrokTuiArgs (adds --permission-mode bypassPermissions).
  const provider = { id: GROK_TUI_ID, type: 'tui', command: grokPath || 'grok', args: [] };
  await executeTuiRun({
    runId,
    provider,
    prompt: task,
    workspacePath: generatedAbs,
    idleMs: WALK_TUI_IDLE_MS,
    timeout: WALK_TUI_TIMEOUT_MS,
    label: `sprite walk ${recordId}/${direction}`,
  }).catch((err) => {
    console.error(`❌ sprite walk grok-tui run failed ${recordId}/${runId}: ${err?.message || err}`);
  });
  await walkWriteTail(recordId, () => attachTuiWalkResult(recordId, runId, videoAbs));
}

/**
 * Attach the finished grok-tui clip and run the deterministic postprocess.
 * Guards against overwriting frozen evidence (finalized set / already-approved
 * run); the source video is already at its final path (grok wrote it there
 * directly), so there's no copy — unlike a queued-job attach.
 */
export async function attachTuiWalkResult(recordId, runId, videoAbs) {
  const run = await loadRunRecord(recordId, runId);
  if (!run) {
    console.error(`❌ sprite walk run record missing for ${recordId}/${runId} — skipping attach`);
    return;
  }
  if (await loadWalkSet(recordId)) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — walk set is finalized`);
    return;
  }
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — run is approved (immutable)`);
    return;
  }
  if (!await pathExists(videoAbs)) {
    run.status = 'error';
    run.postprocessError = 'Grok finished without writing the walk video — check the shell session output';
    run.completedAt = new Date().toISOString();
    await saveRunRecord(recordId, run);
    console.error(`❌ sprite walk grok-tui produced no video ${recordId}/${runId}`);
    return;
  }
  run.sourceVideoSha256 = await sha256File(videoAbs);
  run.status = 'postprocessing';
  await saveRunRecord(recordId, run);
  await packageRun(recordId, run);
  await saveRunRecord(recordId, run);
  console.log(`🚶 sprite walk grok-tui run ${recordId}/${runId} → ${run.status}`);
}

/**
 * Run the deterministic postprocess for a run and apply the outcome to the
 * run record (candidate on success, captured error otherwise) — shared by
 * the completion-hook attach and the manual rerun so the two can't drift.
 * The caller persists the mutated record.
 */
async function packageRun(recordId, run, overrides = {}) {
  const runRel = runRelPath(run.id);
  const runAbs = join(spriteDir(recordId), runRel);
  // Frame count + playback fps: an explicit reprocess override wins, else the
  // values stored at generate time, else the current defaults (older runs
  // predate the fields). Clamped + stamped back onto the run so the record
  // always reflects exactly what was packed and a later reprocess can reuse it.
  const frameCount = clampFrameCount(overrides.frameCount ?? run.frameCount ?? WALK_DEFAULT_FRAME_COUNT);
  const fps = clampFps(overrides.fps ?? run.fps ?? WALK_DEFAULT_FPS);
  run.frameCount = frameCount;
  run.fps = fps;
  // Record-relative path to grok's raw clip, stamped BEFORE the (possibly
  // failing) postprocess so a run that errors in packaging still surfaces the
  // video grok actually produced in the UI, not just the error text. Set here
  // (shared by attach + rerun) so a retry backfills it onto an older run too.
  run.sourceVideoPath = `${runRel}/generated/source-video.mp4`;
  try {
    const manifest = await loadManifest(recordId);
    const anchor = manifest?.anchors?.find((a) => a.direction === run.direction);
    if (!anchor?.path) throw new Error(`No locked ${run.direction} anchor in the reference manifest`);
    const result = await runWalkPostprocess({
      recordId,
      direction: run.direction,
      chromaKey: run.chromaKey || manifest.chromaKey,
      runAbs,
      runRel,
      anchorRel: anchor.path,
      anchorAbs: resolveSpriteAssetPath(recordId, anchor.path),
      videoAbs: join(runAbs, 'generated', 'source-video.mp4'),
      frameCount,
      fps,
    });
    run.status = 'candidate';
    run.postprocessManifest = result.manifestPath;
    run.stripPreview = result.stripPreview;
    delete run.postprocessError;
  } catch (err) {
    // May run outside the request lifecycle (hook) — capture, don't crash.
    run.status = 'error';
    run.postprocessError = err.message;
    console.error(`❌ sprite walk postprocess failed ${recordId}/${run.id}: ${err.message}`);
  }
  run.completedAt = new Date().toISOString();
}

/**
 * Re-run the deterministic postprocess for a run whose source video already
 * landed (crash recovery, or determinism verification). Approved/finalized
 * runs are immutable.
 */
export function rerunWalkPostprocess(recordId, { runId, frameCount, fps }) {
  return walkWriteTail(recordId, () => rerunWalkPostprocessImpl(recordId, runId, { frameCount, fps }));
}

async function rerunWalkPostprocessImpl(recordId, runId, overrides) {
  await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  const run = await loadRunRecord(recordId, runId);
  if (!run) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  // One state read serves both the immutability check and the target below.
  const { walkTarget, selection } = await getWalkState(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    throw new ServerError('Run is approved — approved runs are immutable', { status: 409, code: 'RUN_APPROVED' });
  }
  const videoAbs = join(spriteDir(recordId), runRelPath(runId), 'generated', 'source-video.mp4');
  if (!await pathExists(videoAbs)) {
    throw new ServerError('Run has no source video yet', { status: 409, code: 'VIDEO_NOT_READY' });
  }
  // Same set-level gate as generation (#2985): a reprocess is exactly how a
  // drifted direction is brought INTO line with the target, so it must land on
  // the target — not somewhere new. An omitted override adopts the target.
  const geometry = await resolveRenderGeometry(recordId, { walkTarget, selection }, overrides);
  // Reprocess the SAME on-disk clip at the pinned frame count / playback speed —
  // no grok call, no regeneration.
  await packageRun(recordId, run, geometry);
  await saveRunRecord(recordId, run);
  if (run.status === 'error') {
    throw new ServerError(`Postprocess failed: ${run.postprocessError}`, { status: 422, code: 'POSTPROCESS_FAILED' });
  }
  return run;
}

/**
 * Approve one direction's candidate run. When all 8 directions are approved
 * the finalized walk-set manifest is written and the record advances to
 * walk-complete — after which the set is immutable.
 */
export function approveWalkDirection(recordId, args) {
  return walkWriteTail(recordId, () => approveWalkDirectionImpl(recordId, args));
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
 * Legacy source-pipeline imports (#2895) are refused: their walk set was copied
 * byte-for-byte from `art-source/sprites/` with no `grok/` candidate runs behind
 * it, so unlocking would strand the record with nothing to regenerate from —
 * the same reason atlas.js refuses to recompile them (#2918).
 */
export function unlockWalkSet(recordId) {
  return walkWriteTail(recordId, () => unlockWalkSetImpl(recordId));
}

// Imported source-pipeline sets carry no regenerable clips, so unlocking or
// reopening would strand the record with nothing to regenerate from — refuse
// both through one shared message (the `verb` is the only difference). No-op for
// a native set (or no set at all).
function assertNotImportedWalkSet(walkSet, verb) {
  if (walkSet && isImportedWalkSet(walkSet)) {
    throw new ServerError(
      `This walk set was imported from the source pipeline and has no regenerable clips — ${verb} is not supported. Create a new character version to revise it.`,
      { status: 409, code: 'LEGACY_IMPORTED_WALK_SET' },
    );
  }
}

// Un-finalize: drop the canonical "finalized" signal (the walk-set file) FIRST,
// then downgrade the record status — the exact inverse of finalize's order, so a
// crash mid-unfinalize can only leave a cosmetic stale status, never a
// walk-complete record with no frozen set behind it. Shared by unlock (re-opens
// all directions) and reopen (re-opens one).
async function dropFinalizedWalkSet(recordId) {
  await rm(join(spriteDir(recordId), walkSetRelPath(recordId)), { force: true });
  await updateRecord(recordId, { status: 'reference-complete' });
}

async function unlockWalkSetImpl(recordId) {
  await requireCharacter(recordId);
  const walkSet = await loadWalkSet(recordId);
  if (!walkSet) {
    throw new ServerError('No finalized walk set to unlock', { status: 409, code: 'WALK_SET_NOT_FINAL' });
  }
  assertNotImportedWalkSet(walkSet, 'unlocking');
  await dropFinalizedWalkSet(recordId);
  // Seed a fresh (empty) selection so EVERY direction re-opens: with the walk
  // set gone each direction would still read `approved` from the old selection
  // and keep the generate/regenerate buttons gated off, so reset it. The
  // rendered runs remain on disk, so re-approval is a single click per direction.
  // The set's pinned cycle targets survive: unlocking revises the SAME set, and
  // dropping them would silently re-derive a target from whatever direction the
  // user happened to re-approve first.
  const previous = await loadSelection(recordId);
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
 * speed/frame-count with no regeneration. Imported sets have no regenerable
 * clips and are refused (mirrors unlock).
 */
export function reopenWalkDirection(recordId, { direction }) {
  return walkWriteTail(recordId, () => reopenWalkDirectionImpl(recordId, direction));
}

async function reopenWalkDirectionImpl(recordId, direction) {
  await requireCharacter(recordId);
  const walkSet = await loadWalkSet(recordId);
  assertNotImportedWalkSet(walkSet, 'reopening');
  const selection = (await loadSelection(recordId)) || seedSelection(recordId);
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
  const run = await loadRunRecord(recordId, runId);
  if (!run) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  if (run.direction !== direction) {
    throw new ServerError(`Run ${runId} animates "${run.direction}", not "${direction}"`, { status: 400, code: 'RUN_DIRECTION_MISMATCH' });
  }
  if (run.status !== 'candidate' || !run.postprocessManifest) {
    throw new ServerError('Run has no packaged candidate to approve', { status: 409, code: 'RUN_NOT_CANDIDATE' });
  }
  // Tamper check: the packaged manifest and strip must still be on disk with
  // self-consistent geometry before their approval is frozen into the selection.
  // Frame count / fps are no longer pinned to a single value (variable-frame
  // walks) — instead they must fall inside the supported authoring range and the
  // declared frameCount must match the actual packed frames. Cross-direction
  // consistency against the SET target is enforced below (#2985); atlas.js keeps
  // its own compile-time check as the backstop for imported/legacy sets.
  // `loadRunRecord` deliberately returns the RAW record (its results flow into
  // saveRunRecord elsewhere, and an imported manifest's bytes are hash-pinned to
  // the source), so re-anchor the repo-anchored path here at the point of use
  // rather than in the loader — same fixup normalizeRunRecord applies to the
  // read-only view (#2978).
  const manifestRel = toRecordRelativeAssetPath(recordId, run.postprocessManifest)
    || run.postprocessManifest;
  const manifestAbs = resolveSpriteAssetPath(recordId, manifestRel);
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
    runPath: runRelPath(runId),
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
