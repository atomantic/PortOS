/** Music Video project creation, patching, storage and peer merge shared by both stores. */
import { DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION } from '../../lib/videoGenRequestFields.js';
import { festivalPacketSchema } from '../../lib/musicVideo/musicVideoFestivalPacket.js';
import { normalizeMakingOfStory } from '../../lib/musicVideo/musicVideoMakingOfStory.js';
import { normalizeBlenderRecord } from '../../lib/musicVideo/musicVideoBlender.js';
import { musicVideoMediaMode, assertMusicVideoMediaSelections } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { remapMusicVideoDependencies, restampLegacyFrameCasts, retainLegacyFinalLayerBaseline } from '../../lib/musicVideo/musicVideoDependencies.js';
import { randomUUID } from 'node:crypto';
import { applyEditedSections, remapScenesToSections } from '../../lib/musicVideo/musicVideoSections.js';
import { normalizeMusicVideoProductionPolicy } from '../../lib/musicVideo/musicVideoMediumPlan.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  MUSIC_VIDEO_STATUSES,
  MUSIC_VIDEO_REFERENCE_USES,
  musicVideoAudioAnalysisSchema,
  musicVideoMidiTranscriptionSchema,
} from '../../lib/musicVideo/musicVideoValidation.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { audioRevisionOf } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { stripMusicVideoLocalRenderPins } from '../../lib/syncWire.js';
import { persistedRenderPinFields } from '../../lib/renderTargets.js';
import { sanitizeProjectForSync } from '../../lib/projectStoreKit.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { normalizeLyricCues, normalizePhrases, invalidateTimedText } from './timedText.js';
import { normalizeLyricMarkers, remapLyricMarkers } from '../../lib/lyricMarkers.js';
import { ensureSceneTakes } from './takes.js';
import { normalizeComposition, invalidateCompositionTiming, withStoredCompositionDocument } from './composition.js';
import { normalizeSoundBed } from './soundBed.js';
import { applyAudioLayersPatch, normalizeAudioLayers } from './audioLayers.js';
import { normalizeFilmLook } from '../../lib/filmLook.js';
import { DEFAULT_NEW_PROJECT_TEMPLATE_EFFECTS, normalizeTemplateEffects } from '../../lib/musicVideo/musicVideoTemplateEffects.js';
import { normalizeOverscan } from '../../lib/musicVideo/musicVideoFilmLook.js';
import { normalizeProductionMedium } from '../../lib/musicVideo/musicVideoProductionMedium.js';
import { normalizeTitleCard } from '../../lib/musicVideo/musicVideoTitleCard.js';
import { normalizeStatsOutro } from '../../lib/musicVideo/musicVideoStatsOutro.js';
import { normalizeCreditsOutro } from '../../lib/musicVideo/musicVideoCreditsOutro.js';
import { carryTreatmentThroughSceneOrder, remapTreatmentForClone, scenesFingerprint } from './treatment.js';
import { packTakePrompts, unpackTakePrompts } from './takePromptPool.js';
import { carryReviewThroughSceneOrder, slimProjectReview } from './productionReview.js';
import { normalizeMusicVideoAutomation } from '../../lib/musicVideo/musicVideoAutomation.js';
// Reuse the frozen v53 -> v54 transform when an older peer sends a project.
import { migrateMusicVideoPreviz } from '../../../scripts/migrations/459-music-video-previz-timeline.js';
import { touchProjectRecord } from './projectRecordUpdate.js';
import { sceneListInTimeOrder, syncWordAnchoredScenes } from './sceneListLogic.js';

/** The vocal-stem fields cleared together whenever the stem stops belonging to the song (#8977). */
export const CLEARED_VOCAL_STEM = Object.freeze({ vocalStemFilename: null, vocalStemMasterFilename: null, vocalStemDerived: null });

// Re-exported for the PG backend's typed mirror columns (mirrors the CD store).
const STATUS_COLUMN_MAX = 32;

