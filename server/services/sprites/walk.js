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
import { copyFile, readdir, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  PATHS, ensureDir, atomicWrite, readJSONFile, pathExists, sha256File,
} from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
import { getSettings } from '../settings.js';
import { updateRecord } from './records.js';
import {
  spriteDir, resolveSpriteAssetPath, toRecordRelativeAssetPath, RUN_DIR_MATCH,
} from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { SPRITE_DIRECTIONS, anchorIdForDirection, buildWalkVideoPrompt } from './prompts.js';
import {
  prepareWalkAnchorInput, runWalkPostprocess, WALK_FPS, WALK_FRAME_COUNT, WALK_CELL_SIZE,
} from './walkPostprocess.js';
import { GROK_VIDEO_DURATIONS } from '../videoGen/grok.js';

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
  return normalizeStripPreview(recordId, withId);
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
 * Walk-workflow view for the detail endpoint: every animation run (newest
 * first), the per-direction selection, and the finalized set when present.
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

  const allRuns = [...entryRuns, ...scannedRuns]
    .sort((a, b) => runCreatedAtMs(b.createdAt) - runCreatedAtMs(a.createdAt));
  // Stamp the imported flag so the client reads intent (`walkSet.imported`)
  // instead of re-deriving the source-pipeline path convention itself.
  const stampedWalkSet = walkSet ? { ...walkSet, imported: isImportedWalkSet(walkSet) } : null;
  return { runs: allRuns, selection, walkSet: stampedWalkSet };
}

/**
 * Queue one grok walk video for a direction whose anchor is locked.
 * User-triggered only (route-invoked); exactly one image_to_video call per
 * run — all derivatives are deterministic local work.
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
  const anchorAbs = resolveSpriteAssetPath(recordId, anchor.path);
  if (!await pathExists(anchorAbs)) {
    throw new ServerError('Locked anchor file is missing on disk', { status: 500, code: 'ANCHOR_MISSING' });
  }

  const runId = `walk-${direction}-${randomUUID().slice(0, 8)}`;
  const runRel = runRelPath(runId);
  const runAbs = join(spriteDir(recordId), runRel);
  const generatedAbs = join(runAbs, 'generated');
  await ensureDir(generatedAbs);

  // Transparent i2v motion input derived from the locked anchor without
  // mutating it (measured-key alpha recovery + despill).
  const inputAbs = join(generatedAbs, 'input-anchor-transparent.png');
  const { preparation, sha256: inputSha256 } = await prepareWalkAnchorInput(anchorAbs, inputAbs, chromaKey);

  const settings = await getSettings();
  const duration = GROK_VIDEO_DURATIONS.includes(Number(body.duration)) ? Number(body.duration) : GROK_VIDEO_DURATIONS[0];
  const prompt = buildWalkVideoPrompt({ name: record.name, direction, chromaKey });

  // Run record BEFORE enqueue: a crash between the two leaves an inert
  // 'queued' run (harmless, regenerable) rather than a completed job the
  // hook can't file.
  const now = new Date().toISOString();
  const run = {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    // Vendor recorded as metadata, not baked into the storage path — a future
    // non-grok source stamps its own provider and stores under the same runs/ tree.
    provider: 'grok',
    status: 'queued',
    id: runId,
    jobId: null,
    characterId: recordId,
    direction,
    chromaKey,
    anchorPath: anchor.path,
    anchorSha256: anchor.sha256 || await sha256File(anchorAbs),
    animationInputPath: `${runRel}/generated/input-anchor-transparent.png`,
    animationInputSha256: inputSha256,
    animationInputPreparation: preparation,
    createdAt: now,
  };
  await saveRunRecord(recordId, run);

  const { jobId } = enqueueJob({
    kind: 'video',
    params: {
      mode: IMAGE_GEN_MODE.GROK,
      videoMode: 'image',
      grokPath: settings.imageGen?.grok?.grokPath,
      prompt,
      sourceImagePath: inputAbs,
      duration,
      // Destination tag the completion hook files the video by.
      spriteWalk: { recordId, direction, runId, chromaKey },
    },
    owner: 'sprites',
  });
  run.jobId = jobId;
  await saveRunRecord(recordId, run);
  console.log(`🚶 sprite walk video queued ${recordId}/${runId} jobId=${jobId.slice(0, 8)}`);
  return { jobId, runId, direction, duration };
}

/**
 * Run the deterministic postprocess for a run and apply the outcome to the
 * run record (candidate on success, captured error otherwise) — shared by
 * the completion-hook attach and the manual rerun so the two can't drift.
 * The caller persists the mutated record.
 */
