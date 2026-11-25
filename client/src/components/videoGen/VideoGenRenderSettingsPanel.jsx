import A2vLoraStageControls from './A2vLoraStageControls';
import AdvancedParamsPanel from './AdvancedParamsPanel';
import ModelDisclosure from './ModelDisclosure';
import VideoGenHostedSettings from './VideoGenHostedSettings';
import VideoGenLocalModelSettings from './VideoGenLocalModelSettings';
import MusicVideoFilingSelect from '../media/MusicVideoFilingSelect';
import RemoteMediaTargetPicker from '../federatedMedia/RemoteMediaTargetPicker';
import { isDefaultA2vLoraStages } from '../../lib/videoLoraStages';
import { isDeliveryVideoModel } from '../../lib/videoFinish.js';

/**
 * The "Render settings" column of the VideoGen form: render target, the hosted
 * lane's or local model's settings, provenance disclosure, the Advanced
 * sampler panel, music-video filing and the per-render display-sleep choice.
 * `form` groups come in by name; `weights` is `useVideoGenWeightAssets()`.
 */
export default function VideoGenRenderSettingsPanel({
  lane, providers, model, sampler, promptFields, keyframesActive,
  weights, catalog, loraLibrary, remoteTarget, remoteUnsupportedInputs,
  rendersOffMachine, backendDisclosures, systemMemoryGb, runwayCatalog, reactorContinuableClips,
  displaySleep, generating, onOpenSettings,
}) {
  const { mode, hostedLane, backend } = lane;
  const { currentModel, selectedLoras, a2vLoraStageStrengths, setA2vLoraStageStrengths } = model;
  const { modelDownload, speedProfileAssetId, speedProfileStatus } = weights;
  const { canSleepDisplay, displaySleepEnabled, setDisplaySleepOverride } = displaySleep;
  // A model the finish graph names as a DELIVERY target always decodes on its
  // own decoder — the server declines a draft request there outright (#5423) —
  // so the decode picker shows Full and says why instead of offering a choice
  // that would be silently dropped. `applyFinish` already resets the value when
  // Finish switches models; this keeps the control honest when the user picks
  // the delivery model by hand.
  const deliveryModelSelected = isDeliveryVideoModel(currentModel, catalog.models);

  return (
    <section aria-label="Render settings" className="min-w-0 space-y-3">
      {!rendersOffMachine && (
        <RemoteMediaTargetPicker
          target={remoteTarget}
          kind="video"
          localBlockedReason={remoteUnsupportedInputs}
        />
      )}

      {(hostedLane || remoteTarget.isRemote) && !isDefaultA2vLoraStages(a2vLoraStageStrengths) && (
        <A2vLoraStageControls value={a2vLoraStageStrengths} onChange={setA2vLoraStageStrengths}
          supported={false} disabled={generating} loras={selectedLoras} />
      )}

      {hostedLane ? (
        <VideoGenHostedSettings
          lane={lane}
          sampler={sampler}
          {...providers}
          runwayCatalog={runwayCatalog}
          reactorContinuableClips={reactorContinuableClips}
        />
      ) : (
        <VideoGenLocalModelSettings
          mode={mode}
          isGrok={lane.isGrok}
          model={model}
          sampler={sampler}
          promptFields={promptFields}
          weights={weights}
          catalog={catalog}
          loraLibrary={loraLibrary}
          isRemote={remoteTarget.isRemote}
          generating={generating}
          onOpenSettings={onOpenSettings}
        />
      )}

      {/* Provenance / licensing / policy scope for the selected backend +
          model (#3674). Licenses are informational links — they never
          block download or generate. */}
      <ModelDisclosure
        backend={backend}
        backendDisclosures={backendDisclosures}
        model={rendersOffMachine ? null : currentModel}
        systemMemoryGb={systemMemoryGb}
      />

      {!rendersOffMachine && (
        <AdvancedParamsPanel
          mode={mode}
          currentModel={currentModel}
          numFrames={sampler.numFrames} onNumFramesChange={sampler.setNumFrames}
          chunks={sampler.chunks} onChunksChange={sampler.setChunks} keyframesActive={keyframesActive}
          chunkPrompts={sampler.chunkPrompts} onChunkPromptChange={sampler.setChunkPromptAt} chainingActive={sampler.chainingActive}
          contextFrames={sampler.contextFrames} onContextFramesChange={sampler.setContextFrames}
          fps={sampler.fps} onFpsChange={sampler.setFps}
          batchSize={sampler.batchSize} onBatchSizeChange={sampler.setBatchSize}
          seed={sampler.seed} onSeedChange={sampler.setSeed} onRandomSeed={sampler.handleRandomSeed}
          steps={sampler.steps} onStepsChange={sampler.setSteps}
          guidanceScale={sampler.guidanceScale} onGuidanceScaleChange={sampler.setGuidanceScale}
          speedProfileId={model.speedProfileId} onSpeedProfileChange={model.setSpeedProfileId}
          speedProfileStatus={speedProfileStatus}
          onSpeedProfileDownload={() => modelDownload.start(speedProfileAssetId, { force: true })}
          width={sampler.width} height={sampler.height}
          onCancelSpeedProfileDownload={modelDownload.cancel}
          speedProfileDownloadError={modelDownload.lastError?.modelId === speedProfileAssetId ? modelDownload.lastError.message : null}
          draftDecode={model.draftDecode} onDraftDecodeChange={model.setDraftDecode}
          draftDecodeLocked={deliveryModelSelected}
          streamingMode={model.streamingMode} onStreamingModeChange={model.setStreamingMode}
          imageStrength={sampler.imageStrength} onImageStrengthChange={sampler.setImageStrength}
          i2vReferenceMode={sampler.i2vReferenceMode} onI2vReferenceModeChange={sampler.setI2vReferenceMode}
          effectiveImageStrength={sampler.effectiveImageStrength}
          tiling={sampler.tiling} onTilingChange={sampler.setTiling}
          disableAudio={sampler.disableAudio} onDisableAudioChange={sampler.setDisableAudio}
          noMusic={sampler.noMusic} onNoMusicChange={sampler.setNoMusic}
        />
      )}

      {/* Visible per-render control rather than a settings-only default (off by
          default — see ImageGenTab's videoGenDisplaySleep) — a GPU-watchdog
          crash on this model is rare enough that most renders shouldn't pay for
          the mitigation, but the option needs to be one click away right here. */}
      <MusicVideoFilingSelect id="video-gen-music-video" disabled={generating} />

      {canSleepDisplay && (
        <label htmlFor="video-gen-display-sleep" className="flex items-start gap-2 text-xs text-gray-400 cursor-pointer">
          <input
            id="video-gen-display-sleep"
            type="checkbox"
            checked={displaySleepEnabled}
            onChange={(e) => setDisplaySleepOverride(e.target.checked)}
            disabled={generating}
            className="mt-0.5 accent-port-accent"
          />
          <span>
            Sleep display during this render
            <span className="block text-[11px] text-gray-500">
              Reduces WindowServer GPU contention on affected Apple silicon. Change the install-wide
              default in Media Gen Settings (gear icon or ⌘K "Media Gen Settings").
            </span>
          </span>
        </label>
      )}

    </section>
  );
}
