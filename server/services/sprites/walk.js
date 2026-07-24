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
  spriteDir, resolveSpriteAssetPath, toRecordRelativeAssetPath, altRunLayoutPath,
  runDirOfPath, resolveDriftTolerantRel, isSourcePipelinePath, SOURCE_CLIP_NAME,
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
// The two on-disk homes a run can be found in: the neutral `runs/` layout (all
// new generations, post-migration) and `grok/` — both a straggler on an
// un-migrated install/fork AND where a source-pipeline import lands whenever its
// own manifests declare that layout (migration 202 is one-shot per install, so it
// never re-runs for an import that arrives afterwards). Approved runs resolve
// through their selection entry, so the scan covers unapproved candidates plus
// any run whose entry has been dropped by an unlock/reopen.
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
// pipeline: every embedded path stays anchored at the SOURCE repo root
// (paths.js#isSourcePipelinePath) and its packaged per-frame PNGs were never
// imported.
/**
 * The directions of a walk set that are STILL packaged by the source pipeline —
 * their approved entry names the source tree, so their per-frame PNGs are not on
 * disk here and only the source pipeline could have produced them.
 *
 * This is the precise, per-direction form of "imported" (#2993). Re-deriving a
 * direction inside PortOS rewrites its entry through `approveWalkDirection`,
 * which stores record-relative paths — so a re-derived direction drops out of
 * this list and the set converges on compilable as the user works through it.
 * A blanket set-level refusal could not express that partial state.
 */
export function importedWalkDirections(walkSet) {
  return Object.entries(walkSet?.directions || {})
    .filter(([, entry]) => isSourcePipelinePath(entry?.runPath) || isSourcePipelinePath(entry?.runManifest))
    .map(([direction]) => direction);
}

// Whether a walk set carries ANY un-re-derived source-pipeline provenance:
// either the set-level selection pointer or at least one direction entry. Single
// source of truth for the marker so its call sites (atlas.js's recompile guard,
// the un-finalize evidence gate below, and the client via the getWalkState flag)
// can't drift.
export const isImportedWalkSet = (walkSet) => (
  isSourcePipelinePath(walkSet?.selectionPath) || importedWalkDirections(walkSet).length > 0
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
  // Runs PortOS itself just wrote (generate → attach) always live under the
  // neutral runs/ layout, so this straight lookup is exact for that path.
  // Callers that may act on a run PortOS did not create (rerun, approve) go
  // through `resolveRunById` instead — see there.
  return loadRunRecordAt(recordId, runRelPath(runId));
}

/**
 * Locate a run under EITHER on-disk layout, returning the record together with
 * the directory it ACTUALLY lives in.
 *
 * Migration 202 renamed pre-existing native `grok/<run-id>/` runs into the
 * neutral `runs/` tree, but it is a one-shot per install: a source-pipeline
 * import landing afterwards writes its runs wherever its own (hash-pinned)
 * manifests declare — commonly `grok/<run-id>/` — so `runs/`-only resolution
 * reports RUN_NOT_FOUND for a run that is right there on disk (#2993). Probing
 * both layouts is only half the fix; the resolved directory has to be threaded
 * into every subsequent write, which is why this returns it rather than just the
 * record. That is what keeps a re-derive from splitting one run across two
 * directories — the hazard the old `runs/`-only rule avoided by refusing outright.
 */
async function resolveRunAt(recordId, runDirRel) {
  const candidates = [runDirRel, altRunLayoutPath(runDirRel)].filter(Boolean);
  for (const rel of candidates) {
    // eslint-disable-next-line no-await-in-loop -- ordered preference: stop at the layout that exists
    const run = await loadRunRecordAt(recordId, rel);
    if (run) return { run, runDirRel: rel };
  }
  return null;
}

const resolveRunById = (recordId, runId) => resolveRunAt(recordId, runRelPath(runId));

async function saveRunRecordAt(recordId, run, runDirRel) {
  const dir = join(spriteDir(recordId), runDirRel);
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
}

const saveRunRecord = (recordId, run) => saveRunRecordAt(recordId, run, runRelPath(run.id));

// The record-relative path a selection / walk-set entry names its run by —
// `runPath` first, then the manifest it declares. An imagegen redraw entry
// resolves to a version directory rather than a run directory, which is what
// `runDirOfPath` returning null downstream distinguishes.
const entryLayoutPath = (recordId, entry) => toRecordRelativeAssetPath(recordId, entry?.runPath)
  || toRecordRelativeAssetPath(recordId, entry?.runManifest);

