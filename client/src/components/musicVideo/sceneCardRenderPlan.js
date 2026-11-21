import { getHiggsfieldVideoModel, HIGGSFIELD_DEFAULT_VIDEO_MODEL } from '../../../../server/lib/higgsfieldVideoModels.js';
import { getGoogleVideoModel, GOOGLE_DEFAULT_VIDEO_MODEL } from '../../../../server/lib/googleVideoModels.js';
import { musicVideoGreyboxReference } from '../../../../server/lib/musicVideo/musicVideoGreybox.js';
import { sceneRenderTierChoices } from '../../../../server/lib/musicVideo/musicVideoRenderTier.js';
import { musicVideoClipConditioningReferences, musicVideoClipReferenceCapacity, musicVideoClipReferenceChoices, musicVideoSceneCastIds } from '../../../../server/lib/musicVideo/musicVideoConditioning.js';
import { LTX_REFERENCES_GENERATION_MODE, isLtx25Model, ltxReferenceSheetPrefix, ltxReferencesUnavailableReason } from '../../lib/musicVideoLtxReferences.js';
import { storyboardClipOffered } from './SceneStoryboardClip.jsx';
import { falSceneTake, isPerformanceScene, planPerformanceRepair, runwaySceneTake } from '../../lib/musicVideoShotTiming.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import { getRunwayVideoModel } from '../../lib/runwayVideoModels.js';
import { buildSceneTimingPresentation } from '../../lib/musicVideoSceneTiming.js';
import { sceneEndFramePlanFor } from './SceneEndFrame.jsx';
import { renderTargetOverrides } from './SceneRenderTarget.jsx';
import { shotCardRenderRequest, shotCardRequestProblem } from './SceneRenderInputs.jsx';
import { videoGenerationRefusal } from './sceneCardProps.js';

function resolveReferenceModel(referenceBackend, { scene, renderSettings, videoModels, defaultVideoModel }) {
  if (referenceBackend === 'fal') return getFalVideoModel(falSceneTake({ scene, videoSettings: renderSettings || {} }).modelId);
  if (referenceBackend === 'runway') return getRunwayVideoModel(runwaySceneTake({ scene, videoSettings: renderSettings || {} }).modelId);
  if (referenceBackend === 'higgsfield') return getHiggsfieldVideoModel(renderSettings?.higgsfieldModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL);
  if (referenceBackend === 'google') return getGoogleVideoModel(renderSettings?.googleModelId || GOOGLE_DEFAULT_VIDEO_MODEL);
  if (referenceBackend === 'local') return videoModels.find((model) => model.id === (renderSettings?.modelId || defaultVideoModel)) || null;
  return null;
}

function computeLtxReferenceState({ scene, layer, performance, referenceBackend, referenceModel, renderSettings, renderInputs, storyboardDefault }) {
  const ltxReferencesAvailable = !performance && referenceBackend === 'local' && isLtx25Model(referenceModel)
    && renderSettings?.generationMode !== 'audioReactive';
  const canUseLtxReferences = ltxReferencesAvailable && !storyboardDefault;
  const ltxReferencesGreyboxBlocked = !!scene.setReference?.greyboxShotId;
  // The project's LTX 2.5 References mode makes the box default on; unticking is this shot's override.
  const ltxReferencesProjectDefault = renderSettings?.generationMode === LTX_REFERENCES_GENERATION_MODE && !ltxReferencesGreyboxBlocked;
  // Say why References is not offered instead of hiding the option, but only where
  // LTX is in play: on Grok, fal or Runway the shot sends its own references.
  const ltxReferencesRelevant = referenceBackend === 'local' || renderSettings?.generationMode === LTX_REFERENCES_GENERATION_MODE;
  const ltxReferencesReason = layer === 'footage' && !canUseLtxReferences && ltxReferencesRelevant
    ? ltxReferencesUnavailableReason({
      performance, backend: referenceBackend, model: referenceModel,
      audioReactive: renderSettings?.generationMode === 'audioReactive', storyboardDefault,
    })
    : null;
  // References the director picked turn the box on. Auto cast does not, since it
  // costs the shot its song audio. Unticking, or asking for song audio or an end frame, wins.
  const ltxReferencesPicked = !ltxReferencesGreyboxBlocked && scene.clipReferenceIds?.length > 0;
  const useLtxReferences = canUseLtxReferences && (renderInputs.ltxReferences ?? (ltxReferencesProjectDefault || ltxReferencesPicked));
  return { canUseLtxReferences, ltxReferencesGreyboxBlocked, ltxReferencesProjectDefault, ltxReferencesReason, useLtxReferences };
}

