/** Read, normalize and persist sprite walk run, selection and set records. */

import { emitSpriteChanged } from './events.js';
import { join } from 'path';
import { stat } from 'fs/promises';
import { ensureDir, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  spriteDir, toRecordRelativeAssetPath, altRunLayoutPath, runDirOfPath, resolveDriftTolerantRel,
  isSourcePipelinePath, SOURCE_CLIP_NAME, runRelPath, RUN_RECORD_NAME,
} from './paths.js';
import { WALK_CELL_SIZE, WALK_FPS } from './walkPostprocess.js';
import { WALK_TRACK } from './animationTargets.js';
import { withAnimationWriteTail } from './animationWorkflow.js';

export const selectionRelPath = (id) => `walk/${id}-walk-selection-v1.json`;
// Exported: atlas.js (phase 4) reads the finalized walk set as compile input.
export const walkSetRelPath = (id) => `walk/${id}-walk-set-v1.json`;
// Native generations store one run per directory under a VENDOR-NEUTRAL `runs/`
// tree — the provider (grok, or a future agent service) is recorded as the run
// record's `provider` field, never encoded in the path. Migration 202 renamed
// the historical `grok/<runId>/` layout into this one; the reader still scans
// `grok/` too (RUN_SCAN_DIRS) for pre-migration installs and forks, and
// RUN_DIR_MATCH (paths.js) still accepts both prefixes.
// The two on-disk homes a run can be found in: the neutral `runs/` layout (all
// new generations, post-migration) and `grok/` — both a straggler on an
// un-migrated install/fork AND where a source-pipeline import lands whenever its
// own manifests declare that layout (migration 202 is one-shot per install, so it
// never re-runs for an import that arrives afterwards). Approved runs resolve
// through their selection entry, so the scan covers unapproved candidates plus
// any run whose entry has been dropped by an unlock/reopen.
export const RUN_SCAN_DIRS = ['runs', 'grok'];

// Serialize walk-state read-modify-writes per record (run records, the
// selection file, the walk set, and trim versioning share one lifecycle) —
// same convention as reference.js's manifestWriteTail. Exported for
// walkTrims.js so its scan-then-write version claim can't race an attach or
// a concurrent trim.
const walkWriteTail = (recordId, fn) => withAnimationWriteTail(recordId, fn);
export const withWalkWriteTail = walkWriteTail;

