/** Package sprite walk clips and report raw frame and packed cycle provenance. */

import { join } from 'path';
import { readdir } from 'fs/promises';
import { readJSONFile, sha256File } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getRecord } from './records.js';
import { spriteDir, resolveSpriteAssetPath, SOURCE_CLIP_NAME, rawFramesRelOf, RAW_FRAME_NAME, runRelPath } from './paths.js';
import { requireCharacter, loadManifest } from './reference.js';
import { runWalkPostprocess, extractVideoFrames, WALK_FPS, MAX_SOURCE_SECONDS, WALK_DEFAULT_FRAME_COUNT, WALK_DEFAULT_FPS, clampFrameCount, clampFps } from './walkPostprocess.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { resolveChromaKey } from './animationWorkflow.js';
import {
  withWalkWriteTail as walkWriteTail, resolveWalkRunById, saveRunRecordAt,
  resolveRunClipRel, walkSetFinalError, normalizeRunRecord,
} from './walkRecords.js';
import { runCycleOf, getWalkState, resolveRenderGeometry } from './walkState.js';

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
export async function packageRun(recordId, run, overrides = {}, location = {}) {
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
  // postprocess so a run that errors in packaging still surfaces the video the
  // provider actually produced in the UI, not just the error text. Set here (shared by
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
    // What the provider DELIVERED, as opposed to what `run.duration` asked for —
    // the requested length is not a promise on either lane (grok picks from its
    // own menu, see lib/grokVideoClip.js; H3 snaps to its 17n+5 grid). Stamped
    // here, shared by attach + rerun, so a reprocess backfills it onto an older
    // run. Overlap the probe with the (independent) manifest read.
    //
    // probeVideoDuration returns null when ffprobe is missing or the file has no
    // parseable duration; leave the field ABSENT in that case rather than
    // stamping 0, so "unknown" never reads as "a zero-length clip". A previously
    // stamped value survives — a probe that can't run is not evidence of change.
    const [probedSeconds, manifest, record] = await Promise.all([
      probeVideoDuration(videoAbs),
      loadManifest(recordId),
      getRecord(recordId),
    ]);
    if (probedSeconds) run.sourceVideoSeconds = Math.round(probedSeconds * 100) / 100;
    const anchor = manifest?.anchors?.find((a) => a.direction === run.direction);
    if (!anchor?.path) throw new Error(`No locked ${run.direction} anchor in the reference manifest`);
    // Refuse HERE rather than letting an absent key reach the un-key step, which
    // reported it as `Invalid hex color: undefined` — a parser's complaint about
    // its argument, naming neither the field nor the record that lacks it.
    const chromaKey = resolveChromaKey({ manifest, record, run });
    if (!chromaKey) {
      throw new Error(`No chroma key for ${recordId} — the run, the reference manifest, and the record all lack one, so the matte cannot be keyed out`);
    }
    const result = await runWalkPostprocess({
      recordId,
      direction: run.direction,
      chromaKey,
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
 * Why this run's cycle cannot be re-derived from its clip right now, or null
 * when it can — stated ONCE, in the order the write path applies the refusals.
 *
 * Both sides read it: `rerunWalkPostprocessImpl` throws the matching error, and
 * `getWalkSourceFrames` reports it as `lockReason` so the Loop Trimmer can offer
 * the unlock/reopen that clears it instead of a re-derive that would 409. A read
 * path with its own copy of this rule is precisely how the two would drift —
 * #2993 already moved the underlying question from provenance ("is this an
 * import?") to evidence ("is the clip actually on disk?"), and a second
 * definition would strand one of them on the old answer.
 *
 * A frozen set outranks an approved direction because the set gate is the
 * coarser one; a missing clip is last because it is the one state the user
 * cannot unlock their way out of.
 */
function reDeriveLockReason({
  walkSet, selection, run, runId, clipRel,
}) {
  if (walkSet) return 'finalized';
  if (selection?.directions?.[run.direction]?.runId === runId) return 'approved';
  if (!clipRel) return 'no-source-video';
  return null;
}

const RE_DERIVE_REFUSALS = {
  finalized: walkSetFinalError,
  approved: () => new ServerError('Run is approved — approved runs are immutable', { status: 409, code: 'RUN_APPROVED' }),
  'no-source-video': () => new ServerError('Run has no source video yet', { status: 409, code: 'VIDEO_NOT_READY' }),
};

/**
 * Re-run the deterministic postprocess for a run whose source video already
 * landed — crash recovery, determinism verification, or (the common case since
 * #2985/#2980) bringing a direction onto the set's cycle target from the clip
 * already on disk. Approved/finalized runs are immutable.
 */
export function rerunWalkPostprocess(recordId, { runId, frameCount, fps }) {
  return walkWriteTail(recordId, () => rerunWalkPostprocessImpl(recordId, runId, { frameCount, fps }));
}

async function rerunWalkPostprocessImpl(recordId, runId, overrides) {
  await requireCharacter(recordId);
  // Layout-aware (#2993): an imported run commonly lives under `grok/<run-id>/`,
  // and its regenerated frames + record must go back to that same directory.
  const found = await resolveWalkRunById(recordId, runId);
  if (!found) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
  const { run, runDirRel } = found;
  // One state read serves the re-derive gate and the target below.
  const { walkTarget, selection, walkSet } = await getWalkState(recordId);
  const clipRel = await resolveRunClipRel(recordId, run, runDirRel);
  const refusal = reDeriveLockReason({
    walkSet, selection, run, runId, clipRel,
  });
  if (refusal) throw RE_DERIVE_REFUSALS[refusal]();
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

// The raw-frame location + naming come from paths.js, which builds
// `listSpriteAssets`' exclusion from the same two values — this reader is the
// sanctioned narrow window onto the directory that listing deliberately skips.
async function listRawFrameNames(recordId, rawRel) {
  const names = await readdir(join(spriteDir(recordId), rawRel)).catch(() => []);
  return names.filter((name) => RAW_FRAME_NAME.test(name)).sort();
}

/**
 * Re-express the packer's chosen cycle window in the numbering the client
 * renders frames in.
 *
 * `cycleSelection.windowStart` counts from the start of the longest USABLE span
 * the packer kept (walkPostprocess.js slices the clip's fade-in frames off
 * before selecting), while `frames[].sourceFrameIndex` counts raw `source-NNNN`
 * files 1-based. The two are different coordinate spaces and differ by
 * `span.start`, which the manifest never records — but it doesn't need to:
 * `indices[0] === windowStart`, so the FIRST packed frame's source index IS the
 * window's first raw frame. Without this translation the highlight would sit
 * `span.start` frames to the left of the frames it claims to cover.
 *
 * `windowEndFrame` is EXCLUSIVE — it is the seam frame the packer scored the
 * window's endpoints against, not a member of the cycle. Only ever called for a
 * manifest whose packed frames were verified against disk (see
 * `manifestCycleProvenance`), so the per-field null degradation below covers a
 * malformed `cycleSelection`, not a missing `frames[]`.
 */
function cycleWindowOf(packaged) {
  const cycle = packaged?.cycleSelection;
  if (!cycle) return null;
  const windowLength = Number.isInteger(cycle.windowLength) ? cycle.windowLength : null;
  const first = packaged?.frames?.[0]?.sourceFrameIndex;
  const windowStartFrame = Number.isInteger(first) ? first : null;
  return {
    windowStart: Number.isInteger(cycle.windowStart) ? cycle.windowStart : null,
    windowLength,
    windowStartFrame,
    windowEndFrame: windowStartFrame !== null && windowLength !== null
      ? windowStartFrame + windowLength : null,
    periodEstimate: Number.isInteger(cycle.periodEstimate) ? cycle.periodEstimate : null,
    periodAgreement: typeof cycle.periodAgreement === 'string' ? cycle.periodAgreement : null,
  };
}

/**
 * The packed-strip provenance to report against the raw frames actually on disk:
 * the cycle window, the source indices that became columns, and whether the two
 * can be trusted to address the same files.
 *
 * The check is not paranoia. `cycleSelection` and `frames[].sourceFrameIndex`
 * were recorded when the run was PACKAGED — for an imported run, by the source
 * pipeline's own extraction — while the frames listed here may have been
 * re-extracted by this install's ffmpeg (`fps=12`, first 8s). If those two
 * extractions disagree at all, the indices address different PNGs and the panel
 * would confidently mark the wrong frames as "the gait cycle" and "packed into
 * the strip" — a false claim about provenance is worse than no claim.
 *
 * **Presence is not identity, which is why this hashes.** Both extractions name
 * their output `source-%04d.png`, so a source pipeline that sampled at 24fps
 * declares a `source-0010.png` that also exists here — holding a different
 * moment of the clip. A basename check would call that 'verified' and mark the
 * wrong frames, i.e. miss the exact hazard it exists for. The packer records
 * `sourceSha256` per frame (walkPostprocess.js), so compare one declared frame's
 * bytes; a manifest too old to carry hashes falls back to presence, which is
 * still better than nothing and never worse than not checking.
 *
 *   'verified'  the declared source frames are the ones on disk → markers are real
 *   'stale'     they are not → markers withheld, and the client says why
 *   'none'      the run carries no packaged cycle to map (never packaged, or a
 *               minimal manifest) → nothing to verify, nothing to withhold
 */
async function manifestCycleProvenance(recordId, rawRel, packaged, names) {
  const packedFrames = Array.isArray(packaged?.frames) ? packaged.frames : [];
  const indices = packedFrames
    .map((frame) => frame?.sourceFrameIndex)
    .filter((index) => Number.isInteger(index));
  const withheld = { cycle: null, selectedSourceIndices: [], cycleProvenance: 'stale' };
  if (!indices.length) return { ...withheld, cycleProvenance: 'none' };
  const declared = packedFrames.map((frame) => (typeof frame?.sourcePath === 'string'
    ? { name: frame.sourcePath.split('/').pop(), sha256: frame.sourceSha256 }
    : null));
  // Partial declaration is not partial evidence: two of twelve frames naming a
  // path that happens to exist says nothing about the other ten, so treat an
  // incompletely-declared manifest as unverifiable rather than verified. A
  // manifest that declares NOTHING (older/minimal packaging) is taken at its
  // word — there is nothing to compare, and withholding the markers would punish
  // a record for being terse rather than wrong.
  if (!declared.some(Boolean)) {
    return { cycle: cycleWindowOf(packaged), selectedSourceIndices: indices, cycleProvenance: 'verified' };
  }
  const onDisk = new Set(names);
  if (!declared.every((frame) => frame && onDisk.has(frame.name))) return withheld;
  // One hash settles it: the declared frames come from a single extraction, so
  // if one is byte-identical the numbering they share is the numbering on disk.
  const hashed = declared.find((frame) => typeof frame.sha256 === 'string' && frame.sha256);
  if (hashed && await sha256File(join(spriteDir(recordId), rawRel, hashed.name)) !== hashed.sha256) {
    return withheld;
  }
  return {
    cycle: cycleWindowOf(packaged),
    selectedSourceIndices: indices,
    cycleProvenance: 'verified',
  };
}

/**
 * One source-frame response, defaulted to the "nothing to show" shape and
 * overridden with whatever was actually found.
 *
 * Written as one builder rather than two hand-assembled object literals so that
 * adding a field is one edit: the absent case has to stay as informative as the
 * populated one (the client still seeds its re-derive control from `target` and
 * labels the run's current geometry off `current`), and a shape that only two
 * thirds matched would defeat that quietly.
 */
function sourceFrameResponse(runId, run, walkTarget, walkSet, found) {
  return {
    runId,
    direction: run?.direction || null,
    // Whether the run is still packaged by the source pipeline — the client picks
    // the right remedy from it (re-import vs "this was generated here"), rather
    // than assuming every clipless run is an import.
    imported: Boolean(run?.importedPackaging),
    extractionFps: WALK_FPS,
    maxSourceSeconds: MAX_SOURCE_SECONDS,
    current: runCycleOf(run),
    // The set-level cycle target (#2985) — the re-derive control's bounds come
    // from here, not from a free authoring range: re-deriving ONE direction to a
    // geometry the rest of the set doesn't share just recreates a ragged set from
    // the other end (and the reprocess would 409 WALK_TARGET_MISMATCH anyway).
    target: walkTarget,
    available: false,
    reason: null,
    frames: [],
    cycle: null,
    selectedSourceIndices: [],
    cycleProvenance: 'none',
    editable: false,
    lockReason: null,
    // Only meaningful alongside lockReason 'finalized': whether the set-level
    // Unlock this panel offers is itself blocked, and whether that block can be
    // acknowledged past (#3043). Passed through from the walk state the caller
    // already loaded, so this panel and the walk workflow offer the same action
    // for the same set.
    unlock: walkSet?.unlock || null,
    ...found,
  };
}

/**
 * Every frame the run's source video produced, plus the provenance mapping them onto the packed
 * strip (#2980). The Loop Trimmer can only DROP columns from a packed strip, so raw frames are the
 * only path to a HIGHER frame count; `listSpriteAssets` hides them by design.
 *
 * Distinct absence sentinels, none a 500 or an empty-looking success:
 *   - `reason: 'no-source-video'`    no clip on disk at all
 *   - `reason: 'raw-frames-cleaned'` the clip IS here but its frames were pruned (see `extract`)
 *   - `reason: 'run-not-packaged'`   a synthesized redraw cycle (#2924) with no clip or run directory
 *
 * `editable`/`lockReason` are SEPARATE from `available`: frames can be listed for a run whose clip was
 * deleted, and a run with a clip can be locked by approval or a frozen set.
 *
 * **`extract` is opt-in; the read is otherwise side-effect free.** Imported runs always arrive with
 * an empty raw directory, so extracting on read would silently spawn eight ffmpeg decodes (~96 PNGs
 * each) when the trimmer opens, holding the per-record write tail and adding >100MB of re-derivable
 * data to backups. The caller asks for `extract: true` from an explicit user action. Extraction is
 * idempotent (`ffmpeg -y`) and runs inside the per-record write tail.
 */
export async function getWalkSourceFrames(recordId, runId, { extract = false } = {}) {
  // All three reads are independent — the character gate, the run lookup, and
  // the walk state (which serves the target, the lock gate, and the redraw
  // fallback below) — so pay for them once, concurrently.
  const [, found, state] = await Promise.all([
    requireCharacter(recordId),
    resolveWalkRunById(recordId, runId),
    getWalkState(recordId),
  ]);
  const { walkTarget, selection, walkSet } = state;
  if (!found) {
    // A run the walk state knows but that has no run DIRECTORY is a redraw cycle
    // synthesized from an imagegen manifest — a legitimate trimmer source with no
    // clip behind it, so it gets the soft sentinel rather than the 404 an
    // unknown id earns.
    const known = state.runs.find((r) => r.id === runId);
    if (!known) throw new ServerError(`Unknown walk run: ${runId}`, { status: 404, code: 'RUN_NOT_FOUND' });
    return sourceFrameResponse(runId, known, walkTarget, walkSet, {
      reason: 'run-not-packaged',
      // A frozen set outranks the missing clip, matching `reDeriveLockReason`'s
      // own ordering. Hardcoding 'no-source-video' here made the Loop Trimmer
      // treat a FINALIZED set as merely clipless for a redraw-only direction
      // (an imagegen cycle has no run directory) — so it left `CycleTarget`
      // enabled, which 409s on change, and suppressed the lock panel that
      // carries the unlock. That is the pair of defects #3043 set out to fix,
      // still reachable through the one direction that has no run behind it.
      lockReason: walkSet ? 'finalized' : 'no-source-video',
    });
  }
  const { runDirRel } = found;
  const run = normalizeRunRecord(recordId, found.run, runDirRel);
  const rawRel = rawFramesRelOf(runDirRel);
  // Three independent probes (the clip, the raw listing, the packaged manifest)
  // — none feeds the next, so they overlap rather than serializing three round
  // trips onto a read the trimmer makes on every source switch.
  const [clipRel, listed, packaged] = await Promise.all([
    resolveRunClipRel(recordId, run, runDirRel),
    listRawFrameNames(recordId, rawRel),
    run.postprocessManifest
      // Read-only source-frame inspection; postprocess writes a fresh authoritative manifest.
      ? readJSONFile(join(spriteDir(recordId), run.postprocessManifest), null)
      : null,
  ]);
  let names = listed;
  if (!names.length && clipRel && extract) {
    await walkWriteTail(recordId, () => extractVideoFrames(
      resolveSpriteAssetPath(recordId, clipRel),
      resolveSpriteAssetPath(recordId, rawRel),
    ));
    // Re-listed rather than taking the extractor's return, so what counts as a
    // raw frame is defined in exactly one place.
    names = await listRawFrameNames(recordId, rawRel);
  }
  const frames = names.map((name) => ({
    index: Number(RAW_FRAME_NAME.exec(name)[1]),
    path: `${rawRel}/${name}`,
  }));
  const lockReason = reDeriveLockReason({
    walkSet, selection, run, runId, clipRel,
  });
  return sourceFrameResponse(runId, run, walkTarget, walkSet, {
    available: frames.length > 0,
    // "No clip at all" and "clip present, frames pruned" are different states
    // with different remedies — the second is one click from recoverable.
    reason: frames.length > 0 ? null : (clipRel ? 'raw-frames-cleaned' : 'no-source-video'),
    frames,
    ...(await manifestCycleProvenance(recordId, rawRel, packaged, names)),
    editable: !lockReason,
    lockReason,
  });
}
