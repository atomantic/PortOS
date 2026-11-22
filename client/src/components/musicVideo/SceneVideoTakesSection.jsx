import { Activity, Clapperboard, Shuffle, Video } from 'lucide-react';
import { shotDownloadBasis } from '../../../../server/lib/musicVideo/musicVideoShotDownloadBasis.js';
import { isPreMusicShot } from '../../../../server/lib/musicVideo/musicVideoColdOpen.js';
import { formatUsd } from '../../utils/formatters.js';
import { grokSceneRequestDuration } from '../../lib/musicVideoShotTiming.js';
import { isLowResVideo } from '../../lib/videoResolution.js';
import CastGuidesRetry from './CastGuidesRetry.jsx';
import PerformanceEvidence from './PerformanceEvidence.jsx';
import SceneCameraControls from './SceneCameraControls.jsx';
import SceneClipLength from './SceneClipLength.jsx';
import SceneClipPreview from './SceneClipPreview.jsx';
import SceneClipReferences from './SceneClipReferences.jsx';
import SceneClipTiming from './SceneClipTiming.jsx';
import SceneFinalApproval from './SceneFinalApproval.jsx';
import SceneFrameFit from './SceneFrameFit.jsx';
import SceneImageEffect from './SceneImageEffect.jsx';
import ScenePicturePreview from './ScenePicturePreview.jsx';
import ScenePoster from './ScenePoster.jsx';
import SceneRenderInputs from './SceneRenderInputs.jsx';
import SceneRenderTarget from './SceneRenderTarget.jsx';
import SceneSequenceCoverage from './SceneSequenceCoverage.jsx';
import SceneStoryboardClip from './SceneStoryboardClip.jsx';
import SceneTakeStrip from './SceneTakeStrip.jsx';
import SceneTimingPlan from './SceneTimingPlan.jsx';
import SharedTakeOffers from './SharedTakeOffers.jsx';
import ShotDownload from './ShotDownload.jsx';
import { ScenePromptField, SceneSpeakerField } from './ScenePromptField.jsx';
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from './sceneCardProps.js';

function SceneClipMediaPreview({
  scene, project, layer, posterSrc, index, aspect, sourceWindow,
  clipPlayback, renderPlan, media, takes, actions, fieldId, applyPatch,
  shotSaves, shotMoves, failedDownloadFields,
}) {
  const { clipSrc, clipSize, clipId } = clipPlayback;
  const { performance, repairPlan, renderSettings } = renderPlan;
  const instruction = scene.takes?.find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId)?.shotInstruction;
  const downloadDisabled = shotSaves > 0 || shotMoves > 0 || failedDownloadFields.size > 0 || takes.busy || media.settingsSaving || !!media.generatingVideo;

  return (
    <>
      {scene.videoHistoryId && performance && (
        <PerformanceEvidence key={scene.videoHistoryId} clipSrc={clipSrc} instruction={instruction}
          temporal={media.performanceReview?.shot} excerptStartSec={media.performanceReview?.excerptStartSec || 0}
          repair={repairPlan} repairBusy={media.repairBusy || media.settingsSaving || media.generatingVideo || takes.busy}
          onRepair={actions.onRepairPerformance ? () => actions.onRepairPerformance(scene.sceneId, {
            excerptId: media.performanceReview.excerptId, sourceAssetId: repairPlan.sourceAssetId, boundarySec: repairPlan.boundarySec,
          }) : null} />
      )}
      <SceneClipPreview scene={scene} index={index} performance={performance} playback={clipPlayback}
        onOpenPreview={actions.onOpenPreview} onTrimClip={actions.onTrimClip} onHandheldClip={actions.onHandheldClip}
        takeBusy={takes.busy} generatingVideo={media.generatingVideo} />
      {project?.id && clipId && layer === 'footage' && !isPreMusicShot(scene) && (
        <ShotDownload
          key={JSON.stringify([project.id, project.trackId, project.uploadedAudioFilename, project.audioRevision, project.scenes, scene, project.treatment?.brief?.aspectRatio, shotSaves > 0, shotMoves > 0, failedDownloadFields.size > 0, takes.busy, media.settingsSaving, !!media.generatingVideo])}
          projectId={project.id} sceneId={scene.sceneId} basis={shotDownloadBasis(project, scene)}
          startSec={scene.startSec} endSec={scene.endSec} saveFailed={failedDownloadFields.size > 0} disabled={downloadDisabled} />
      )}
      {/* One take cut across shots needs a source clip longer than this shot's span, and may need another model. */}
      {layer === 'footage' && !performance && (
        <SceneClipLength fieldId={fieldId} scene={scene} settings={renderSettings || {}} onChange={applyPatch} />
      )}
      {/* Speed and offset by hand, from the same clip file, in the player and the final render. */}
      {scene.videoHistoryId && layer === 'footage' && (
        <SceneClipTiming fieldId={fieldId} scene={scene} onChange={applyPatch} />
      )}
      {/* A clip of another shape (a 3:2 local render) zooms to fill, or keeps its ratio with covered edges. */}
      {clipId && (
        <SceneFrameFit id={fieldId('frame-fit')} scene={scene} clipSize={clipSize} aspect={aspect}
          onChange={(frameFit) => applyPatch({ frameFit })} />
      )}
      {/* A clip under 720p (grok's 480p default) goes soft in a 1080p render. */}
      {clipId && clipSize && isLowResVideo(clipSize) && (
        <p className="text-xs text-port-warning" data-testid="clip-low-res">
          Low-res clip: {clipSize.width}×{clipSize.height}, under 720p. Upscale it in Media History or regenerate it before the final render.
        </p>
      )}
      {/* Until the clip exists its still stands in, so the player is never an empty box. */}
      {!clipId && layer === 'footage' && (
        <div className="relative" data-testid="clip-placeholder">
          <ScenePoster src={posterSrc} scene={scene} scenes={project?.scenes} className="aspect-video w-full rounded border border-port-border" />
          <span className="absolute right-1.5 top-1.5 rounded port-media-overlay px-1.5 py-0.5 text-[10px]">
            {(scene.referenceImageId || sourceWindow?.referenceImageId) ? 'Still · no clip yet' : 'No clip yet'}
          </span>
        </div>
      )}
    </>
  );
}