export async function loadWalkSet(recordId) {
  return readJSONFile(join(spriteDir(recordId), walkSetRelPath(recordId)), null, { strict: true });
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

export async function loadSelection(recordId) {
  return readJSONFile(join(spriteDir(recordId), selectionRelPath(recordId)), null, { strict: true });
}

export function seedSelection(recordId) {
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
export async function loadRunRecordAt(recordId, runDirRel) {
  return readJSONFile(join(spriteDir(recordId), runDirRel, RUN_RECORD_NAME), null, { strict: true });
}

export async function loadRunRecord(recordId, runId) {
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
export async function resolveRunAt(recordId, runDirRel) {
  const candidates = [runDirRel, altRunLayoutPath(runDirRel)].filter(Boolean);
  for (const rel of candidates) {
    // ordered preference: stop at the layout that exists
    const run = await loadRunRecordAt(recordId, rel);
    if (run) return { run, runDirRel: rel };
  }
  return null;
}

const resolveRunById = (recordId, runId) => resolveRunAt(recordId, runRelPath(runId));

// The shared `runs/` tree now holds named tracks as well as walk. Legacy walk
// records predate the field, so an absent track remains walk-compatible; a
// declared non-walk track must never surface through, or be mutated by, the
// walk endpoints.
export const isWalkRun = (run) => !run?.track || run.track === WALK_TRACK;
export async function resolveWalkRunById(recordId, runId) {
  const found = await resolveRunById(recordId, runId);
  return isWalkRun(found?.run) ? found : null;
}

export async function saveRunRecordAt(recordId, run, runDirRel) {
  const dir = join(spriteDir(recordId), runDirRel);
  await ensureDir(dir);
  await atomicWrite(join(dir, RUN_RECORD_NAME), run);
  emitSpriteChanged(recordId);
}

export const saveRunRecord = (recordId, run) => saveRunRecordAt(recordId, run, runRelPath(run.id));

// The record-relative path a selection / walk-set entry names its run by —
// `runPath` first, then the manifest it declares. An imagegen redraw entry
// resolves to a version directory rather than a run directory, which is what
// `runDirOfPath` returning null downstream distinguishes.
export const entryLayoutPath = (recordId, entry) => toRecordRelativeAssetPath(recordId, entry?.runPath)
  || toRecordRelativeAssetPath(recordId, entry?.runManifest);

// The run directory a loaded run record implies, for a caller that has the
// record but not the directory it came from. Every candidate field is
// record-relative by the time a read-path consumer sees it (normalizeRunAssetPaths
// / normalizeStripPreview), and any one of them pins the run dir.
export const runDirRelOf = (run) => runDirOfPath(run?.sourceVideoPath)
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
export async function resolveRunClipRel(recordId, run, runDirRel) {
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

// What a frozen set says when a mutating op reaches it. A factory rather than a
// literal because two paths raise it: this guard, and the shared re-derive gate
// below (which resolves the frozen set from state it already loaded rather than
// re-reading the file). One producer, so the two can't drift apart.
export const walkSetFinalError = () => new ServerError('Walk set is finalized — revisions require a new character version', { status: 409, code: 'WALK_SET_FINAL' });

export async function requireUnfinalized(recordId) {
  if (await loadWalkSet(recordId)) throw walkSetFinalError();
}

// PortOS's own postprocess stamps `stripPreview.stripPath` record-relative
// (walkPostprocess.js). The imported source pipeline stamps the same field
// as `stripPreview.path`, anchored at ITS repo root — the importer copies
// manifests byte-for-byte (hashes are pinned and verified against the
// source, so importer.js never rewrites them), so the mismatch is fixed up
// here, in memory, at read time instead. Never written back to disk.
function normalizeStripPreview(recordId, run) {
  if (!run?.stripPreview) return run;
  const patch = {};

  const raw = run.stripPreview.stripPath ?? run.stripPreview.path;
  const stripPath = toRecordRelativeAssetPath(recordId, raw);
  if (stripPath) patch.stripPath = stripPath;

  // Collapse the strip's cache-busting token to ONE field the client reads
  // (#3020). The packer rewrites a strip in place at a stable path, so the URL
  // needs a token that changes with the bytes — but the two run flavors can
  // afford different tokens: a native run persists the real content hash, while
  // a synthesized redraw run has no hash in its manifest and sets `stripVersion`
  // itself from an mtime-size stat. Deriving the native case HERE — the one
  // choke point every run reader passes through — means the client never learns
  // that difference, and a strip consumer cannot silently paint a stale image by
  // forgetting to apply the precedence rule by hand. (That is not hypothetical:
  // the first cut of this fix resolved it client-side and the Loop Trimmer read
  // a flattened object that never carried either field, so its half was inert.)
  //
  // Truncated to 12 chars because a sha256 is 64 and only needs to be unique
  // across one file's own history; `stripVersion` is set verbatim by its
  // producer, since a composite token can't be cut without losing a component.
  if (!run.stripPreview.stripVersion && typeof run.stripPreview.stripSha256 === 'string' && run.stripPreview.stripSha256) {
    patch.stripVersion = run.stripPreview.stripSha256.slice(0, 12);
  }

  if (!Object.keys(patch).length) return run;
  return { ...run, stripPreview: { ...run.stripPreview, ...patch } };
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
export async function normalizeMissingStrip(recordId, run) {
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
export function applySourceClip(run, clipRel, runDirRel) {
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
export function normalizeRunRecord(recordId, run, runDirRel) {
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
  // Read-only redraw projection; this fallback never enters a manifest write.
  const manifest = await readJSONFile(join(spriteDir(recordId), manifestRel), null);
  const cycle = manifest?.cycle;
  const frameCount = Number(cycle?.frameCount);
  if (!Number.isInteger(frameCount) || frameCount < 2) return null;

  // `stat` answers BOTH questions in one syscall — does the strip exist, and
  // what is its cache-busting token (#3020) — so this deliberately stats rather
  // than calling pathExists and then stat-ing the winner again. A redraw
  // manifest carries no strip hash, and this is a READ path (it runs on every
  // walk-state load, per direction), so hashing a multi-MB PNG here would be a
  // real per-request cost; mtime+size is the cheap stand-in that still changes
  // whenever a re-import rewrites the strip at its stable path. Size matters
  // alongside mtime because mtime resolution can be too coarse to catch a fast
  // rewrite — which is also why this token must never be truncated.
  let stripPath = null;
  let stripStat = null;
  for (const field of REDRAW_STRIP_FIELDS) {
    const rel = toRecordRelativeAssetPath(recordId, cycle[field]);
    // ordered preference: stop at the first strip that exists
    const found = rel && await stat(join(spriteDir(recordId), rel)).catch(() => null);
    if (found) {
      stripPath = rel;
      stripStat = found;
      break;
    }
  }
  if (!stripPath) return null;
  const stripVersion = `${Math.round(stripStat.mtimeMs)}-${stripStat.size}`;

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
    // …which is also why the flag `normalizeRunAssetPaths` stamps off
    // `postprocessManifest` has to be set explicitly here: a synthesized redraw
    // run never passes through that normalizer, so without this it reads as
    // PortOS-owned once the frozen walk set is gone, and the client would offer a
    // Reopen the server refuses (a redraw entry names no run dir, so it has no
    // clip to re-derive from — this is the pioneer `east` shape).
    ...(isSourcePipelinePath(entry.runManifest) || isSourcePipelinePath(entry.runPath)
      ? { importedPackaging: true } : {}),
    stripPreview: {
      stripPath,
      stripVersion,
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
export async function loadRunForEntry(recordId, direction, entry) {
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
export async function directionClipRel(recordId, entry) {
  const runDirRel = runDirOfPath(entryLayoutPath(recordId, entry));
  if (!runDirRel) return null;
  const found = await resolveRunAt(recordId, runDirRel);
  return resolveRunClipRel(recordId, found?.run, found?.runDirRel || runDirRel);
}