// The run directory a loaded run record implies, for a caller that has the
// record but not the directory it came from. Every candidate field is
// record-relative by the time a read-path consumer sees it (normalizeRunAssetPaths
// / normalizeStripPreview), and any one of them pins the run dir.
const runDirRelOf = (run) => runDirOfPath(run?.sourceVideoPath)
  || runDirOfPath(run?.postprocessManifest)
  || runDirOfPath(run?.stripPreview?.stripPath);

/**
 * The record-relative i2v clip a run can be re-derived from, or null when none
 * is on disk.
 *
 * Two candidate names, each resolved drift-tolerantly (paths.js — the declared
 * spelling or its run-layout twin): the clip the record declares, re-anchored
 * since an imported record declares it against the SOURCE repo root, then the
 * conventional `<run-dir>/generated/` name for a record that names none at all.
 * Probed together rather than in sequence — a run whose clip is genuinely gone
 * is re-checked on every poll, so the miss case must not cost a round trip per
 * candidate.
 */
async function resolveRunClipRel(recordId, run, runDirRel) {
  const dir = spriteDir(recordId);
  // Deduped: a native run's declared clip IS the conventional path, and probing
  // it twice would double the stats on the healthy majority.
  const candidates = [...new Set([
    toRecordRelativeAssetPath(recordId, run?.sourceVideoPath),
    runDirRel ? `${runDirRel}/generated/${SOURCE_CLIP_NAME}` : null,
  ].filter(Boolean))];
  const resolved = await Promise.all(candidates.map((rel) => resolveDriftTolerantRel(dir, rel)));
  return resolved.find(Boolean) || null;
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
  // A run whose packaged manifest is STILL named against the source repo was
  // packaged there, which means its per-frame images were never imported (the
  // importer skips frames/). Stamped here because this is where that fact is
  // still visible — one line up it has been re-anchored away — and it costs no
  // I/O, unlike stat-ing every frame on a read the client polls. The client gates
  // Approve on it: approving such a run 409s RUN_FRAMES_MISSING, and the flag
  // clears by itself the moment a reprocess rewrites the manifest record-relative.
  return isSourcePipelinePath(run.postprocessManifest) ? { ...out, importedPackaging: true } : out;
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
//
// Resolved drift-tolerantly, like the source clip below: an imported manifest can
// name the strip under one run layout for a file stored under the other, and both
// spellings denote the same PNG (paths.js#resolveDriftTolerantRel). Healing that
// here — rather than only for the clip — is what keeps a drifted import from
// badging "strip missing" over an intact strip, losing its loop preview, its trim
// link, and its contribution to the set's packaged geometry.
async function normalizeMissingStrip(recordId, run) {
  const stripPath = run?.stripPreview?.stripPath;
  if (!stripPath) return run;
  const found = await resolveDriftTolerantRel(spriteDir(recordId), stripPath);
  if (found === stripPath) return run;
  if (found) return { ...run, stripPreview: { ...run.stripPreview, stripPath: found } };
  const { stripPath: _dropped, ...stripPreviewRest } = run.stripPreview;
  return { ...run, stripMissing: true, stripPreview: stripPreviewRest };
}

/**
 * Fold a resolved i2v source clip onto a run, so "can this direction be
 * re-derived?" is answered by evidence rather than by whether the record happens
 * to name a clip (#2993).
 *
 * Three distinct outcomes, deliberately not collapsed: the clip is found (and
 * `sourceVideoPath` is rewritten to where it actually is, healing a layout-drift
 * mismatch for the player, the trimmer, and the re-derive); the record declares a
 * clip that is NOT on disk, or names none while its run directory has none
 * either (`sourceClipMissing: true`, the same read-time flag shape as
 * `stripMissing`); or the run is an imagegen redraw cycle, which never had an
 * i2v clip and is left untouched.
 *
 * The declared path is kept alongside the flag rather than dropped — it is the
 * record's own provenance, and consumers gate on the flag. In memory only; the
 * hash-pinned record on disk is never rewritten here.
 */
function applySourceClip(run, clipRel, runDirRel) {
  if (clipRel) return clipRel === run.sourceVideoPath ? run : { ...run, sourceVideoPath: clipRel };
  if (!runDirRel && !run?.sourceVideoPath) return run;
  return { ...run, sourceClipMissing: true };
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
  // for an entry that carries only a manifest. An entry that declares one layout
  // for a run stored under the other still resolves (`resolveRunAt`), and the
  // directory it really came from is what the record is normalized against.
  const layoutPath = entryLayoutPath(recordId, entry);
  if (!layoutPath) return null;
  const runDirRel = runDirOfPath(layoutPath);
  if (runDirRel) {
    const found = await resolveRunAt(recordId, runDirRel);
    return found ? normalizeRunRecord(recordId, found.run, found.runDirRel) : null;
  }
  return loadRedrawRun(recordId, direction, entry);
}

/**
 * The clip behind ONE approved direction, or null when that direction has
 * nothing to re-derive from — the evidence the un-finalize gate below keys on.
 */
async function directionClipRel(recordId, entry) {
  const runDirRel = runDirOfPath(entryLayoutPath(recordId, entry));
  if (!runDirRel) return null;
  const found = await resolveRunAt(recordId, runDirRel);
  return resolveRunClipRel(recordId, found?.run, found?.runDirRel || runDirRel);
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
  )).filter(Boolean)
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
  const stampedWalkSet = walkSet ? {
    ...walkSet,
    imported: isImportedWalkSet(walkSet),
    importedDirections: importedWalkDirections(walkSet),
  } : null;
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
 *
 * `location` pins WHERE the run lives and which clip to read: the attach path
 * omits it (PortOS just wrote the run under `runs/<id>/`), while a rerun that
 * resolved the run under the other layout passes both, so the regenerated frames
 * land beside the clip they came from instead of in a phantom twin directory.
 */