function computeReferenceRefusal({
  clipReferenceSaveState, guidesPending, guidesFailed, missingReference,
  useLtxReferences, ltxReferencesGreyboxBlocked, selectedClipReferences, cardRequest,
}) {
  if (clipReferenceSaveState === 'saving') return 'Saving clip references…';
  if (clipReferenceSaveState === 'failed') return 'Save the clip references before rendering';
  if (guidesPending) return 'Cast guides are still loading';
  if (guidesFailed) return 'Cast guides could not be loaded';
  if (missingReference) return 'A selected clip reference is unavailable';
  if (useLtxReferences && ltxReferencesGreyboxBlocked) return 'Clear the greybox reference before using LTX reference images';
  if (useLtxReferences && !selectedClipReferences.length) return 'Choose at least one clip reference';
  if (useLtxReferences && !cardRequest.authored?.trim()) return 'Add a shot prompt first';
  return null;
}

function computeClipJobsState(videoJobs, generatingVideo, generatingFrame, videoProgress) {
  // Every clip in flight for this shot, each with where it renders. A render whose
  // request is still on its way has no job yet: Render waits for it, so a double tap
  // can't send the same (possibly paid) render twice.
  const clipJobs = Array.isArray(videoJobs)
    ? videoJobs
    : generatingVideo ? [{ key: 'clip', label: null, running: !!videoProgress, progress: videoProgress?.progress ?? null }] : [];
  const sendingClip = clipJobs.some((job) => job.key !== 'clip' && !job.jobId);
  const clipLane = clipJobs.length > 1 ? `${clipJobs.length} clips` : 'Clip';
  const generatingLane = generatingFrame && generatingVideo
    ? `Frame + ${clipLane.toLowerCase()}`
    : generatingFrame ? 'Frame' : generatingVideo ? clipLane : null;
  return { clipJobs, sendingClip, generatingLane };
}

function computeClipConditioning({ project, scene, castMedia, referenceBackend, referenceModel, cardRequest, useLtxReferences, storyboardDefault, renderInputs }) {
  // Most Runway models cannot mix keyframes with references, so an end frame sends none there.
  const runwayEndFrameOn = referenceBackend === 'runway' && cardRequest.endFrame?.state === 'on';
  const endFrameBlocksReferences = runwayEndFrameOn && !!referenceModel?.referenceImages && !referenceModel.referenceImages.keepsFrames;
  // Grok can take the start frame as a layout reference instead of the locked opening frame,
  // so the people it shows can take the clip references' likeness.
  const startFrameLayout = referenceBackend === 'grok' && !storyboardDefault && renderInputs.startFrameLayout === true;
  // Higgsfield sends a frame plus sheets as the first reference image; ticking this renders plain image-to-video instead.
  const higgsfieldFrameOnly = referenceBackend === 'higgsfield' && renderInputs.frameRoute === 'image';
  const referenceCapacity = useLtxReferences ? 8 : musicVideoClipReferenceCapacity(referenceBackend, referenceModel, { endFrame: runwayEndFrameOn, startFrameLayout });
  const castIds = referenceCapacity > 0 && castMedia ? musicVideoSceneCastIds(project, scene) : [];
  const guidesPending = castIds.some((id) => castMedia[id] === undefined);
  // A failed read (null) would otherwise send the clip without the member's guides.
  const guidesFailed = castIds.some((id) => castMedia[id] === null);
  const availableReferences = musicVideoClipReferenceChoices(project, scene, castMedia);
  const selectedClipReferences = musicVideoClipConditioningReferences(project, scene, castMedia, { limit: referenceCapacity });
  const referenceLabels = selectedClipReferences.map((ref) => ref.label || ref.role || 'visual reference');
  const referenceSheetPrefix = ltxReferenceSheetPrefix(referenceLabels);
  const previewRequest = useLtxReferences ? {
    ...cardRequest,
    prompt: `${referenceSheetPrefix}${cardRequest.prompt}`,
    promptAdditions: [{ id: 'ltx-reference-sheet', label: 'Reference sheet', text: referenceSheetPrefix.trim() }, ...cardRequest.promptAdditions],
  } : cardRequest;
  const missingReference = referenceCapacity > 0 && Array.isArray(scene.clipReferenceIds)
    && scene.clipReferenceIds.some((id) => !availableReferences.some((ref) => ref.id === id));

  return {
    runwayEndFrameOn, endFrameBlocksReferences, startFrameLayout, higgsfieldFrameOnly,
    referenceCapacity, guidesPending, guidesFailed, selectedClipReferences,
    referenceLabels, referenceSheetPrefix, previewRequest, missingReference,
  };
}