function SceneClipRenderControls({
  scene, project, layer, view, fromSheet, renderPlan, media, actions, fieldId,
  renderPick, setRenderPick, renderOptions, setRenderOptions, setRenderInputs,
  clipReferenceSaveState, setClipReferenceSaveState,
  applyPatch, markDirty, clearDirty, saveIfDirty, saveShot,
}) {
  const {
    renderOverrides, renderSettings, renderLane, timing, performance, endFramePlan,
    referenceBackend, referenceModel, storyboardDefault,
    canUseLtxReferences, ltxReferencesGreyboxBlocked, ltxReferencesReason, useLtxReferences,
    cardRequest, runwayEndFrameOn, endFrameBlocksReferences, startFrameLayout,
    higgsfieldFrameOnly, referenceCapacity, previewRequest, songAudioField,
    renderCost, tierChoices,
  } = renderPlan;
  const grokPreview = (!renderSettings?.backend || renderSettings.backend === 'grok') && project?.id && scene.referenceImageId ? {
    ...(renderSettings?.backend ? { backend: renderSettings.backend } : {}),
    prompt: cardRequest.authored,
    mode: 'image',
    sourceImageFile: scene.referenceImageId,
    grokDuration: renderSettings?.backend === 'grok' ? grokSceneRequestDuration(scene, renderSettings, renderOverrides, project?.scenes) : renderSettings?.grokDuration,
    musicVideo: {
      projectId: project.id, sceneId: scene.sceneId, catalogBasis: project.castAndSets?.catalogCheckin?.basis,
      compose: true, promptAsTyped: true, ...songAudioField,
      ...(startFrameLayout ? { startFrameLayout: true } : {}),
    },
  } : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SceneRenderTarget id={fieldId('render-on')} value={renderPick} onChange={setRenderPick} performance={performance}
          options={renderOptions} onOptionsChange={setRenderOptions} scene={scene} scenes={project?.scenes}
          models={media.videoModels} defaultModel={media.defaultVideoModel}
          saved={media.falVideoSettings || {}} minFrames={useLtxReferences ? 121 : null} />
        {renderCost && !tierChoices && <span className="text-[11px] text-port-text-muted">{renderCost}</span>}
      </div>
      {layer === 'footage' && canUseLtxReferences && (
        <label className="flex items-center gap-2 text-xs text-port-text-muted">
          <input type="checkbox" checked={useLtxReferences} disabled={ltxReferencesGreyboxBlocked}
            onChange={(event) => setRenderInputs((prev) => ({
              ...prev, ltxReferences: event.target.checked,
              ...(event.target.checked ? { songAudio: false, endFrame: false } : {}),
            }))} />
          Use LTX reference images (requires Ingredients adapter; at least 121 frames; no song audio or end frame)
        </label>
      )}
      {ltxReferencesReason && <p className="text-xs text-port-text-muted">{ltxReferencesReason}</p>}
      {canUseLtxReferences && ltxReferencesGreyboxBlocked && (
        <p className="text-xs text-port-text-muted">Clear the greybox reference to use LTX reference images.</p>
      )}
      {layer === 'footage' && referenceBackend === 'grok' && !storyboardDefault && scene.referenceImageId && (
        <label className="flex items-center gap-2 text-xs text-port-text-muted">
          <input type="checkbox" checked={startFrameLayout}
            onChange={(event) => setRenderInputs((prev) => ({ ...prev, startFrameLayout: event.target.checked }))} />
          Start frame for layout only (its people take the clip references' looks; the clip may not open on it exactly)
        </label>
      )}
      {layer === 'footage' && referenceBackend === 'higgsfield' && scene.referenceImageId && (
        <label className="flex items-center gap-2 text-xs text-port-text-muted">
          <input type="checkbox" checked={higgsfieldFrameOnly}
            onChange={(event) => setRenderInputs((prev) => ({ ...prev, frameRoute: event.target.checked ? 'image' : undefined }))} />
          {higgsfieldFrameOnly
            ? 'Image-to-video from the start frame (clip references left out)'
            : 'Route: start frame sent as the first reference image when the shot has clip references; tick for plain image-to-video'}
        </label>
      )}
      {layer === 'footage' && (
        <SceneClipReferences project={project} scene={scene} castMedia={media.castMedia} startFrameLayout={startFrameLayout}
          backend={referenceBackend} model={referenceModel} songAudio={cardRequest.songAudio.state === 'on'}
          capacityOverride={useLtxReferences ? 8 : runwayEndFrameOn ? referenceCapacity : undefined}
          endFrameBlocksReferences={endFrameBlocksReferences} ltxReferencesOff={canUseLtxReferences && !useLtxReferences}
          onEditLocal={actions.onEditLocal} onSave={actions.onSave}
          saveState={clipReferenceSaveState} onSaveState={setClipReferenceSaveState} />
      )}
      {/* The clip prompt sits under the clip's references, like each frame's prompt under its frame. */}
      {layer === 'footage' && (
        <ScenePromptField scene={scene} layer={layer} fromSheet={fromSheet} fieldId={fieldId}
          applyPatch={applyPatch} markDirty={markDirty} clearDirty={clearDirty} saveIfDirty={saveIfDirty}
          onEditLocal={actions.onEditLocal} onSave={actions.onSave} />
      )}
      {/* The camera move sits with the clip prompt and shows the text it adds to it. */}
      {layer === 'footage' && (
        <SceneCameraControls scene={scene} fieldId={fieldId} onEditLocal={actions.onEditLocal} onSave={actions.onSave}
          adds={cardRequest.promptAdditions.find((item) => item.id === 'camera-move')?.text || null} />
      )}
      {!isPreMusicShot(scene) && <SceneTimingPlan timing={timing} lipSyncBackend={renderLane} />}
      {layer === 'footage' && (
        <SceneRenderInputs id={fieldId('inputs')} request={previewRequest} shown={view === 'clip'}
          onChange={(patch) => setRenderInputs((prev) => ({
            ...prev, ...patch,
            ...(patch.songAudio === true || patch.endFrame === true ? { ltxReferences: false } : {}),
          }))}
          grokPreview={grokPreview}
          previewRevision={JSON.stringify([project?.updatedAt, media.castMedia])} />
      )}
      {layer === 'footage' && scene.coverage === 'sequence' && <SceneSequenceCoverage project={project} scene={scene} />}
      {layer === 'footage' && (
        <SharedTakeOffers scenes={project?.scenes || []} sceneId={scene.sceneId}
          onSave={(sceneId, patch) => { actions.onEditLocal(sceneId, patch); return saveShot(sceneId, patch); }} />
      )}
      {endFramePlan.endImageId && (
        <p className={`text-[11px] ${endFramePlan.used ? 'text-port-text-muted' : 'text-port-warning'}`} data-testid="end-frame-plan">
          {endFramePlan.used ? 'The clip ends on the end frame.' : `${endFramePlan.reason}.`}
        </p>
      )}
    </>
  );
}