/** Safe value for the `status` mirror column — bounded, never null. */
export function mirrorStatus(status) {
  return (typeof status === 'string' && status ? status : 'draft').slice(0, STATUS_COLUMN_MAX);
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

const DEFAULT_VIDEO_SETTINGS = Object.freeze({
  backend: 'local',
  upscaleTargetResolution: DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION,
  modelId: null,
  grokDuration: 10,
  falDuration: null,
  falModelId: null,
  falResolution: null,
  falEndFrameModelId: null,
  falLipSyncResolution: null,
  falMusicModelId: null,
  falMusicResolution: null,
  falLipSyncTranscription: null,
  runwayModelId: null,
  runwayDuration: null,
  runwayResolution: null,
  generationMode: 'image',
  audioReactiveLora: null,
  audioReactiveScale: 1.2,
});

const OPTIONAL_VIDEO_SETTINGS = [
  'renderPool',
  'higgsfieldModelId', 'higgsfieldDuration', 'higgsfieldResolution',
  'googleModelId', 'googleDuration', 'googleResolution',
  'draftResolution', 'finalResolution', 'upscaleMethod',
];

function normalizeVideoSettings(input, base) {
  // Patches preserve explicit clears and stored fields from newer peers.
  if (base !== undefined) return { ...DEFAULT_VIDEO_SETTINGS, ...base, ...input };
  return Object.fromEntries([
    ...Object.entries(DEFAULT_VIDEO_SETTINGS).map(([key, value]) => [key, input[key] ?? value]),
    ...OPTIONAL_VIDEO_SETTINGS.filter((key) => input[key]).map((key) => [key, input[key]]),
  ]);
}

/** Build a fresh project record from validated create input. */
export function buildProjectRecord(input, { id, now, blender, sourceFilm }) {
  const productionPolicy = normalizeMusicVideoProductionPolicy(input.productionPolicy || (input.mediaMode ? { strategy: 'code-first', maxGeneratedVideoPercent: input.mediaMode === 'code-images-video' ? 100 : 0 } : null));
  const {
    name, mode = 'director', trackId = null,
    uploadedAudioFilename = null, concept = null,
    videoSettings = {},
  } = input;
  const overscan = normalizeOverscan(input.overscan);
  return {
    id,
    name,
    ...(input.festivalPacket ? { festivalPacket: festivalPacketSchema.parse(input.festivalPacket) } : {}),
    ...(input.makingOfStory ? { makingOfStory: normalizeMakingOfStory(input.makingOfStory) } : {}),
    version: 1,
    parentProjectId: null,
    rootProjectId: null,
    // Cross-domain lineage is distinct from Music Video's own version tree.
    ...(sourceFilm ? { sourceFilm } : {}),
    ...(blender ? { blender: normalizeBlenderRecord(blender) } : {}),
    status: 'draft',
    mode,
    createdAt: now,
    updatedAt: now,
    trackId,
    uploadedAudioFilename,
    ...(input.performanceConditioningSource ? { performanceConditioningSource: input.performanceConditioningSource } : {}),
    concept,
    // #8965 — the reusable visual specification (moodboard/reference assets,
    // palette, typography, camera rules). Null until the director sets one.
    visualSpec: input.visualSpec ? normalizeVisualSpec(input.visualSpec) : null,
    ...(input.styleReferences ? { styleReferences: input.styleReferences } : {}),
    videoSettings: normalizeVideoSettings(videoSettings),
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
    ...(typeof input.lyricOverlayEnabled === 'boolean' ? { lyricOverlayEnabled: input.lyricOverlayEnabled } : {}),
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
    // A code-first project authors a document; a footage project composes its shots.
    composition: input.composition || input.mediaMode ? withStoredCompositionDocument(normalizeComposition(input.composition
      || { mode: productionPolicy.strategy === 'code-first' ? 'document' : 'composed' }), null) : null,
    // #8988 — optional sound-design bed mixed under the song.
    soundBed: input.soundBed ? normalizeSoundBed(input.soundBed) : null,
    // Audio files placed over the song on the editor timeline (audioLayers.js).
    ...(Array.isArray(input.audioLayers) && input.audioLayers.length ? { audioLayers: normalizeAudioLayers(input.audioLayers) } : {}),
    // The finishing film look every preview, render and baked still is viewed through; null = none.
    filmLook: input.filmLook ? normalizeFilmLook(input.filmLook) : null,
    // Stamp restrained defaults onto new videos while leaving legacy records without `templateEffects` untouched.
    templateEffects: input.templateEffects === null
      ? null
      : normalizeTemplateEffects({ ...DEFAULT_NEW_PROJECT_TEMPLATE_EFFECTS, ...input.templateEffects }),
    ...(overscan != null ? { overscan } : {}),
    // The handmade medium (stepped holds, compositor-only lettering); null = none.
    ...(normalizeProductionMedium(input.productionMedium) ? { productionMedium: normalizeProductionMedium(input.productionMedium) } : {}),
    // The opening title card (song, artist, year over the opener); null = none.
    titleCard: normalizeTitleCard(input.titleCard),
    // The cutting room floor outro after the song; null = off.
    statsOutro: normalizeStatsOutro(input.statsOutro),
    // The film credits after the song (and after the floor); null = never set up.
    creditsOutro: normalizeCreditsOutro(input.creditsOutro),
    // #8980 — optional pre-production treatment (brief, arc, shot direction,
    // proof checklist); null until the director starts one. See treatment.js.
    treatment: null,
    mediaMode: musicVideoMediaMode(input),
    productionPolicy,
    scenes: [],
    renderHistoryId: null,
    renderError: null,
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
  variant = 'revision',
  blenderFilm = false,
}) {
  // Record metadata is independently editable; only immutable asset bytes are shared.
  source = structuredClone(source);
  const videoVariant = variant === 'video-generation';
  if (videoVariant) includeGeneratedMedia = false;
  const nameMatch = typeof source.name === 'string' ? source.name.match(/^(.*?)(?:\s+v(\d+))?$/i) : null;
  const inferredVersion = Number(nameMatch?.[2]) || 1;
  const sourceVersion = Number.isInteger(source.version) && source.version > 0
    ? source.version
    : inferredVersion;
  const version = sourceVersion + 1;
  const baseName = nameMatch?.[1]?.trim() || source.name || 'Music Video';
  const sceneIdMap = new Map();
  const scenes = (source.scenes || []).map(({ imageTreatments, ...scene }, order) => ({
    ...scene,
    sceneId: mintCloneSceneId(scene, sceneIdMap),
    order,
    referenceImageId: includeGeneratedMedia ? (scene.referenceImageId ?? null) : null,
    videoHistoryId: includeGeneratedMedia ? (scene.videoHistoryId ?? null) : null,
    endImageId: includeGeneratedMedia ? (scene.endImageId ?? null) : null,
    ...(includeGeneratedMedia && imageTreatments !== undefined ? { imageTreatments } : {}),
    ...(scene.photoSequence ? { photoSequence: includeGeneratedMedia ? scene.photoSequence : { ...scene.photoSequence, enabled: false, imageIds: [], ...(scene.photoSequence.layouts ? { layouts: [] } : {}) } } : {}),
    // Takes are immutable pointers to shared media, so a media-keeping clone
    // carries the whole candidate history; a clean clone starts empty.
    takes: includeGeneratedMedia ? ensureSceneTakes(scene, now) : [],
  }));
  for (const scene of scenes) scene.takes = scene.takes.map((take) => ({ ...take,
    ...(take.dependencies ? { dependencies: remapMusicVideoDependencies(take.dependencies, sceneIdMap) } : {}),
    ...(take.frameDependencies ? { frameDependencies: remapMusicVideoDependencies(take.frameDependencies, sceneIdMap) } : {}),
  }));
  const mediaReady = includeGeneratedMedia
    && scenes.length > 0
    && scenes.every((scene) => scene.referenceImageId && scene.videoHistoryId);

  const clone = {
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
    ...(source.composition ? { composition: {
      ...source.composition,
      ...(source.composition.codeVideo ? { codeVideo: { ...source.composition.codeVideo,
        sections: source.composition.codeVideo.sections.map((section) => ({ ...section, id: sceneIdMap.get(section.id) ?? section.id })),
      } } : {}),
      ...(source.composition.reactiveSections ? { reactiveSections: source.composition.reactiveSections.map((section) => ({
        ...section, sectionId: sceneIdMap.get(section.sectionId) ?? section.sectionId,
      })) } : {}),
      ...(source.composition.grade ? { grade: { ...source.composition.grade, sections: (source.composition.grade.sections || []).map((section) => ({
        ...section, sceneId: sceneIdMap.get(section.sceneId) ?? section.sceneId,
      })) } } : {}),
    } } : {}),
    // #8980 — the treatment's shot directions follow the scenes to
    // their new ids.
    treatment: source.treatment ? remapTreatmentForClone(source.treatment, sceneIdMap, {
      sourceScenesFingerprint: scenesFingerprint(source.scenes || []),
      cloneScenesFingerprint: scenesFingerprint(scenes),
    }) : null,
    // #8987 — a draft's section map follows the scenes to their new ids, so a
    // clone can still revise from the review notes it carried over (#8986).
    ...(Array.isArray(source.excerpts) ? {
      // A running encoder belongs only to the source project. Copying its
      // partial-file ownership would let clone recovery delete that output.
      excerpts: source.excerpts.filter((excerpt) => excerpt?.status !== 'rendering').map((excerpt) => (Array.isArray(excerpt?.sections)
        ? { ...excerpt, dependencies: remapMusicVideoDependencies(excerpt.dependencies, sceneIdMap), sections: excerpt.sections.map((s) => ({ ...s, sceneId: sceneIdMap.get(s.sceneId) ?? s.sceneId })) }
        : excerpt)),
    } : {}),
    // A revision is in-progress work against the SOURCE's takes; the clone
    // starts with none (its carried-over notes can open a fresh one).
    revisions: [],
    songRevision: null,
    songRevisionHistory: [...(source.songRevisionHistory || []), ...(source.songRevision ? [source.songRevision] : [])],
    audioTimingRevisions: [],
    // #9102: an auto-review run is tied to the SOURCE's revisions/excerpts, so a
    // clone starts with none (terminal runs too — their links are source-scoped).
    ...(Array.isArray(source.autoReviews) ? { autoReviews: [] } : {}),
    // #9066: a production run executes against the SOURCE's scenes and jobs.
    ...(Array.isArray(source.productionRuns) ? { productionRuns: [] } : {}),
    // An autonomous run executes against the SOURCE's audio, board and production.
    ...(source.autonomousRun ? { autonomousRun: null } : {}),
    // Development artifacts ride along as-is: every version is an immutable
    // file, so the clone points at the same bytes (devArtifacts.js). The Cast
    // & Sets check-in keeps its direction and images, but its dispatch pin and
    // production link belong to the source — a working stage reads as
    // interrupted on the clone and can be resumed there.
    productionReview: source.productionReview ? { feedback: source.productionReview.feedback || [], reviewedRevisions: source.productionReview.reviewedRevisions || {}, draft: { ...source.productionReview.draft, timingStatus: 'provisional',
      storyboard: (source.productionReview.draft?.storyboard || []).map(shot => ({ ...shot, sceneId: sceneIdMap.get(shot.sceneId) || shot.sceneId })),
      ...(videoVariant ? { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null } : {}),
    }, approvals: {}, proof: null } : null,
    ...(source.castAndSets ? { castAndSets: { ...source.castAndSets, processId: null, productionRunId: null } } : {}),
    // A Blender film's settings carry over. When the service copied the film's scripts and synced
    // manifest into the clone's own workspace (`blenderFilm`), its shots stay mapped to the cloned
    // scenes; otherwise the workspace, and so the mapping, is the source's own. The director's
    // notes and the renders they are about stay with the source either way.
    ...(source.blender ? { blender: {
      settings: source.blender.settings,
      ...(blenderFilm && !videoVariant ? {
        sceneMap: Object.fromEntries(Object.entries(source.blender.sceneMap || {})
          .filter(([, sceneId]) => sceneIdMap.has(sceneId)).map(([shotId, sceneId]) => [shotId, sceneIdMap.get(sceneId)])),
        syncedAt: source.blender.syncedAt ?? null,
        manifestHash: source.blender.manifestHash ?? null,
      } : {}),
    } } : {}),
    renderHistoryId: null,
    renderError: null,
    renderDependencies: null,
    // Publishing outputs and posted URLs belong to the source final render.
    ...(source.publishKit ? { publishKit: null } : {}),
    ...(source.dcpExports ? { dcpExports: [] } : {}),
    // Finished outside PortOS describes the source's video; the new version is made here.
    ...(source.finishedOutside ? { finishedOutside: null } : {}),
    // The director's completion mark judged the source's video.
    ...(source.completion ? { completion: null } : {}),
    // #9010: the source's in-flight render mark is not the clone's.
    renderingOn: null,
    renderPartialFilename: null,
    renderResume: null,
    renderAudioRevision: null,
    deleted: false,
    deletedAt: null,
  };
  if (!videoVariant) return clone;
  // A footage adaptation starts with the same song and storyboard, but no
  // procedural approvals, selected takes or running work. Nothing is dispatched.
  const footageDirection = (direction) => ({ ...direction, route: 'generated',
    medium: 'generated-footage', mediumPinned: false, mediumRationale: '' });
  return {
    ...clone,
    mediaMode: 'code-images-video',
    composition: { ...clone.composition, mode: 'composed' },
    productionPolicy: normalizeMusicVideoProductionPolicy({ strategy: 'legacy' }),
    castAndSets: null,
    visualSpec: clone.visualSpec ? { ...clone.visualSpec, references: [], moodBoardId: null } : null,
    // The cast resets, so a loaded character style (which casts the protagonist) does too.
    concept: clone.concept ? { ...clone.concept, subjects: [], moodBoardStyle: '', characterStyleId: null, characterStyle: '' } : null,
    styleReferences: [],
    ...(clone.automation ? { automation: { ...clone.automation, tools: [], moodBoardId: null } } : {}),
    scenes: clone.scenes.map((scene) => ({ ...scene, visualLayer: 'footage',
      ...(scene.direction ? { direction: footageDirection(scene.direction) } : {}),
    })),
    treatment: clone.treatment ? { ...clone.treatment, appliedRevision: null, basis: null,
      shotDirections: clone.treatment.shotDirections.map(footageDirection),
    } : null,
    excerpts: [],
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
  const previousCues = Array.isArray(patch.lyricCues) ? new Map((project.lyricCues || []).map((cue) => [cue.id, cue])) : null;
  const nextLyricCues = previousCues ? normalizeLyricCues(patch.lyricCues).map((cue) => {
    const previous = previousCues.get(cue.id);
    if (previous && previous.text !== cue.text) {
      delete cue.matched;
      delete cue.suspect;
      delete cue.silentWords;
    }
    return cue;
  }) : null;
  const timedPatch = {
    ...patch,
    ...('festivalPacket' in patch ? { festivalPacket: patch.festivalPacket === null ? null : festivalPacketSchema.parse(patch.festivalPacket) } : {}),
    ...('makingOfStory' in patch ? { makingOfStory: patch.makingOfStory === null ? null : normalizeMakingOfStory(patch.makingOfStory) } : {}),
    ...(patch.productionPolicy ? { productionPolicy: normalizeMusicVideoProductionPolicy(patch.productionPolicy, project.productionPolicy) } : {}),
    ...(patch.visualSpec ? { visualSpec: normalizeVisualSpec(patch.visualSpec, project.visualSpec) } : {}),
    // Automation brief merges per sub-field; null clears it.
    ...('automation' in patch ? {
      automation: patch.automation ? normalizeMusicVideoAutomation(patch.automation, project.automation) : null,
    } : {}),
    ...(nextLyricCues ? { lyricCues: nextLyricCues } : {}),
    ...(Array.isArray(patch.lyricMarkers) ? { lyricMarkers: normalizeLyricMarkers(patch.lyricMarkers) }
      : nextLyricCues && project.lyricMarkers?.length ? { lyricMarkers: remapLyricMarkers(project.lyricMarkers, project.lyricCues, nextLyricCues) } : {}),
    ...(Array.isArray(patch.phrases) ? { phrases: normalizePhrases(patch.phrases) } : {}),
    // #8984 — a manifest carrying its `mode` replaces the stored one whole
    // (the editors send the full manifest, so an omitted key clears it); null
    // clears it all. One without `mode` is a partial patch and merges over the
    // stored manifest, so `{ style }` cannot silently reset mode and cutting.
    // The composition document pointer is owned by the import routes: a PATCH
    // that echoes (or omits, or forges) it keeps the stored one.
    ...('composition' in patch ? { composition: withStoredCompositionDocument(normalizeComposition(
      patch.composition && typeof patch.composition === 'object' && !('mode' in patch.composition) && project.composition
        ? { ...project.composition, ...patch.composition } : patch.composition), project.composition) } : {}),
    // #8988 — an explicitly chosen sound-design bed; null clears it.
    ...('soundBed' in patch ? { soundBed: normalizeSoundBed(patch.soundBed) } : {}),
    // Timeline audio layers: moved, re-levelled, muted, renamed or dropped by id; only the upload route adds one.
    ...('audioLayers' in patch ? { audioLayers: applyAudioLayersPatch(project.audioLayers, patch.audioLayers) } : {}),
    // The film look is replaced whole (one bounded record); null clears it.
    ...('filmLook' in patch ? { filmLook: normalizeFilmLook(patch.filmLook) } : {}),
    ...('templateEffects' in patch ? { templateEffects: normalizeTemplateEffects(patch.templateEffects) } : {}),
    ...('overscan' in patch ? { overscan: normalizeOverscan(patch.overscan) } : {}),
    ...(Array.isArray(patch.cameras) ? { cameras: patch.cameras.map((camera) => (
      camera && typeof camera === 'object' && 'filmLook' in camera
        ? { ...camera, filmLook: camera.filmLook == null ? null : normalizeFilmLook(camera.filmLook) }
        : camera
    )) } : {}),
    ...('productionMedium' in patch ? { productionMedium: normalizeProductionMedium(patch.productionMedium) } : {}),
    // The title card is replaced whole (one bounded record); null clears it.
    ...('titleCard' in patch ? { titleCard: normalizeTitleCard(patch.titleCard) } : {}),
    // The outro after the song is replaced whole; null turns it off.
    ...('statsOutro' in patch ? { statsOutro: normalizeStatsOutro(patch.statsOutro) } : {}),
    ...('creditsOutro' in patch ? { creditsOutro: normalizeCreditsOutro(patch.creditsOutro) } : {}),
  };
  // #8988: a bed is mixed UNDER the song — the song itself can't be its bed.
  const masterTrackId = 'trackId' in patch ? patch.trackId : project.trackId;
  const soundBed = 'soundBed' in timedPatch ? timedPatch.soundBed : project.soundBed;
  if (('trackId' in patch || 'soundBed' in timedPatch) && masterTrackId && soundBed?.trackId === masterTrackId) {
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
      videoSettings: normalizeVideoSettings(conceptMergedPatch.videoSettings, project.videoSettings ?? {}),
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
  if ('mediaMode' in patch || patch.visualSpec || patch.styleReferences) assertMusicVideoMediaSelections({ ...project, ...mergedPatch });
  if (!trackChanged) return nextLyricCues ? syncWordAnchoredScenes(project, touchProjectRecord(project, mergedPatch)) : touchProjectRecord(project, mergedPatch);
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
  return touchProjectRecord(project, {
    ...invalidateTimedText(project),
    // Composition cue times and the poster frame were set against the old
    // song too: keep the text, clear the timings (#8984).
    ...(project.composition ? { composition: invalidateCompositionTiming(project.composition) } : {}),
    // A vocal stem is a bounce of the OLD song; conditioning a performance on
    // it against the new master would sing the wrong words (#8977).
    ...(project.vocalStemFilename ? CLEARED_VOCAL_STEM : {}),
    performanceConditioningSource: 'master',
    // Lyric timing belonged to the old audio; its recorded basis goes with it (#14793).
    ...(project.lyricTimingMasterFilename ? { lyricTimingMasterFilename: null } : {}),
    ...mergedPatch,
    ...statusPatch,
    audioAnalysis: null,
    midiTranscription: null,
    ...(project.midiTranscriptionError ? { midiTranscriptionError: null } : {}),
    scenes,
    // A render started against the old song must not settle this project as
    // complete (#15154): it compares the revision it started with on settle.
    audioRevision: audioRevisionOf(project) + 1,
  });
}

/**
 * Cache the offline beat/tempo/section analysis on the project. Flips a `draft`
 * project to `analyzed`; leaves any later status untouched (re-analysis of a
 * ready/rendering project shouldn't regress its lifecycle). The analysis shape
 * is validated so a hand-edited/legacy record can't store a malformed map.
 */
export function setAudioAnalysis(project, analysis, sourceProject) {
  if (sourceProject && (project.trackId !== sourceProject.trackId || project.uploadedAudioFilename !== sourceProject.uploadedAudioFilename)) {
    throw new ServerError('The audio changed during analysis. Analyze the selected master again.', { status: 409, code: 'MUSIC_VIDEO_AUDIO_CHANGED' });
  }
  const validated = musicVideoAudioAnalysisSchema.parse(analysis);
  const status = project.status === 'draft' ? 'analyzed' : project.status;
  return touchProjectRecord(project, { audioAnalysis: validated, status });
}

/**
 * Replace the analysis's section list with the director's edited map. Beats,
 * tempo and features stay; scenes tied to a section follow the new map, and the
 * treatment's basis (which fingerprints the analysis) goes stale so it is
 * recompiled against the edited arc.
 */
export function setAnalysisSections(project, sections) {
  const analysis = project.audioAnalysis;
  if (!analysis) throw new ServerError('Analyze the song before editing its sections', { status: 422, code: 'NOT_ANALYZED' });
  const edited = applyEditedSections(sections, analysis.sections, analysis.durationSec);
  return touchProjectRecord(project, {
    audioAnalysis: musicVideoAudioAnalysisSchema.parse({ ...analysis, sections: edited }),
    scenes: remapScenesToSections(project.scenes, edited),
  });
}

/**
 * Cache the MuScriptor audio → MIDI transcription pointer on the project (a
 * .mid basename under /api/uploads). Validated so a hand-edited/legacy record
 * can't store a malformed pointer; doesn't touch the lifecycle status — the
 * MIDI is a parsing artifact, not an arrangement step.
 */
export function setMidiTranscription(project, midi) {
  const validated = musicVideoMidiTranscriptionSchema.parse(midi);
  return touchProjectRecord(project, {
    midiTranscription: validated,
    ...(project.midiTranscriptionError ? { midiTranscriptionError: null } : {}),
  });
}

/**
 * Load-time read of a stored record: take prompts unpacked from the record's
 * line pool (#16210, `takePromptPool.js`), then the repair for a project whose
 * scenes drifted out of time order (#16117). The repair reorders only; labels,
 * times and selections are untouched, and every review binding that held before still holds: the bases hash `scenes`
 * by position, and the repair moves no shot in the cut, so it must not stale
 * an approval, the rendered proof or the treatment. Pure and idempotent, with
 * `updatedAt` left alone, so the stores run it on every load.
 */
export function afterLoad(stored) {
  const project = unpackTakePrompts(stored);
  const scenes = sceneListInTimeOrder(project?.scenes);
  if (scenes === project?.scenes) return project;
  return carryReviewThroughSceneOrder(project, carryTreatmentThroughSceneOrder(project, { ...project, scenes }));
}

/**
 * Write-time clean-up both stores run on every persisted record (#16210): a
 * review record from before slim snapshots shrinks at its next write. Reads
 * never call it, so a pure read neither rewrites the record nor moves
 * `updatedAt`; readers tolerate both shapes. Idempotent, and it leaves every
 * approval as it was. It also re-stamps an accepted legacy frame cast fingerprint to the canonical
 * value (#16375).
 */
export function beforeSave(project) {
  return restampLegacyFrameCasts(slimProjectReview(project));
}

/**
 * The bytes both stores write, from the `beforeSave` record (#16210): take
 * prompts packed into the record's line pool. Only the write sees this shape;
 * the stores return the unpacked record and `afterLoad` unpacks on every read.
 */
export function toStored(project) {
  return packTakePrompts(project);
}

/**
 * "Vary wipes": a wipe out of each of `count` shots from `fromSceneId` in song
 * order, no style twice in a row (nor the wipe out of the shot before the run),
 * each replacing that shot's glitch out. The last shot has no cut out and is
 * skipped. Returns `{ project, scenes }`, `scenes` the changed shots.
 */
// projectDbStore reaches this through the injected `logic` namespace, so no file
// imports the name from here and a word scan cannot see the caller.
export { mirrorTimestamp };

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
/**
 * An older peer rebuilds takes from an explicit field list and drops the take
 * fields it predates: `castInputs` and a "Still matches" for an older character
 * reference (`characterReferenceAcceptance`, #16473). Copy each back onto a take
 * that peer still sends, before newest `updatedAt` wins, so the loss is not
 * written back. A take the peer omitted entirely stays omitted. A body that
 * includes a field keeps its own value.
 */
const PEER_PRESERVED_TAKE_FIELDS = ['castInputs', 'characterReferenceAcceptance'];

function preserveOmittedTakeFields(local, remote) {
  const kept = new Map();
  for (const scene of local?.scenes || []) {
    if (!scene?.sceneId || !Array.isArray(scene.takes)) continue;
    for (const take of scene.takes) {
      const fields = take?.takeId ? PEER_PRESERVED_TAKE_FIELDS.filter((field) => Object.hasOwn(take, field)) : [];
      if (fields.length) kept.set(`${scene.sceneId}\0${take.takeId}`, Object.fromEntries(fields.map((field) => [field, take[field]])));
    }
  }
  if (!kept.size || !Array.isArray(remote.scenes)) return remote;
  let scenesChanged = false;
  const scenes = remote.scenes.map((scene) => {
    if (!scene?.sceneId || !Array.isArray(scene.takes)) return scene;
    let takesChanged = false;
    const takes = scene.takes.map((take) => {
      const local = take?.takeId ? kept.get(`${scene.sceneId}\0${take.takeId}`) : null;
      const missing = local ? Object.keys(local).filter((field) => !Object.hasOwn(take, field)) : [];
      if (!missing.length) return take;
      takesChanged = true;
      return { ...take, ...Object.fromEntries(missing.map((field) => [field, structuredClone(local[field])])) };
    });
    if (!takesChanged) return scene;
    scenesChanged = true;
    return { ...scene, takes };
  });
  return scenesChanged ? { ...remote, scenes } : remote;
}

export function mergeProjectRecord(local, remoteRaw) {
  let remote = sanitizeProjectForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  // An older peer can still send the fields that newer peers strip. Project
  // sync remains schema-v1 compatible, so apply the same projection inbound
  // before either inserting or restoring this machine's local choices.
  remote = stripMusicVideoLocalRenderPins(remote);
  // A v51-v53 sender still pushes `previz.night` and bike pawn colors, which this
  // install's strict previz schema rejects on the next edit (migration 459).
  remote = migrateMusicVideoPreviz(remote);
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  // Render pins are install-capability choices and therefore wire-local
  // (#3245). sanitizeRecordForWire omits them from peer payloads; restore this
  // machine's values before a newer remote record wholesale-replaces local.
  // Key-presence checks preserve an intentional local empty/null value instead
  // of confusing it with a missing field.
  remote = { ...remote };
  // Pre-packet peers can omit the optional field; absence must not erase edits.
  if (!Object.hasOwn(remote, 'festivalPacket') && Object.hasOwn(local, 'festivalPacket')) remote.festivalPacket = local.festivalPacket;
  if (!Object.hasOwn(remote, 'makingOfStory') && Object.hasOwn(local, 'makingOfStory')) remote.makingOfStory = local.makingOfStory;
  if (Object.hasOwn(local, 'imageMode')) remote.imageMode = local.imageMode;
  if (Object.hasOwn(local, 'imageModelId')) remote.imageModelId = local.imageModelId;
  // #9066: this install's production-run checkpoint survives a newer remote.
  if (Object.hasOwn(local, 'productionRuns')) remote.productionRuns = local.productionRuns;
  // Development artifacts and the Cast & Sets checkpoint are wire-local too:
  // their files and jobs exist only on this install.
  if (Object.hasOwn(local, 'devArtifacts')) remote.devArtifacts = local.devArtifacts;
  delete remote.productionReview;
  if (Object.hasOwn(local, 'productionReview')) remote.productionReview = local.productionReview;
  if (Object.hasOwn(local, 'castAndSets')) remote.castAndSets = local.castAndSets;
  if (Object.hasOwn(local, 'autonomousRun')) remote.autonomousRun = local.autonomousRun;
  if (Object.hasOwn(local, 'renderError')) remote.renderError = local.renderError;
  // Song revisions hold this install's paid-generation recovery checkpoint,
  // candidate files and provenance; an unrelated peer edit must not erase them.
  if (Object.hasOwn(local, 'songRevision')) remote.songRevision = local.songRevision;
  if (Object.hasOwn(local, 'songRevisionHistory')) remote.songRevisionHistory = local.songRevisionHistory;
  // A Blender film's workspace, and so its settings, scene map and notes, exist only here.
  if (Object.hasOwn(local, 'blender')) remote.blender = local.blender;
  // The composition document's files live only on this install as well
  // (compositionDocument.js), so its pointer survives a newer remote body.
  if (local.composition?.document || local.composition?.documentDraft) {
    const sharedComposition = remote.composition && typeof remote.composition === 'object' && !Array.isArray(remote.composition)
      ? remote.composition : {};
    remote.composition = {
      ...sharedComposition,
      ...(local.composition.document ? { document: local.composition.document } : {}),
      ...(local.composition.documentDraft ? { documentDraft: local.composition.documentDraft } : {}),
    };
  }
  remote = preserveOmittedTakeFields(local, remote);
  if (local.videoSettings && typeof local.videoSettings === 'object'
    && !Array.isArray(local.videoSettings) && ['backend', 'renderPool'].some((key) => Object.hasOwn(local.videoSettings, key))) {
    const remoteVideoSettings = remote.videoSettings && typeof remote.videoSettings === 'object'
      && !Array.isArray(remote.videoSettings) ? remote.videoSettings : {};
    remote.videoSettings = { ...remoteVideoSettings,
      ...Object.fromEntries(['backend', 'renderPool'].filter((key) => Object.hasOwn(local.videoSettings, key)).map((key) => [key, local.videoSettings[key]])) };
  }
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  // An older peer may omit the baseline. Carry it only for exactly matching
  // evidence of the same export, from our pre-merge record rather than its edits.
  const next = remoteWins ? retainLegacyFinalLayerBaseline(local, remote) : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}
