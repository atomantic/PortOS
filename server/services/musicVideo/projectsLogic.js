/**
 * Music Video — pure record transforms (issue #1760, Phase 1).
 *
 * Mirrors the Creative Director store split: the file backend (projectsFile.js)
 * and the PostgreSQL backend (projectsDB.js) share the SAME mutation semantics
 * and differ only in load/persist, so all storage-agnostic logic lives here.
 * Each function takes a plain project record and returns the next record (or
 * throws a ServerError on a validation failure), leaving read/write to the
 * caller.
 *
 * Peer-sync federation (#1770): the sanitize + LWW-merge decision helpers the CD
 * store carries now live here too (`sanitizeProjectForSync`, `mergeProjectRecord`),
 * shared by both backends so the merge can't drift. The soft-delete fields were
 * already on the record, so federation was purely additive (no record migration).
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import {
  MUSIC_VIDEO_STATUSES,
  MUSIC_VIDEO_REFERENCE_USES,
  musicVideoAudioAnalysisSchema,
  musicVideoMidiTranscriptionSchema,
  musicVideoSceneCreateSchema,
  musicVideoSceneUpdateSchema,
} from '../../lib/validation.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { stripMusicVideoLocalRenderPins } from '../../lib/syncWire.js';
import { persistedRenderPinFields } from '../../lib/renderTargets.js';
import { sanitizeProjectForSync } from '../../lib/projectStoreKit.js';
import { isStr } from '../../lib/textUtils.js';
import { isPerformanceScene, planShotSplit, shotSplitLimit } from '../../lib/musicVideoShotTiming.js';
import { normalizeLyricCues, normalizePhrases, invalidateTimedText } from './timedText.js';
import { normalizeLyricMarkers } from './lyricMarkers.js';
import { ensureSceneTakes, TAKE_SLOT } from './takes.js';
import { normalizeComposition, invalidateCompositionTiming, withStoredCompositionDocument } from './composition.js';
import { normalizeSoundBed } from './soundBed.js';
import { remapTreatmentForClone, scenesFingerprint } from './treatment.js';
import { normalizeMusicVideoAutomation } from '../../lib/musicVideoAutomation.js';

export { sanitizeProjectForSync } from '../../lib/projectStoreKit.js';

// Re-exported for the PG backend's typed mirror columns (mirrors the CD store).
export { mirrorTimestamp } from '../../lib/pgTimestamp.js';

const STATUS_COLUMN_MAX = 32;

/** Safe value for the `status` mirror column — bounded, never null. */
export function mirrorStatus(status) {
  return (typeof status === 'string' && status ? status : 'draft').slice(0, STATUS_COLUMN_MAX);
}

/** Return the next record with `extra` merged and `updatedAt` freshly stamped. */
function touch(record, extra) {
  return { ...record, ...extra, updatedAt: new Date().toISOString() };
}