function SceneClipActionBar({
  scene, layer, sourceWindow, renderPlan, media, takes, actions,
  applyPatch, generateVideo, generateStoryboardClip, withFrameTarget, setSwapKind,
}) {
  const {
    storyboardDefault, storyboardRefusal, tierChoices, tierPriced,
    renderBlocked, sendingClip, videoRefusal, performance, capability,
    renderCost, performanceBlocked, clipJobs, guidesFailed,
  } = renderPlan;
  const renderTitle = videoRefusal || (performance
    ? `${capability.style === 'music' ? "Animate this scene's frame to the song" : "Lip-sync this scene's frame to the song"} via ${capability.label} — ${renderCost}`
    : "Render this shot's clip from its still");

  return (
    <>
      {/* Render and the other ways to fill the shot, under all its prompts and settings. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="clip-actions">
        {storyboardDefault && (
          <SceneStoryboardClip refusal={storyboardRefusal} generatingFrame={!!media.generatingFrame}
            onClip={generateStoryboardClip} onStill={actions.onGenerateFrame && !sourceWindow ? () => {
              const options = withFrameTarget(null);
              if (options) actions.onGenerateFrame(scene, options);
              else actions.onGenerateFrame(scene);
            } : null} />
        )}
        {!storyboardDefault && tierChoices && tierChoices.map(({ tier, resolution, costUsd }) => (
          <button key={tier} type="button" onClick={() => generateVideo(tier)} disabled={renderBlocked}
            className={tier === 'final' ? PRIMARY_BUTTON : SECONDARY_BUTTON} data-testid={`render-${tier}`}
            title={videoRefusal || `Render this shot's clip as a ${tier} at ${resolution}`}>
            {sendingClip ? <Activity size={14} className="animate-spin" /> : <Video size={14} />}
            {sendingClip ? 'Sending…' : `Render ${tier}`}
            <span className="opacity-80">{`${resolution}${tierPriced && costUsd != null ? ` · ${formatUsd(costUsd)}` : ''}`}</span>
          </button>
        ))}
        {!storyboardDefault && !tierChoices && (
          <button onClick={() => generateVideo()} disabled={renderBlocked} className={PRIMARY_BUTTON} title={renderTitle}>
            {sendingClip ? <Activity size={14} className="animate-spin" /> : <Video size={14} />}
            {sendingClip ? 'Sending…' : `Render${scene.videoHistoryId || clipJobs.length ? ' again' : ''}`}
          </button>
        )}
        {actions.onPlacePoolItem && (
          <button type="button" onClick={() => setSwapKind('video')} disabled={takes.busy} className={SECONDARY_BUTTON}
            title="Pick a clip made for this video that no shot uses: this shot's other takes, other shots', or the floor">
            <Shuffle size={14} /> Swap from unused
          </button>
        )}
        {scene.videoHistoryId && media.canContinueShot && (
          <button onClick={() => actions.onContinueVideo(scene)} disabled={media.settingsSaving || !!media.generatingVideo}
            className={SECONDARY_BUTTON}
            title="Native-extend this clip from its final latent frames and attach the longer result to this scene">
            <Video size={14} /> Continue shot
          </button>
        )}
        {actions.onImportClipTake && (
          <button type="button" onClick={() => actions.onImportClipTake(scene)} disabled={takes.busy} className={SECONDARY_BUTTON}
            title="Pick an existing clip from the gallery (e.g. made in an external tool) as a take">
            <Clapperboard size={14} /> Import clip take
          </button>
        )}
      </div>
      {/* Why Render is off, on the card itself: a tooltip never shows on a phone. */}
      {videoRefusal && videoRefusal !== performanceBlocked && layer === 'footage' && !storyboardDefault && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-port-warning" data-testid="render-refusal">
          <span>{videoRefusal}</span>
          {sourceWindow && (
            <button type="button" className={SECONDARY_BUTTON} onClick={() => applyPatch({ sourceTake: null })}>
              Use its own clip
            </button>
          )}
        </div>
      )}
      {guidesFailed && actions.onReloadCastMedia && layer === 'footage' && !storyboardDefault && (
        <CastGuidesRetry onRetry={actions.onReloadCastMedia} consequence="this clip" />
      )}
    </>
  );
}