function buildSceneVideoPayload({
  cardRequest, useLtxReferences, canUseLtxReferences, ltxReferencesProjectDefault,
  referenceSheetPrefix, selectedClipReferences, referenceLabels, songAudioField,
  startFrameLayout, higgsfieldFrameOnly, renderOverrides, tier,
}) {
  const { endFrame, wholeLine } = cardRequest;
  const card = {
    prompt: useLtxReferences ? `${referenceSheetPrefix}${cardRequest.authored}` : cardRequest.authored,
    ...(endFrame ? { endFrame: endFrame.state === 'on' } : {}),
    ...(wholeLine?.state === 'on' ? { wholeLine: true } : {}),
    expectedClipReferenceFiles: selectedClipReferences.map((ref) => ref.imageId),
    ...songAudioField,
    ...(useLtxReferences ? { ltxReferences: true, songAudio: false, endFrame: false, expectedClipReferenceLabels: referenceLabels }
      : canUseLtxReferences && ltxReferencesProjectDefault ? { ltxReferences: false } : {}),
    ...(startFrameLayout ? { startFrameLayout: true } : {}),
    ...(higgsfieldFrameOnly ? { frameRoute: 'image' } : {}),
  };
  return { ...(renderOverrides ? { target: renderOverrides } : {}), card, ...(tier ? { tier } : {}) };
}

/**
 * Pure render-planning computation for SceneCard: resolves the target renderer,
 * timing/pricing, LTX and clip references, preview request, refusal reasons,
 * and payload builders.
 */