/** safeParse a scene payload, throwing a 400 ServerError with field detail on failure. */
function parseSceneOrThrow(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ServerError(
      `Scene validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  return parsed.data;
}

/**
 * Normalize a validated visual specification (#8965): every reference persists
 * a stable id and explicit defaults so edits stay addressable and a peer reads
 * the same shape. `base` is the stored spec a partial patch merges onto — each
 * sub-field present in the patch replaces its stored value; absent ones keep it.
 */
function normalizeVisualSpec(patch, base = null) {
  const merged = { ...(base || {}), ...(patch || {}) };
  const references = (Array.isArray(merged.references) ? merged.references : []).map((ref) => ({
    id: typeof ref.id === 'string' && ref.id ? ref.id : `mvr-${randomUUID()}`,
    imageId: ref.imageId,
    role: ref.role || 'mood',
    label: typeof ref.label === 'string' ? ref.label : '',
    note: typeof ref.note === 'string' ? ref.note : '',
    condition: ref.condition === true,
    // #8980 — reference (default) / final-visible / motion-reference.
    use: MUSIC_VIDEO_REFERENCE_USES.includes(ref.use) ? ref.use : 'reference',
  }));
  return {
    references,
    palette: Array.isArray(merged.palette) ? merged.palette.map((c) => c.toLowerCase()) : [],
    typography: typeof merged.typography === 'string' ? merged.typography : '',
    cameraRules: typeof merged.cameraRules === 'string' ? merged.cameraRules : '',
    moodBoardId: typeof merged.moodBoardId === 'string' && merged.moodBoardId ? merged.moodBoardId : null,
  };
}

/** Build a fresh project record from validated create input. */
export function buildProjectRecord(input, { id, now }) {
  const {
    name, mode = 'director', trackId = null,
    uploadedAudioFilename = null, concept = null,
    videoSettings = {},
  } = input;
  return {
    id,
    name,
    version: 1,
    parentProjectId: null,
    rootProjectId: null,
    status: 'draft',
    mode,
    createdAt: now,
    updatedAt: now,
    trackId,
    uploadedAudioFilename,
    concept,
    // #8965 — the reusable visual specification (moodboard/reference assets,
    // palette, typography, camera rules). Null until the director sets one.
    visualSpec: input.visualSpec ? normalizeVisualSpec(input.visualSpec) : null,
    videoSettings: {
      backend: videoSettings.backend ?? 'local',
      modelId: videoSettings.modelId ?? null,
      grokDuration: videoSettings.grokDuration ?? 10,
      falDuration: videoSettings.falDuration ?? null,
      falModelId: videoSettings.falModelId ?? null,
      falResolution: videoSettings.falResolution ?? null,
      falLipSyncResolution: videoSettings.falLipSyncResolution ?? null,
      generationMode: videoSettings.generationMode ?? 'image',
      audioReactiveLora: videoSettings.audioReactiveLora ?? null,
      audioReactiveScale: videoSettings.audioReactiveScale ?? 1.2,
    },
    // #3231 Phase 4 — per-record image render pin for scene reference-frame
    // renders (the shared universe/series/sprite field pair). Present only
    // when set, so existing records keep their on-disk shape byte-stable.
    ...persistedRenderPinFields(input),
    // Automation-first brief (tools, guidance, budget). Present only when set,
    // so director-authored records keep their on-disk shape byte-stable.
    ...(input.automation ? { automation: normalizeMusicVideoAutomation(input.automation) } : {}),
    audioAnalysis: null,
    midiTranscription: null,
    // #8964 — editable timed lyric cues + phrase annotations (timed against
    // the current audio source) and the shot planner's pacing range.
    lyricCues: Array.isArray(input.lyricCues) ? normalizeLyricCues(input.lyricCues) : [],
    // Section headers + stage directions read off the lyric sheet, anchored to
    // cue indices (lyricMarkers.js). Present only when the sheet had any, so a
    // record without them keeps its shape.
    ...(Array.isArray(input.lyricMarkers) && input.lyricMarkers.length
      ? { lyricMarkers: normalizeLyricMarkers(input.lyricMarkers) }
      : {}),
    phrases: Array.isArray(input.phrases) ? normalizePhrases(input.phrases) : [],
    pacing: input.pacing ?? null,
    // #8984 — composition manifest (null = plain concatenation render).
    // The document pointer is set only by the import routes, never on create.
    composition: input.composition ? withStoredCompositionDocument(normalizeComposition(input.composition), null) : null,
    // #8988 — optional sound-design bed mixed under the song.
    soundBed: input.soundBed ? normalizeSoundBed(input.soundBed) : null,
    // #8980 — optional pre-production treatment (brief, arc, shot direction,
    // proof checklist); null until the director starts one. See treatment.js.
    treatment: null,
    scenes: [],
    renderHistoryId: null,
    // Soft-delete tombstone trio — kept so peer-sync federation (a follow-up)
    // is additive rather than a record-shape migration.
    deleted: false,
    deletedAt: null,
  };
}

function mintCloneSceneId(scene, sceneIdMap) {
  const next = `mvs-${randomUUID()}`;
  sceneIdMap.set(scene.sceneId, next);
  return next;
}

/** Build an independently editable next version while reusing immutable media assets. */
export function cloneProjectRecord(source, {
  id,
  now,
  name,
  includeGeneratedMedia = true,
}) {
  const nameMatch = typeof source.name === 'string' ? source.name.match(/^(.*?)(?:\s+v(\d+))?$/i) : null;
  const inferredVersion = Number(nameMatch?.[2]) || 1;
  const sourceVersion = Number.isInteger(source.version) && source.version > 0
    ? source.version
    : inferredVersion;
  const version = sourceVersion + 1;
  const baseName = nameMatch?.[1]?.trim() || source.name || 'Music Video';
  const sceneIdMap = new Map();
  const scenes = (source.scenes || []).map((scene, order) => ({
    ...scene,
    sceneId: mintCloneSceneId(scene, sceneIdMap),
    order,
    referenceImageId: includeGeneratedMedia ? (scene.referenceImageId ?? null) : null,
    videoHistoryId: includeGeneratedMedia ? (scene.videoHistoryId ?? null) : null,
    // Takes are immutable pointers to shared media, so a media-keeping clone
    // carries the whole candidate history; a clean clone starts empty.
    takes: includeGeneratedMedia ? ensureSceneTakes(scene, now) : [],
  }));
  const mediaReady = includeGeneratedMedia
    && scenes.length > 0
    && scenes.every((scene) => scene.referenceImageId && scene.videoHistoryId);

  return {
    ...source,
    id,
    name: name?.trim() || `${baseName} v${version}`,
    version,
    parentProjectId: source.id,
    rootProjectId: source.rootProjectId || source.id,
    status: source.audioAnalysis ? (mediaReady ? 'ready' : 'analyzed') : 'draft',
    createdAt: now,
    updatedAt: now,
    scenes,
    // #8980 — the treatment's shot directions and proofs follow the scenes to
    // their new ids; proof evidence the clone can't back is dropped.
    treatment: source.treatment ? remapTreatmentForClone(source.treatment, sceneIdMap, {
      includeGeneratedMedia,
      sourceRenderId: source.renderHistoryId ?? null,
      sourceScenesFingerprint: scenesFingerprint(source.scenes || []),
      cloneScenesFingerprint: scenesFingerprint(scenes),
    }) : null,
    // #8987 — a draft's section map follows the scenes to their new ids, so a
    // clone can still revise from the review notes it carried over (#8986).
    ...(Array.isArray(source.excerpts) ? {
      // A running encoder belongs only to the source project. Copying its
      // partial-file ownership would let clone recovery delete that output.
      excerpts: source.excerpts.filter((excerpt) => excerpt?.status !== 'rendering').map((excerpt) => (Array.isArray(excerpt?.sections)
        ? { ...excerpt, sections: excerpt.sections.map((s) => ({ ...s, sceneId: sceneIdMap.get(s.sceneId) ?? s.sceneId })) }
        : excerpt)),
    } : {}),
    // A revision is in-progress work against the SOURCE's takes; the clone
    // starts with none (its carried-over notes can open a fresh one).
    revisions: [],
    // #9102: an auto-review run is tied to the SOURCE's revisions/excerpts, so a
    // clone starts with none (terminal runs too — their links are source-scoped).
    ...(Array.isArray(source.autoReviews) ? { autoReviews: [] } : {}),
    // #9066: a production run executes against the SOURCE's scenes and jobs.
    ...(Array.isArray(source.productionRuns) ? { productionRuns: [] } : {}),
    // Development artifacts ride along as-is: every version is an immutable
    // file, so the clone points at the same bytes (devArtifacts.js). The Cast
    // & Sets check-in keeps its direction and images, but its dispatch pin and
    // production link belong to the source — a working stage reads as
    // interrupted on the clone and can be resumed there.
    ...(source.castAndSets ? { castAndSets: { ...source.castAndSets, processId: null, productionRunId: null } } : {}),
    renderHistoryId: null,
    // #9010: the source's in-flight render mark is not the clone's.
    renderingOn: null,
    renderPartialFilename: null,
    deleted: false,
    deletedAt: null,
  };
}

/** Merge a project metadata patch, validating status. Returns the next record. */
export function applyProjectPatch(project, patch) {
  if (patch.status && !MUSIC_VIDEO_STATUSES.includes(patch.status)) {
    throw new ServerError(`Invalid status: ${patch.status}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  // A `concept` patch merges into the existing concept sub-fields rather than
  // replacing the whole object — mirrors applySceneUpdate's per-field scene merge
  // below, so a caller sending only the sub-field it edited (e.g. { style: '…' })
  // can't clobber a sibling sub-field (e.g. prompt) set concurrently by another
  // sync peer (#3168). An explicit `concept: null` still clears it outright.
  // Edited cue/phrase lists replace the stored list whole, normalized so every
  // entry persists a stable id and a forward time range (timedText.js). A
  // `visualSpec` patch merges per sub-field the same way (#8965).
  const timedPatch = {
    ...patch,
    ...(patch.visualSpec ? { visualSpec: normalizeVisualSpec(patch.visualSpec, project.visualSpec) } : {}),
    // Automation brief merges per sub-field; null clears it.
    ...('automation' in patch ? {
      automation: patch.automation ? normalizeMusicVideoAutomation(patch.automation, project.automation) : null,
    } : {}),
    ...(Array.isArray(patch.lyricCues) ? { lyricCues: normalizeLyricCues(patch.lyricCues) } : {}),
    ...(Array.isArray(patch.lyricMarkers) ? { lyricMarkers: normalizeLyricMarkers(patch.lyricMarkers) } : {}),
    ...(Array.isArray(patch.phrases) ? { phrases: normalizePhrases(patch.phrases) } : {}),
    // #8984 — the composition manifest is replaced whole; null clears it.
    // The composition document pointer is owned by the import routes: a PATCH
    // that echoes (or omits, or forges) it keeps the stored one.
    ...('composition' in patch ? { composition: withStoredCompositionDocument(normalizeComposition(patch.composition), project.composition) } : {}),
    // #8988 — an explicitly chosen sound-design bed; null clears it.
    ...('soundBed' in patch ? { soundBed: normalizeSoundBed(patch.soundBed) } : {}),
  };
  // #8988: a bed is mixed UNDER the song — the song itself can't be its bed.
  const masterTrackId = 'trackId' in patch ? patch.trackId : project.trackId;
  if (timedPatch.soundBed && masterTrackId && timedPatch.soundBed.trackId === masterTrackId) {
    throw new ServerError('The sound-design bed must be a different track from the song', { status: 422, code: 'SOUND_BED_IS_MASTER' });
  }
  const conceptMergedPatch = ('concept' in timedPatch && timedPatch.concept && project.concept)
    ? { ...timedPatch, concept: { ...project.concept, ...timedPatch.concept } }
    : timedPatch;
  // Renderer settings are edited independently in the UI. Merge a partial
  // change so picking a model cannot discard the provider or Grok duration.
  const mergedPatch = ('videoSettings' in conceptMergedPatch && conceptMergedPatch.videoSettings)
    ? {
      ...conceptMergedPatch,
      videoSettings: {
        backend: 'local',
        modelId: null,
        grokDuration: 10,
        falDuration: null,
        falModelId: null,
        falResolution: null,
        falLipSyncResolution: null,
        generationMode: 'image',
        audioReactiveLora: null,
        audioReactiveScale: 1.2,
        ...project.videoSettings,
        ...conceptMergedPatch.videoSettings,
      },
    }
    : conceptMergedPatch;
  // Changing the audio source invalidates the cached beat/tempo analysis —
  // it was computed from the OLD track. AI Plan / Auto-arrange / BeatTimeline
  // gate on `audioAnalysis` truthiness, and the render's beat-snap step reads
  // its `beats` array; a stale analysis would silently apply the previous
  // song's beat grid to the new audio (#1945 — both the manual "Change
  // track" picker and the YouTube-import attach PATCH through here). Any
  // scene already marked `beatAligned` also stops being true — its saved
  // startSec/endSec were snapped to the OLD song's beat positions, and
  // `beatSnapClips` honors a beat-aligned scene's saved bounds outright
  // (skipping re-derivation against the new, absent beat grid), so leaving
  // the flag set would render the old song's cut points against new audio.
  const trackChanged = ('trackId' in patch && patch.trackId !== project.trackId)
    || ('uploadedAudioFilename' in patch && patch.uploadedAudioFilename !== project.uploadedAudioFilename);
  if (!trackChanged) return touch(project, mergedPatch);
  // A planned section belongs to the old audio too; clear its provenance so
  // the renderer does not preserve that plan's timing on the replacement song.
  const scenes = (project.scenes || []).map((s) => (s.beatAligned || s.sectionIndex != null
    ? { ...s, beatAligned: false, sectionIndex: null } : s));
  // Clearing audioAnalysis means the project must be re-analyzed before it can be
  // planned/arranged/rendered, so a status that implies analysis existed
  // (`analyzed`/`ready`/`rendering`/`complete`) is now stale. Regress it to `draft` —
  // the inverse of setAudioAnalysis's draft→analyzed flip — unless the caller set an
  // explicit status in this same patch. `draft`/`failed` already imply no usable
  // analysis, so leave those untouched.
  const regressStatus = !patch.status && !['draft', 'failed'].includes(project.status);
  const statusPatch = regressStatus ? { status: 'draft' } : {};
  // The MIDI transcription was produced from the OLD audio too — clear it with
  // the analysis so a stale .mid can't masquerade as the new track's score.
  // Lyric-cue and phrase timings were aligned to the OLD audio as well: keep the
  // director's text but clear the times and word timings (#8964, #9074), unless
  // this same patch supplied fresh lists of its own.
  return touch(project, {
    ...invalidateTimedText(project),
    // Composition cue times and the poster frame were set against the old
    // song too: keep the text, clear the timings (#8984).
    ...(project.composition ? { composition: invalidateCompositionTiming(project.composition) } : {}),
    // A vocal stem is a bounce of the OLD song; conditioning a performance on
    // it against the new master would sing the wrong words (#8977).
    ...(project.vocalStemFilename ? { vocalStemFilename: null } : {}),
    ...mergedPatch,
    ...statusPatch,
    audioAnalysis: null,
    midiTranscription: null,
    scenes,
  });
}

/**
 * Cache the offline beat/tempo/section analysis on the project. Flips a `draft`
 * project to `analyzed`; leaves any later status untouched (re-analysis of a
 * ready/rendering project shouldn't regress its lifecycle). The analysis shape
 * is validated so a hand-edited/legacy record can't store a malformed map.
 */
export function setAudioAnalysis(project, analysis) {
  const validated = musicVideoAudioAnalysisSchema.parse(analysis);
  const status = project.status === 'draft' ? 'analyzed' : project.status;
  return touch(project, { audioAnalysis: validated, status });
}

/**
 * Cache the MuScriptor audio → MIDI transcription pointer on the project (a
 * .mid basename under /api/uploads). Validated so a hand-edited/legacy record
 * can't store a malformed pointer; doesn't touch the lifecycle status — the
 * MIDI is a parsing artifact, not an arrangement step.
 */
export function setMidiTranscription(project, midi) {
  const validated = musicVideoMidiTranscriptionSchema.parse(midi);
  return touch(project, { midiTranscription: validated });
}

/** Default runtime fields for a scene the director (or planner) didn't supply. */
function buildScene(input, { order }) {
  return {
    sceneId: `mvs-${randomUUID()}`,
    order,
    label: input.label ?? '',
    sectionLabel: input.sectionLabel ?? null,
    startSec: input.startSec ?? null,
    endSec: input.endSec ?? null,
    beatAligned: input.beatAligned ?? false,
    prompt: input.prompt ?? '',
    framePrompt: input.framePrompt ?? null,
    // #8964: a new shot never silently repeats its clip to fill a span — looping
    // is an explicit choice. (Pre-#8964 scenes carry no `loop` key and keep the
    // legacy loop-to-fill render; see render.js#sceneLoops.)
    loop: input.loop ?? false,
    sectionIndex: input.sectionIndex ?? null,
    lyricText: input.lyricText ?? null,
    visualIntent: input.visualIntent ?? null,
    // #8985: what a composed render shows for this span (render.js#sceneLayer).
    visualLayer: input.visualLayer ?? 'footage',
    stillMove: input.stillMove ?? 'hold',
    cardText: input.cardText ?? null,
    cardColor: input.cardColor ?? null,
    // #8977: cutaway (any image-to-video lane) unless the director asks for a
    // lip-synced performance shot, which only a source-audio provider renders.
    shotMode: input.shotMode ?? 'cutaway',
    referenceImageId: null,
    videoHistoryId: null,
    // #8965 — immutable candidate takes; the two slot fields above are the
    // director's selection among them (see takes.js).
    takes: [],
  };
}

/**
 * Append a scene to the board. Validates the input, assigns a sceneId and the
 * next order index. Returns `{ project, scene }`. A thin single-item wrapper
 * over `addScenes` so the validate/build/order logic lives in exactly one
 * place.
 */
export function addScene(project, sceneInput) {
  const { project: next, scenes } = addScenes(project, [sceneInput]);
  return { project: next, scene: scenes[0] };
}

/**
 * Append several scenes to the board in one pass (the autonomous planner,
 * #1855) — a single `touch`/persist instead of N sequential addScene calls, so
 * a 10-section plan is one write (and one peer-sync emit) instead of ten.
 * Returns `{ project, scenes }` (the newly-created scenes, in input order).
 */
export function addScenes(project, sceneInputs) {
  const list = Array.isArray(sceneInputs) ? sceneInputs : [];
  const existing = project.scenes || [];
  const added = [];
  let order = existing.length;
  for (const input of list) {
    const data = parseSceneOrThrow(musicVideoSceneCreateSchema, input);
    added.push(buildScene(data, { order }));
    order += 1;
  }
  const next = touch(project, { scenes: [...existing, ...added] });
  return { project: next, scenes: added };
}

/**
 * Apply a patch to a single scene. Returns `{ project, updated }`. Throws if the
 * scene id is unknown.
 */
export function applySceneUpdate(project, sceneId, patch) {
  const data = parseSceneOrThrow(musicVideoSceneUpdateSchema, patch);
  const scenes = project.scenes || [];
  const idx = scenes.findIndex((s) => s.sceneId === sceneId);
  if (idx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const merged = { ...scenes[idx], ...data };
  // Setting a slot directly (an older client, or a hand edit) still records the
  // asset as a take so the candidate list stays a superset of the selection.
  const touchesSlot = Object.values(TAKE_SLOT).some((field) => typeof data[field] === 'string');
  const updated = touchesSlot ? { ...merged, takes: ensureSceneTakes(merged, undefined, 'manual') } : merged;
  // The partial-patch schema can't enforce endSec >= startSec (the paired value
  // may be unchanged on the record), so validate the merged range here.
  if (updated.startSec != null && updated.endSec != null && updated.endSec < updated.startSec) {
    throw new ServerError('endSec must be >= startSec', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const nextScenes = scenes.slice();
  nextScenes[idx] = updated;
  const next = touch(project, { scenes: nextScenes });
  return { project: next, updated };
}

/** Remove a scene and re-sequence the remaining scenes' `order`. Returns the next record. */
export function removeScene(project, sceneId) {
  const scenes = project.scenes || [];
  if (!scenes.some((s) => s.sceneId === sceneId)) {
    throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  }
  const nextScenes = scenes
    .filter((s) => s.sceneId !== sceneId)
    .map((s, i) => ({ ...s, order: i }));
  return touch(project, { scenes: nextScenes });
}

/**
 * Reorder the board to the given sceneId order. `orderedIds` must be exactly the
 * project's current scene ids (a permutation) — a missing/extra/unknown id is a
 * 400 so a stale client can't silently drop scenes. Returns the next record.
 */
export function reorderScenes(project, orderedIds) {
  const scenes = project.scenes || [];
  const byId = new Map(scenes.map((s) => [s.sceneId, s]));
  if (orderedIds.length !== scenes.length || !orderedIds.every((id) => byId.has(id)) || new Set(orderedIds).size !== orderedIds.length) {
    throw new ServerError('Reorder must list each existing scene id exactly once', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const nextScenes = orderedIds.map((id, i) => ({ ...byId.get(id), order: i }));
  return touch(project, { scenes: nextScenes });
}

// Label suffix budget: the scene label schema caps at 120 characters.
const SCENE_LABEL_MAX = 120;

/**
 * The timed lyric lines sung during `[startSec, endSec]`, joined, or null. A
 * line held across a cut belongs to both pieces.
 */
function lyricTextWithin(cues, startSec, endSec) {
  const lines = (Array.isArray(cues) ? cues : [])
    .filter((cue) => {
      if (typeof cue?.startSec !== 'number') return false;
      const cueEnd = typeof cue.endSec === 'number' ? cue.endSec : cue.startSec;
      // Starts before the piece ends, and is still sounding (or starts) inside it.
      return cue.startSec < endSec - 1e-6 && (cueEnd > startSec + 1e-6 || cue.startSec >= startSec - 1e-6);
    })
    .map((cue) => (typeof cue.text === 'string' ? cue.text.trim() : ''))
    .filter(Boolean);
  return lines.length ? lines.join(' / ').slice(0, 2000) : null;
}

/**
 * Split a shot longer than its backend can render in one take (#8977) into
 * contiguous scenes on musical boundaries (lib/musicVideoShotTiming.js
 * `planShotSplit`): a performance shot at its lip-sync provider's audio
 * window, a Grok cutaway at the longest Grok clip. `backend` is the lane the
 * director will render with ('' / null = the project's pinned backend).
 *
 * The original scene keeps its id and takes and becomes the first piece (a
 * performance's lip-synced clip selection is cleared — see below). Each later
 * piece is a new scene placed right after it, carrying the shot's direction
 * and the selected reference frame (as a take, so the frame is ready to
 * animate) but no clip — the old clip was generated for the whole span. Each
 * piece's `lyricText` is the timed lines sung inside it. Returns `{ project, scenes }` (all pieces, in
 * order); throws 400 when the shot is untimed or already fits one take.
 */
export function splitScene(project, sceneId, { backend = null } = {}) {
  const scenes = project.scenes || [];
  const idx = scenes.findIndex((s) => s.sceneId === sceneId);
  if (idx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const scene = scenes[idx];
  const lane = backend || project.videoSettings?.backend || null;
  const maxSec = shotSplitLimit(scene, lane);
  if (maxSec == null) {
    throw new ServerError('This backend renders the shot at any length — there is nothing to split.', { status: 400, code: 'MUSIC_VIDEO_SPLIT_NOT_NEEDED' });
  }
  const plan = planShotSplit({
    startSec: scene.startSec,
    endSec: scene.endSec,
    maxSec,
    lyricCues: project.lyricCues,
    phrases: project.phrases,
    beats: project.audioAnalysis?.beats,
  });
  if (!plan.ok) throw new ServerError(plan.message, { status: 400, code: plan.code });

  const now = new Date().toISOString();
  const count = plan.pieces.length;
  // Re-splitting a piece numbers it afresh rather than stacking suffixes.
  const baseLabel = (scene.label || scene.sectionLabel || `Scene ${idx + 1}`).replace(/ · \d+\/\d+$/, '');
  const pieceLabel = (i) => {
    const suffix = ` · ${i + 1}/${count}`;
    return `${baseLabel.slice(0, SCENE_LABEL_MAX - suffix.length)}${suffix}`;
  };
  const hasTimedCues = (project.lyricCues || []).some((cue) => typeof cue?.startSec === 'number');
  const pieceLyrics = (piece) => (hasTimedCues ? lyricTextWithin(project.lyricCues, piece.startSec, piece.endSec) : scene.lyricText ?? null);

  const pieces = plan.pieces.map((piece, i) => {
    const timing = { label: pieceLabel(i), startSec: piece.startSec, endSec: piece.endSec, lyricText: pieceLyrics(piece) };
    if (i === 0) {
      const takes = ensureSceneTakes(scene, now);
      // A lip-synced take was generated for the old interval and the render
      // refuses it as re-timed, so the selection is cleared (the take stays a
      // candidate) and "Generate missing" fills it. A cutaway clip still starts
      // where the first piece does, so it stays selected and is trimmed.
      return isPerformanceScene(scene)
        ? { ...scene, ...timing, takes, videoHistoryId: null }
        : { ...scene, ...timing, takes };
    }
    const fresh = buildScene({
      ...parseSceneOrThrow(musicVideoSceneCreateSchema, {
        sectionLabel: scene.sectionLabel ?? null,
        prompt: scene.prompt ?? '',
        framePrompt: scene.framePrompt ?? null,
        beatAligned: scene.beatAligned ?? false,
        loop: scene.loop ?? false,
        sectionIndex: scene.sectionIndex ?? null,
        visualIntent: scene.visualIntent ?? null,
        visualLayer: scene.visualLayer ?? 'footage',
        shotMode: scene.shotMode ?? 'cutaway',
        ...timing,
      }),
    }, { order: 0 });
    const seeded = {
      ...fresh,
      ...(scene.direction ? { direction: structuredClone(scene.direction) } : {}),
      referenceImageId: scene.referenceImageId ?? null,
    };
    return { ...seeded, takes: ensureSceneTakes(seeded, now, 'manual') };
  });

  const nextScenes = [...scenes.slice(0, idx), ...pieces, ...scenes.slice(idx + 1)]
    .map((s, i) => ({ ...s, order: i }));
  const next = touch(project, { scenes: nextScenes });
  return { project: next, scenes: nextScenes.slice(idx, idx + count) };
}

// ---- peer-sync federation (#1770) -----------------------------------------
// Mirrors the Creative Director store (creativeDirector/projectsLogic.js): a
// project is a whole-record LWW kind (no item-union, no ephemeral flag), so the
// wire form is the record with normalized soft-delete fields and the merge is a
// straight `updatedAt` newest-wins decision. Both backends call through here so
// the file and PG paths can't diverge.

/**
 * Wire-safe / merge-safe projection of a peer-supplied project record. Rejects a
 * non-object or one missing an id (the receiver could never apply it), and
 * normalizes the timestamps + soft-delete pair so a legacy/hand-edited payload
 * converges byte-for-byte with a freshly-written one. Returns null when unusable.
 */
/**
 * LWW merge decision for one incoming peer record against the local copy.
 * Returns `{ next, inserted, remoteWins, changed }`:
 *   - malformed remote → `{ next: null, ... }` (caller drops it)
 *   - no local copy → insert the remote
 *   - otherwise newest-`updatedAt`-wins; `changed` is false when the winner is
 *     byte-identical to local (a same-`updatedAt` re-push no-ops, no churn).
 * Tombstone-aware purely via `updatedAt`: deleteProject stamps a fresh
 * `updatedAt`, so a tombstone beats an older live copy and can't be resurrected.
 */
export function mergeProjectRecord(local, remoteRaw) {
  let remote = sanitizeProjectForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  // An older peer can still send the fields that newer peers strip. Project
  // sync remains schema-v1 compatible, so apply the same projection inbound
  // before either inserting or restoring this machine's local choices.
  remote = stripMusicVideoLocalRenderPins(remote);
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  // Render pins are install-capability choices and therefore wire-local
  // (#3245). sanitizeRecordForWire omits them from peer payloads; restore this
  // machine's values before a newer remote record wholesale-replaces local.
  // Key-presence checks preserve an intentional local empty/null value instead
  // of confusing it with a missing field.
  remote = { ...remote };
  if (Object.hasOwn(local, 'imageMode')) remote.imageMode = local.imageMode;
  if (Object.hasOwn(local, 'imageModelId')) remote.imageModelId = local.imageModelId;
  // #9066: this install's production-run checkpoint survives a newer remote.
  if (Object.hasOwn(local, 'productionRuns')) remote.productionRuns = local.productionRuns;
  // Development artifacts and the Cast & Sets checkpoint are wire-local too:
  // their files and jobs exist only on this install.
  if (Object.hasOwn(local, 'devArtifacts')) remote.devArtifacts = local.devArtifacts;
  if (Object.hasOwn(local, 'castAndSets')) remote.castAndSets = local.castAndSets;
  // The composition document's files live only on this install as well
  // (compositionDocument.js), so its pointer survives a newer remote body.
  if (local.composition?.document && remote.composition && typeof remote.composition === 'object' && !Array.isArray(remote.composition)) {
    remote.composition = { ...remote.composition, document: local.composition.document };
  }
  if (local.videoSettings && typeof local.videoSettings === 'object'
    && !Array.isArray(local.videoSettings) && Object.hasOwn(local.videoSettings, 'backend')) {
    const remoteVideoSettings = remote.videoSettings && typeof remote.videoSettings === 'object'
      && !Array.isArray(remote.videoSettings) ? remote.videoSettings : {};
    remote.videoSettings = { ...remoteVideoSettings, backend: local.videoSettings.backend };
  }
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}