async function packageRun(recordId, run) {
  const runRel = runRelPath(run.id);
  const runAbs = join(spriteDir(recordId), runRel);
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
 * Completion-hook attach: copy the finished grok video into the run root and
 * run the deterministic postprocess. Errors are captured onto the run record
 * (status 'error') so the UI can surface them — the hook context has no
 * request to bubble to.
 */
export function attachWalkVideo(ctx) {
  return walkWriteTail(ctx.recordId, () => attachWalkVideoImpl(ctx));
}

async function attachWalkVideoImpl({ recordId, runId, filename, jobId }) {
  const run = await loadRunRecord(recordId, runId);
  if (!run) {
    console.error(`❌ sprite walk run record missing for ${recordId}/${runId} — skipping attach`);
    return null;
  }
  // Immutability guard, mirroring the rerun path: a Render Queue retry of a
  // terminal job re-carries the spriteWalk tag, so a clip can land AFTER the
  // run was approved (or the set finalized) — attaching would silently
  // replace frozen evidence and break the selection's recorded sha256s.
  if (await loadWalkSet(recordId)) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — walk set is finalized`);
    return null;
  }
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    console.error(`❌ sprite walk attach skipped for ${recordId}/${runId} — run is approved (immutable)`);
    return null;
  }
  const src = join(PATHS.videos, filename);
  if (!await pathExists(src)) {
    console.error(`❌ sprite walk video missing for ${recordId}/${runId} (${filename}) — skipping attach`);
    return null;
  }
  const runAbs = join(spriteDir(recordId), runRelPath(runId));
  const videoAbs = join(runAbs, 'generated', 'source-video.mp4');
  await ensureDir(join(runAbs, 'generated'));
  await copyFile(src, videoAbs);
  run.jobId = run.jobId || jobId || null;
  run.sourceVideoSha256 = await sha256File(videoAbs);
  run.status = 'postprocessing';
  await saveRunRecord(recordId, run);

  await packageRun(recordId, run);
  await saveRunRecord(recordId, run);
  return { runId, status: run.status };
}

/**
 * Re-run the deterministic postprocess for a run whose source video already
 * landed (crash recovery, or determinism verification). Approved/finalized
 * runs are immutable.
 */
export function rerunWalkPostprocess(recordId, { runId }) {
  return walkWriteTail(recordId, () => rerunWalkPostprocessImpl(recordId, runId));
}

async function rerunWalkPostprocessImpl(recordId, runId) {
  await requireCharacter(recordId);
  await requireUnfinalized(recordId);
  const run = await loadRunRecord(recordId, runId);
  if (!run) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  const selection = await loadSelection(recordId);
  if (selection?.directions?.[run.direction]?.runId === runId) {
    throw new ServerError('Run is approved — approved runs are immutable', { status: 409, code: 'RUN_APPROVED' });
  }
  const videoAbs = join(spriteDir(recordId), runRelPath(runId), 'generated', 'source-video.mp4');
  if (!await pathExists(videoAbs)) {
    throw new ServerError('Run has no source video yet', { status: 409, code: 'VIDEO_NOT_READY' });
  }
  await packageRun(recordId, run);
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

async function unlockWalkSetImpl(recordId) {
  await requireCharacter(recordId);
  const walkSet = await loadWalkSet(recordId);
  if (!walkSet) {
    throw new ServerError('No finalized walk set to unlock', { status: 409, code: 'WALK_SET_NOT_FINAL' });
  }
  if (isImportedWalkSet(walkSet)) {
    throw new ServerError(
      'This walk set was imported from the source pipeline and has no regenerable clips — unlocking is not supported. Create a new character version to revise it.',
      { status: 409, code: 'LEGACY_IMPORTED_WALK_SET' },
    );
  }
  // Order mirrors finalize's inverse: drop the canonical "finalized" signal
  // (the walk-set file) first so a crash mid-unlock can only leave a cosmetic
  // stale record status, never a walk-complete record with no frozen set.
  await rm(join(spriteDir(recordId), walkSetRelPath(recordId)), { force: true });
  // Reset the selection to in-progress: with the walk set gone `finalized` is
  // false, but each direction still reads `approved` from the selection, which
  // keeps the generate/regenerate buttons gated off. Seeding a fresh selection
  // re-opens every direction; the rendered runs remain, so re-approval is a
  // single click per direction the user is happy with. (atomicWrite ensures the
  // walk/ dir, which already exists since we just removed the walk-set file.)
  await atomicWrite(join(spriteDir(recordId), selectionRelPath(recordId)), seedSelection(recordId));
  await updateRecord(recordId, { status: 'reference-complete' });
  console.log(`🔓 sprite walk set unlocked for ${recordId}`);
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
  // the packaged geometry before their approval is frozen into the selection.
  const manifestAbs = resolveSpriteAssetPath(recordId, run.postprocessManifest);
  const packaged = await readJSONFile(manifestAbs, null);
  if (!packaged || packaged.frameCount !== WALK_FRAME_COUNT || packaged.frameRate !== WALK_FPS
    || packaged.direction !== direction || packaged.characterId !== recordId) {
    throw new ServerError('Packaged run manifest is missing or inconsistent', { status: 409, code: 'RUN_MANIFEST_INVALID' });
  }
  const stripAbs = resolveSpriteAssetPath(recordId, packaged.stripPath);
  if (!await pathExists(stripAbs) || await sha256File(stripAbs) !== packaged.stripSha256) {
    throw new ServerError('Packed strip is missing or was modified after packaging', { status: 409, code: 'RUN_STRIP_INVALID' });
  }

  const selection = (await loadSelection(recordId)) || seedSelection(recordId);
  selection.directions[direction] = {
    status: 'approved',
    runId,
    runPath: runRelPath(runId),
    runManifest: run.postprocessManifest,
    runManifestSha256: await sha256File(manifestAbs),
    approvedAt: new Date().toISOString(),
  };
  const allApproved = SPRITE_DIRECTIONS.every((d) => selection.directions[d]?.status === 'approved');
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