export function buildSceneRenderPlan({
  scene, project, layer, position, composition, media, actions,
  renderPick, renderOptions, renderInputs, sourceNotice,
  greyboxSaving, speakerDirty, speakerSaving, clipReferenceSaveState,
}) {
  const { falVideoSettings, videoModels, defaultVideoModel, lipSyncBackend, castMedia, greyboxPlaces } = media;
  const perfScene = isPerformanceScene(scene);
  const renderOverrides = renderTargetOverrides(renderPick, falVideoSettings || {}, renderOptions, {
    models: videoModels, defaultModel: defaultVideoModel, performance: perfScene, scene, scenes: project?.scenes,
  });
  const renderSettings = renderOverrides ? { ...falVideoSettings, ...renderOverrides } : falVideoSettings;
  const greybox = musicVideoGreyboxReference(project, scene, greyboxPlaces);
  const renderLane = renderOverrides
    ? (renderSettings.backend === 'local' && renderSettings.generationMode === 'audioReactive' ? 'local' : renderSettings.backend)
    : lipSyncBackend;
  const lineCues = perfScene && renderInputs.wholeLine === true ? project?.lyricCues || [] : null;
  const timing = buildSceneTimingPresentation({
    scene, layer, lipSyncBackend: renderLane, songDurationSec: composition.songDurationSec, falVideoSettings: renderSettings,
    nextEndSec: position.nextEndSec, isLast: position.isLast, manifestOwnsShots: composition.manifestOwnsShots, hasMergeNext: !!actions.onMergeNext,
    prevStartSec: position.prevStartSec, isFirst: position.index === 0, hasMergePrevious: !!actions.onMergePrevious,
    lineCues, project,
  });
  const { performance, capability, performanceBlocked, performanceCost } = timing;
  const repairPlan = planPerformanceRepair({
    scene, temporal: media.performanceReview?.shot,
    excerptStartSec: media.performanceReview?.excerptStartSec, backend: lipSyncBackend, videoSettings: falVideoSettings || {},
  });
  const endFramePlan = sceneEndFramePlanFor(scene, renderSettings || {}, { models: videoModels, defaultModel: defaultVideoModel });
  const peerPool = ['both', 'peers'].includes(renderSettings?.renderPool?.mode);
  const referenceBackend = peerPool ? 'remote' : renderSettings?.backend || renderLane;
  const referenceModel = resolveReferenceModel(referenceBackend, { scene, renderSettings, videoModels, defaultVideoModel });
  // Storyboard-to-clip chaining cannot yet pass LTX reference inputs. Offer
  // them after the storyboard's first frame has landed instead.
  const storyboardDefault = storyboardClipOffered({ scene, layer, performance });
  const ltx = computeLtxReferenceState({ scene, layer, performance, referenceBackend, referenceModel, renderSettings, renderInputs, storyboardDefault });
  const { canUseLtxReferences, ltxReferencesGreyboxBlocked, ltxReferencesProjectDefault, useLtxReferences } = ltx;

  // Exactly what Render sends: the prompt as typed and the inputs the card toggles.
  const cardRequest = shotCardRenderRequest({
    project, scene, castMedia, greybox, settings: renderSettings || {}, performance, endFramePlan,
    models: videoModels, defaultModel: defaultVideoModel,
    inputs: useLtxReferences ? { ...renderInputs, songAudio: false, endFrame: false } : renderInputs,
    plan: timing.plan,
  });
  const cond = computeClipConditioning({
    project, scene, castMedia, referenceBackend, referenceModel, cardRequest,
    useLtxReferences, storyboardDefault, renderInputs,
  });

  // Hosted cutaways cannot use the Local project's supplied-audio default. Preserve
  // an unknown Local model and required performance/audio-reactive inputs for the server to validate.
  const songAudioState = cardRequest.songAudio.state;
  const silentHostedCutaway = !performance && songAudioState === 'unavailable'
    && ['grok', 'fal', 'runway', 'gemini'].includes(renderSettings?.backend);
  const songAudioField = songAudioState === 'on' || songAudioState === 'off' || silentHostedCutaway
    ? { songAudio: songAudioState === 'on' } : {};
  const greyboxRefusal = greyboxSaving ? 'Saving greybox reference…' : greybox?.error;
  const refusalInputs = {
    settingsSaving: media.settingsSaving,
    speakerUnsaved: performance && (speakerDirty || speakerSaving),
    referenceImageId: scene.referenceImageId,
    performanceBlocked,
    videoBlockedReason: renderOverrides && media.videoBlockedReasonFor ? media.videoBlockedReasonFor(renderSettings) : media.videoBlockedReason,
  };
  const otherRefusal = videoGenerationRefusal(refusalInputs) || shotCardRequestProblem(cardRequest);
  const referenceRefusal = computeReferenceRefusal({
    clipReferenceSaveState, guidesPending: cond.guidesPending, guidesFailed: cond.guidesFailed, missingReference: cond.missingReference,
    useLtxReferences, ltxReferencesGreyboxBlocked, selectedClipReferences: cond.selectedClipReferences, cardRequest,
  });
  const videoRefusal = sourceNotice || greyboxRefusal || referenceRefusal || otherRefusal;
  const jobs = computeClipJobsState(media.videoJobs, media.generatingVideo, media.generatingFrame, media.videoProgress);
  const renderBlocked = !!videoRefusal || jobs.sendingClip;
  const storyboardRefusal = storyboardDefault
    ? sourceNotice || greyboxRefusal || referenceRefusal || videoGenerationRefusal({ ...refusalInputs, needsStill: false })
    : null;
  const renderCost = performance ? performanceCost : timing.falCost;
  const tierChoices = layer === 'footage' && !storyboardDefault ? sceneRenderTierChoices(renderLane, {
    scene, scenes: project?.scenes, videoSettings: falVideoSettings || {}, override: renderOverrides,
    songDurationSec: composition.songDurationSec, lineCues,
  }) : null;
  const tierPriced = !timing.sharedNotice && timing.coverageSpan == null;

  const buildVideoPayload = (tier = null) => buildSceneVideoPayload({
    cardRequest, useLtxReferences, canUseLtxReferences, ltxReferencesProjectDefault,
    referenceSheetPrefix: cond.referenceSheetPrefix, selectedClipReferences: cond.selectedClipReferences,
    referenceLabels: cond.referenceLabels, songAudioField,
    startFrameLayout: cond.startFrameLayout, higgsfieldFrameOnly: cond.higgsfieldFrameOnly, renderOverrides, tier,
  });

  return {
    renderOverrides, renderSettings, renderLane, timing, performance, capability, performanceBlocked,
    repairPlan, endFramePlan, referenceBackend, referenceModel, storyboardDefault,
    ...ltx, cardRequest, ...cond, songAudioField,
    videoRefusal, renderBlocked, storyboardRefusal, renderCost, tierChoices, tierPriced,
    ...jobs, buildVideoPayload,
  };
}