async function packageRun(recordId, run, overrides = {}, location = {}) {
  const runRel = location.runDirRel || runRelPath(run.id);
  const runAbs = join(spriteDir(recordId), runRel);
  // Frame count + playback fps: an explicit reprocess override wins, else the
  // values stored at generate time, else the current defaults (older runs
  // predate the fields). Clamped + stamped back onto the run so the record
  // always reflects exactly what was packed and a later reprocess can reuse it.
  const frameCount = clampFrameCount(overrides.frameCount ?? run.frameCount ?? WALK_DEFAULT_FRAME_COUNT);
  const fps = clampFps(overrides.fps ?? run.fps ?? WALK_DEFAULT_FPS);
  run.frameCount = frameCount;
  run.fps = fps;
  // Record-relative path to the raw clip, stamped BEFORE the (possibly failing)
  // postprocess so a run that errors in packaging still surfaces the video grok
  // actually produced in the UI, not just the error text. Set here (shared by
  // attach + rerun) so a retry backfills it onto an older run too — and for an
  // imported run that means persisting the record-relative form in place of the
  // source-repo anchor its manifest was copied with.
  run.sourceVideoPath = location.clipRel || `${runRel}/generated/${SOURCE_CLIP_NAME}`;
  try {
    // Inside the try on purpose: unlike the old `join(runAbs, …)` this can throw
    // (the confinement gate), and this function's contract is that a packaging
    // failure is CAPTURED onto the run record — a throw escaping here would
    // strand an attach at 'postprocessing' with no error text.
    const videoAbs = resolveSpriteAssetPath(recordId, run.sourceVideoPath);
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
      videoAbs,
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
  // Layout-aware (#2993): an imported run commonly lives under `grok/<run-id>/`,
  // and its regenerated frames + record must go back to that same directory.
  const found = await resolveRunById(recordId, runId);
  if (!found) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  const { run, runDirRel } = found;
  // One state read serves both the immutability check and the target below.
  const { walkTarget, selection } = await getWalkState(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    throw new ServerError('Run is approved — approved runs are immutable', { status: 409, code: 'RUN_APPROVED' });
  }
  const clipRel = await resolveRunClipRel(recordId, run, runDirRel);
  if (!clipRel) {
    throw new ServerError('Run has no source video yet', { status: 409, code: 'VIDEO_NOT_READY' });
  }
  // Same set-level gate as generation (#2985): a reprocess is exactly how a
  // drifted direction is brought INTO line with the target, so it must land on
  // the target — not somewhere new. An omitted override adopts the target.
  const geometry = await resolveRenderGeometry(recordId, { walkTarget, selection }, overrides);
  // An imported record carries no `id` at all; stamp the run directory's name
  // (what every reader already falls back to) so the re-derived record is
  // self-describing from here on.
  if (!run.id) run.id = runId;
  // Reprocess the SAME on-disk clip at the pinned frame count / playback speed —
  // no grok call, no regeneration.
  await packageRun(recordId, run, geometry, { runDirRel, clipRel });
  await saveRunRecordAt(recordId, run, runDirRel);
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
 * A source-pipeline import (#2895) is refused only when it genuinely has nothing
 * to re-derive from — see `assertReDerivable`.
 */
export function unlockWalkSet(recordId) {
  return walkWriteTail(recordId, () => unlockWalkSetImpl(recordId));
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

const notReDerivable = (detail) => new ServerError(
  `${detail} Re-import this character to bring its walk clips across, or create a new character version to revise it.`,
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
 * RUN_FRAMES_MISSING), which would strand that direction permanently with no way
 * back short of re-importing. So unlock requires that every still-imported
 * direction be re-derivable, and names the ones that aren't — pointing at the
 * per-direction reopen, which is safe precisely because it leaves the rest frozen.
 */
async function assertSetReDerivable(recordId, walkSet) {
  if (!isImportedWalkSet(walkSet)) return;
  const stale = importedWalkDirections(walkSet);
  // Marked imported at the SET level with no source-packaged direction to
  // examine (an empty or already-re-anchored `directions` map behind a copied
  // selectionPath): no evidence either way, so keep the blanket refusal.
  if (!stale.length) {
    throw notReDerivable('This walk set was imported from the source pipeline and carries no directions that can be re-derived here — unlocking is not supported.');
  }
  const stranded = await directionsWithoutClip(recordId, walkSet, stale);
  if (!stranded.length) return;
  throw notReDerivable(
    `Unlocking re-opens every direction, and ${stranded.join(', ')} would be left with no source clip to re-derive from and no packaged frames to re-approve — so ${stranded.length === 1 ? 'it' : 'they'} could not be brought back. Reopen the directions that do have clips one at a time instead.`,
  );
}

/**
 * Reopen's per-direction twin of the gate above.
 *
 * Keyed on the DIRECTION's own entry as well as the frozen set, because reopen
 * un-freezes: after the first one `loadWalkSet` returns null, so a gate that
 * consulted only the walk set would be dead for every reopen after it — and a
 * clipless source-packaged direction could still be stranded, two clicks in,
 * by following the advice the unlock refusal prints. The entry survives the
 * un-freeze and carries the same provenance. The set-level marker stays in the
 * OR so a copied `selectionPath` with entries that name no run at all is still
 * refused, as it was before evidence entered the picture.
 */
async function assertDirectionReDerivable(recordId, walkSet, entry, direction) {
  const imported = isSourcePipelinePath(entry?.runPath)
    || isSourcePipelinePath(entry?.runManifest)
    || isImportedWalkSet(walkSet);
  if (!imported) return;
  if (await directionClipRel(recordId, entry)) return;
  throw notReDerivable(`The ${direction} direction is still packaged by the source pipeline and has no source clip on disk — reopening is not supported, because there would be nothing to re-derive from and its packaged frames were never imported.`);
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
  await assertSetReDerivable(recordId, walkSet);
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
 * speed/frame-count with no regeneration. An imported direction is refused only
 * when its clip is genuinely absent (mirrors unlock — see `assertReDerivable`).
 */
export function reopenWalkDirection(recordId, { direction }) {
  return walkWriteTail(recordId, () => reopenWalkDirectionImpl(recordId, direction));
}

async function reopenWalkDirectionImpl(recordId, direction) {
  await requireCharacter(recordId);
  const [walkSet, loaded] = await Promise.all([loadWalkSet(recordId), loadSelection(recordId)]);
  const selection = loaded || seedSelection(recordId);
  // The selection entry is the gate's evidence, so it is read BEFORE the
  // re-derivability check (which needs it) and before the approval check.
  await assertDirectionReDerivable(recordId, walkSet, selection.directions?.[direction], direction);
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
  const found = await resolveRunById(recordId, runId);
  if (!found) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  const { run, runDirRel } = found;
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
  // `resolveRunById` deliberately returns the RAW record (its results flow into
  // saveRunRecordAt elsewhere, and an imported manifest's bytes are hash-pinned
  // to the source), so re-anchor the repo-anchored path here at the point of use
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
  // The per-frame images the manifest declares must be on disk too. Approval is
  // what freezes this direction into the set the compiler reads, and the compiler
  // verifies every frame's BYTES — so a manifest whose frames were never written
  // here (exactly the shape a source-pipeline import has: its manifest was copied,
  // its frames/ was not) would sail through the strip check above and surface at
  // compile time as an unexplained sha mismatch. Refuse it where the cause is
  // still legible, and name the remedy. A minimal manifest that declares no
  // frames[] is unchanged — the strip sha stays the primary tamper check. (#2993)
  const framePaths = (Array.isArray(packaged.frames) ? packaged.frames : [])
    .map((frame) => toRecordRelativeAssetPath(recordId, frame?.path))
    .filter(Boolean);
  const framesOnDisk = await Promise.all(framePaths
    .map((rel) => pathExists(join(spriteDir(recordId), rel))));
  const missingFrames = framesOnDisk.filter((present) => !present).length;
  if (missingFrames) {
    throw new ServerError(
      `${missingFrames} of this run's ${framePaths.length} packaged frames are missing on disk — reprocess the direction from its source clip to re-derive them before approving.`,
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
