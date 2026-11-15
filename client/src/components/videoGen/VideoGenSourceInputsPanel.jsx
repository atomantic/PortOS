import FramePanel from './FramePanel';
import KeyframePanel from './KeyframePanel';
import AudioPanel from './AudioPanel';
import ExtendPanel from './ExtendPanel';
import IcLoraPanel from './IcLoraPanel';
import ReferenceImagesPanel from './ReferenceImagesPanel';

/**
 * The conditioning inputs the selected mode and lane take: keyframes, start /
 * last frames, audio-to-video, extend, reference media (local and per hosted
 * provider), and the IC-LoRA references. Each prop is one `useVideoGenForm()`
 * group; `onBrowse(kind, index)` opens the page's shared gallery picker for
 * the slot named by `kind`, and `weights` is `useVideoGenWeightAssets()`.
 */
export default function VideoGenSourceInputsPanel({
  lane, model, sampler, frames, keyframes, extend, audio, ic, references,
  fal, runway, higgsfield, google, visibleHistory, rendersOffMachine, onBrowse, weights,
}) {
  const { mode, isRunway, isFal, isHiggsfield, isGoogle } = lane;
  const { currentModel, visibleModels } = model;
  const { numFrames, fps, width, height, i2vReferenceMode, referenceModeSupported } = sampler;
  const {
    sourceImageFile, sourceImageUpload, sourceUploadUrl, unavailableSourceImageName,
    uploadSourceImage, clearSourceImage,
    lastImageFile, lastImageUpload, lastUploadUrl, uploadLastImage, clearLastImage, lastFrameIsAdvisory,
  } = frames;
  const { keyframesSupported, keyframesActive } = keyframes;
  const { audioFile, setAudioFile, setAudioDurationSec, a2vDurationError } = audio;
  const {
    referenceImageFiles, addReferenceImage, removeReferenceImage,
    referenceVideoIds, maxReferenceVideos, addReferenceVideo, pickReferenceVideo, removeReferenceVideo,
    referenceAudioFiles, maxReferenceAudios, addReferenceAudio, removeReferenceAudio,
  } = references;
  const { falModel } = fal;
  const { runwayModel, runwaySpecial, runwayPerformance, runwayInputs } = runway;
  const { higgsfieldModel } = higgsfield;
  const { googleModel } = google;
  const { icWeightStatus, modelDownload } = weights;
  const browseReference = (index) => onBrowse('reference', index);

  return (
    <>
      {mode === 'fflf' && keyframesSupported && (
        <KeyframePanel
          keyframesMode={keyframes.keyframesMode}
          keyframesActive={keyframesActive}
          keyframes={keyframes.keyframes}
          numFrames={numFrames}
          keyframesError={keyframes.keyframesError}
          onToggleMode={keyframes.toggleKeyframesMode}
          onAddKeyframe={keyframes.addKeyframe}
          onBrowseKeyframe={(index) => onBrowse('keyframe', index)}
          onUpdateKeyframe={keyframes.updateKeyframe}
          onRemoveKeyframe={keyframes.removeKeyframe}
        />
      )}

      {(mode === 'image' || mode === 'ic-ingredients-25' || (runwaySpecial && !runwayInputs.characterVideo) || (mode === 'fflf' && !keyframesActive)) && (
        <div className={`grid gap-2 ${mode === 'fflf' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
          <FramePanel
            label={runwayPerformance ? 'Character image' : runwaySpecial ? 'Guidance image (optional)' : mode === 'ic-ingredients-25' ? 'Opening frame (optional)' : mode === 'fflf' ? 'First frame' : 'Source image'}
            file={sourceImageFile}
            upload={sourceImageUpload}
            uploadUrl={sourceUploadUrl}
            onBrowseGallery={() => onBrowse('source')}
            onUpload={uploadSourceImage}
            onClear={clearSourceImage}
            alt="Source"
            advisoryNote={mode === 'image' && i2vReferenceMode === 'inspire' ? {
              text: 'Inspire — frame one is generated from this, not copied.',
              title: 'Inspire conditions the opening frame loosely, so the clip carries this image’s subject and style without reproducing its exact pixels. Switch Reference mode to Anchor under Advanced to make it frame one.',
            } : null}
            hint={mode === 'image' && currentModel && !referenceModeSupported ? {
              text: 'This model anchors the reference — it becomes frame one exactly.',
              title: 'Only LTX-2.5 carries a per-image conditioning strength, which is what a loose (Inspire) reference needs. Every other runtime pins the supplied image as frame one.',
            } : null}
          />
          {mode === 'ic-ingredients-25' && unavailableSourceImageName && (
            <p role="status" className="text-xs text-port-warning">
              The in-flight opening frame ({unavailableSourceImageName}) cannot be restored. Pick it again, or{' '}
              <button type="button" className="underline" onClick={clearSourceImage}>continue without it</button>.
            </p>
          )}
          {mode === 'fflf' && (
            <FramePanel
              label="Last frame"
              file={lastImageFile}
              upload={lastImageUpload}
              uploadUrl={lastUploadUrl}
              onBrowseGallery={() => onBrowse('last')}
              onUpload={uploadLastImage}
              onClear={clearLastImage}
              alt="End frame"
              advisoryNote={lastFrameIsAdvisory ? {
                text: 'Experimental — last frame is advisory.',
                title: `FFLF backend support is experimental — the ${currentModel?.runtime || 'selected'} runtime conditions on the start frame only and treats the last frame as advisory.`,
              } : null}
              hint={{
                text: 'Tip: use keyframes that share scene geometry — same camera, same subject. The model interpolates between them; unrelated images produce a visual cut.',
                title: 'FFLF works best when the two frames depict the same scene with continuous geometry. Both runtimes (notapalindrome and dgrauet) benefit from this.',
              }}
            />
          )}
        </div>
      )}

      {mode === 'a2v' && (
        <div className="grid gap-3 lg:grid-cols-2">
          <FramePanel
            label={currentModel?.requiresSourceImageForA2v ? 'Reference image (required)' : 'Reference image (optional)'}
            file={sourceImageFile}
            upload={sourceImageUpload}
            uploadUrl={sourceUploadUrl}
            onBrowseGallery={() => onBrowse('source')}
            onUpload={uploadSourceImage}
            onClear={clearSourceImage}
            alt="Audio-to-video reference"
            hint={{
              text: 'This image establishes the subject, composition, and opening geometry.',
              title: currentModel?.arbitraryLengthAudio === true
                ? 'MiniMax H3 Ref2VA combines the image with each audio window. PortOS carries the prior window\'s last frame forward to keep long renders continuous.'
                : 'LTX-2.5 conditions frame one on this image while the uploaded audio drives motion and synchronization.',
            }}
          />
          <AudioPanel
            audioFile={audioFile}
            numFrames={numFrames}
            fps={fps}
            hasCompatibleModel={visibleModels.length > 0}
            audioDurationDriven={currentModel?.audioDurationDriven === true}
            arbitraryLengthAudio={currentModel?.arbitraryLengthAudio === true}
            maxReferenceAudioSeconds={currentModel?.maxReferenceAudioSeconds}
            maxDurationSeconds={currentModel?.audioDurationDriven === true
              && currentModel?.arbitraryLengthAudio !== true
              && Number(currentModel?.maxNumFrames) > 0
              ? Number(currentModel.maxNumFrames) / Number(fps)
              : null}
            durationError={a2vDurationError}
            onDurationChange={setAudioDurationSec}
            onPick={setAudioFile}
            onClear={() => setAudioFile(null)}
          />
        </div>
      )}

      {mode === 'extend' && (
        <ExtendPanel
          extendFromVideoId={extend.extendFromVideoId}
          extendingFrame={extend.extendingFrame}
          sourceImageFile={sourceImageFile}
          visibleHistory={visibleHistory}
          onPick={extend.handleExtendPick}
        />
      )}

      {!rendersOffMachine && Number(currentModel?.maxReferenceImages) > 1 && (
        <ReferenceImagesPanel
          maxImages={Number(currentModel.maxReferenceImages)}
          files={referenceImageFiles}
          onAdd={addReferenceImage}
          onBrowse={browseReference}
          onRemove={removeReferenceImage}
          maxVideos={maxReferenceVideos}
          videoIds={referenceVideoIds}
          history={visibleHistory}
          onAddVideo={addReferenceVideo}
          onPickVideo={pickReferenceVideo}
          onRemoveVideo={removeReferenceVideo}
          maxAudios={maxReferenceAudios}
          audioFiles={referenceAudioFiles}
          onAddAudio={addReferenceAudio}
          onRemoveAudio={removeReferenceAudio}
        />
      )}

      {isRunway && mode === 'image' && runwayModel?.referenceImages && (
        <div className="space-y-1">
          <ReferenceImagesPanel
            maxImages={runwayModel.referenceImages.max}
            files={referenceImageFiles}
            onAdd={addReferenceImage}
            onBrowse={browseReference}
            onRemove={removeReferenceImage}
          />
          <p className="text-xs text-port-text-muted">
            {runwayModel.referenceImages.keepsFrames
              ? 'Your start and end frames stay pinned, and these count toward the limit.'
              : 'With references, the start frame guides the clip instead of pinning its opening, and an end frame cannot be used.'}
          </p>
        </div>
      )}

      {isFal && falModel?.referenceImages && (
        <div className="space-y-1">
          <ReferenceImagesPanel
            maxImages={falModel.referenceImages.max}
            withInputImage={mode === 'image' && !falModel.image}
            files={referenceImageFiles}
            onAdd={addReferenceImage}
            onBrowse={browseReference}
            onRemove={removeReferenceImage}
          />
          <p className="text-xs text-port-text-muted">
            Optional. {falModel.label} reads these in order
            {falModel.referenceImages.promptName ? ` as ${falModel.referenceImages.promptName.replace(/1$/, '1, 2, …')}` : ''}.
            {mode === 'image' && !falModel.image ? ' Your start frame is the first image.' : ''}
          </p>
        </div>
      )}

      {isHiggsfield && mode === 'text' && higgsfieldModel.maxReferenceImages > 0 && (
        <div className="space-y-1">
          <ReferenceImagesPanel
            maxImages={higgsfieldModel.maxReferenceImages}
            withInputImage={false}
            files={referenceImageFiles}
            onAdd={addReferenceImage}
            onBrowse={browseReference}
            onRemove={removeReferenceImage}
          />
          <p className="text-xs text-port-text-muted">
            Optional. With references, {higgsfieldModel.label} renders from them instead of from text alone. Switch to Image mode to pin a start frame instead.
          </p>
        </div>
      )}

      {isGoogle && mode === 'text' && googleModel.maxReferenceImages > 0 && (
        <div className="space-y-1">
          <ReferenceImagesPanel
            maxImages={googleModel.maxReferenceImages}
            withInputImage={false}
            files={referenceImageFiles}
            onAdd={addReferenceImage}
            onBrowse={browseReference}
            onRemove={removeReferenceImage}
          />
          <p className="text-xs text-port-text-muted">
            Optional. With references, {googleModel.label} renders an 8-second clip that keeps their subjects. Switch to Image mode to pin a start frame instead.
          </p>
        </div>
      )}

      {ic.icModeActive && (
        <IcLoraPanel
          spec={ic.icSpec}
          referenceFile={ic.icReferenceFile}
          referenceVideoId={ic.icReferenceVideoId}
          inFlightReferenceNames={ic.icReferenceNames}
          visibleHistory={visibleHistory}
          referenceImageFiles={ic.icReferenceImageFiles}
          onAddReferenceImage={ic.addIcReferenceImage}
          onBrowseReferenceImage={(index) => onBrowse('icReference', index)}
          onRemoveReferenceImage={ic.removeIcReferenceImage}
          icStrength={ic.icStrength}
          icSkipStage2={ic.icSkipStage2}
          width={width}
          height={height}
          weightStatus={icWeightStatus}
          hasCompatibleModel={visibleModels.length > 0}
          onPickFile={ic.pickIcReferenceFile}
          onClearFile={() => ic.pickIcReferenceFile(null)}
          onPickHistory={ic.pickIcReferenceVideoId}
          onStrengthChange={ic.setIcStrength}
          onSkipStage2Change={ic.setIcSkipStage2}
          onDownloadWeight={() => modelDownload.start(ic.icSpec.mode)}
          onCancelWeightDownload={modelDownload.cancel}
        />
      )}
    </>
  );
}