/**
 * Clip/Picture tab section of SceneCard: picture preview or clip playback/takes/approval,
 * renderer & reference controls, clip prompt, timing plan, and render action buttons.
 */
export default function SceneVideoTakesSection({
  scene, project, layer, stillPicture, photoFps, view, fromSheet, locked, sourceWindow,
  clipPlayback, renderPlan, position, composition, media, takes, actions, fieldId,
  renderPick, setRenderPick, renderOptions, setRenderOptions, setRenderInputs,
  clipReferenceSaveState, setClipReferenceSaveState, setSpeakerDirty, setSpeakerSaving,
  shotSaves, shotMoves, failedDownloadFields,
  applyPatch, markDirty, clearDirty, saveIfDirty, saveShot,
  generateVideo, generateStoryboardClip, withFrameTarget, setSwapKind,
}) {
  return (
    <section aria-label="Render" className="min-w-0 space-y-2">
      {/* A clip, the still, or the still playing a code-drawn image effect (no model call). */}
      {composition.layered && (layer === 'footage' || layer === 'still') && (
        <SceneImageEffect fieldId={fieldId} scene={scene} onChange={applyPatch} beats={project?.audioAnalysis?.beats} fps={photoFps} />
      )}
      {stillPicture ? (
        <ScenePicturePreview scene={scene} beats={project?.audioAnalysis?.beats} fps={photoFps} />
      ) : (
        <>
          <SceneClipMediaPreview
            scene={scene} project={project} layer={layer} posterSrc={position.posterSrc} index={position.index}
            aspect={composition.aspect} sourceWindow={sourceWindow} clipPlayback={clipPlayback}
            renderPlan={renderPlan} media={media} takes={takes} actions={actions} fieldId={fieldId}
            applyPatch={applyPatch} shotSaves={shotSaves} shotMoves={shotMoves} failedDownloadFields={failedDownloadFields}
          />
          <SceneTakeStrip project={project} scene={scene} kind="video" busy={takes.busy} saving={takes.pending} grid pending={renderPlan.clipJobs}
            onSelect={(take) => actions.onSelectTake?.(scene, take)}
            onReview={(take, review) => actions.onReviewTake?.(scene, take, review)}
            onOpenPreview={actions.onOpenPreview} marks={project?.assetMarks} onMark={actions.onMarkTake} />
          {layer === 'footage' && (
            <SceneFinalApproval scene={scene} locked={locked} busy={takes.busy} onApprove={actions.onApproveFinal} onSelectTake={actions.onSelectTake} />
          )}
          <SceneSpeakerField scene={scene} performance={renderPlan.performance} fieldId={fieldId}
            onEditLocal={actions.onEditLocal} onSave={actions.onSave}
            setSpeakerDirty={setSpeakerDirty} setSpeakerSaving={setSpeakerSaving} />
          <SceneClipRenderControls
            scene={scene} project={project} layer={layer} view={view} fromSheet={fromSheet}
            renderPlan={renderPlan} media={media} actions={actions} fieldId={fieldId}
            renderPick={renderPick} setRenderPick={setRenderPick}
            renderOptions={renderOptions} setRenderOptions={setRenderOptions} setRenderInputs={setRenderInputs}
            clipReferenceSaveState={clipReferenceSaveState} setClipReferenceSaveState={setClipReferenceSaveState}
            applyPatch={applyPatch} markDirty={markDirty} clearDirty={clearDirty} saveIfDirty={saveIfDirty} saveShot={saveShot}
          />
          <SceneClipActionBar
            scene={scene} layer={layer} sourceWindow={sourceWindow} renderPlan={renderPlan}
            media={media} takes={takes} actions={actions} applyPatch={applyPatch}
            generateVideo={generateVideo} generateStoryboardClip={generateStoryboardClip}
            withFrameTarget={withFrameTarget} setSwapKind={setSwapKind}
          />
        </>
      )}
    </section>
  );
}
