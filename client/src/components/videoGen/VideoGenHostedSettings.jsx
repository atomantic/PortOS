import { FormField } from '../ui/FormField';
import ResolutionField from '../media/ResolutionField';
import FalVideoSettings from './FalVideoSettings';
import GoogleVideoSettings from './GoogleVideoSettings';
import HiggsfieldVideoSettings from './HiggsfieldVideoSettings';
import ReactorPanel from './ReactorPanel';
import RunwayVideoSettings from './RunwayVideoSettings';
import { GEMINI_OMNI_WEB_MODEL } from '../../../../server/lib/geminiWebVideo.js';
import { GROK_VIDEO_DURATIONS } from '../../lib/grokVideoClip.js';
import { VIDEO_RESOLUTIONS } from '../../lib/videoGenResolutions';
import { VIDEO_EDGE_BOUNDS } from '../../lib/videoGenParams.js';

/**
 * Render settings for a hosted lane (Grok, fal.ai, Gemini, Higgsfield, Google
 * Veo, Runway, reactor.inc). The provider owns the model, sampler and encoder,
 * so only its own length/size/model fields show. Each provider prop is its
 * `useVideoGenForm()` group; `sampler` supplies the shared W×H.
 */
export default function VideoGenHostedSettings({
  lane, sampler, grok, fal, runway, higgsfield, google, reactor, runwayCatalog, reactorContinuableClips,
}) {
  const { mode, isGrok, isFal, isGemini, isHiggsfield, isGoogle, isRunway, isReactor } = lane;
  const { width, height, handleResolutionChange } = sampler;
  if (isGrok) {
    return (
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Clip length" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={grok.grokDuration}
            onChange={(e) => grok.setGrokDuration(Number(e.target.value))}
            className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent disabled:opacity-50"
          >
            {GROK_VIDEO_DURATIONS.map((d) => <option key={d} value={d}>{d} seconds</option>)}
          </select>
        </FormField>
        <ResolutionField
          presets={VIDEO_RESOLUTIONS}
          width={width}
          height={height}
          onChange={handleResolutionChange}
          {...VIDEO_EDGE_BOUNDS}
          snapOnBlur
          note="Grok maps the size to its closest supported aspect ratio — exact pixel dimensions are chosen by the model."
        />
        <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
          Grok generates a base image first (or animates your source image in Image mode), then renders motion with its
          <code className="text-gray-400"> image_to_video </code> tool. Model, frames, and seed are chosen by Grok; renders count against your Grok plan.
        </p>
      </div>
    );
  }
  if (isFal) {
    const { falModelId, setFalModelId, falDuration, setFalDuration, falResolution, setFalResolution, falGenerateAudio, setFalGenerateAudio } = fal;
    return (
      <FalVideoSettings
        mode={mode}
        falModelId={falModelId}
        setFalModelId={setFalModelId}
        falDuration={falDuration}
        setFalDuration={setFalDuration}
        falResolution={falResolution}
        setFalResolution={setFalResolution}
        falGenerateAudio={falGenerateAudio}
        setFalGenerateAudio={setFalGenerateAudio}
        width={width}
        height={height}
      />
    );
  }
  if (isGemini) {
    return (
      <div className="space-y-3">
        <ResolutionField
          presets={VIDEO_RESOLUTIONS}
          width={width}
          height={height}
          onChange={handleResolutionChange}
          {...VIDEO_EDGE_BOUNDS}
          snapOnBlur
          note="Only picks Landscape or Portrait. Gemini chooses the exact size."
        />
        <p className="text-[11px] text-gray-500 leading-snug">
          PortOS opens the Gemini web app in the PortOS Browser, attaches your start frame, sends the prompt and downloads the clip.
          Gemini sets the length (about {GEMINI_OMNI_WEB_MODEL.clipSeconds} seconds), and renders count against the Google account signed in there.
        </p>
      </div>
    );
  }
  if (isHiggsfield) {
    return (
      <HiggsfieldVideoSettings
        higgsfieldModel={higgsfield.higgsfieldModel}
        setHiggsfieldModelId={higgsfield.setHiggsfieldModelId}
        higgsfieldDuration={higgsfield.higgsfieldDuration}
        setHiggsfieldDuration={higgsfield.setHiggsfieldDuration}
        higgsfieldResolution={higgsfield.higgsfieldResolution}
        setHiggsfieldResolution={higgsfield.setHiggsfieldResolution}
        higgsfieldGenerateAudio={higgsfield.higgsfieldGenerateAudio}
        setHiggsfieldGenerateAudio={higgsfield.setHiggsfieldGenerateAudio}
        width={width}
        height={height}
        handleResolutionChange={handleResolutionChange}
      />
    );
  }
  if (isGoogle) {
    return (
      <GoogleVideoSettings
        googleModel={google.googleModel}
        setGoogleModelId={google.setGoogleModelId}
        googleDuration={google.googleDuration}
        setGoogleDuration={google.setGoogleDuration}
        googleResolution={google.googleResolution}
        setGoogleResolution={google.setGoogleResolution}
        googleGenerateAudio={google.googleGenerateAudio}
        setGoogleGenerateAudio={google.setGoogleGenerateAudio}
        width={width}
        height={height}
        handleResolutionChange={handleResolutionChange}
      />
    );
  }
  if (isRunway) {
    return (
      <RunwayVideoSettings
        mode={mode}
        runwayCatalog={runwayCatalog}
        runwayModel={runway.runwayModel}
        runwayModelId={runway.runwayModelId}
        setRunwayModelId={runway.setRunwayModelId}
        runwaySpecial={runway.runwaySpecial}
        runwayInputs={runway.runwayInputs}
        setRunwayInputs={runway.setRunwayInputs}
        runwayDuration={runway.runwayDuration}
        setRunwayDuration={runway.setRunwayDuration}
        width={width}
        height={height}
        handleResolutionChange={handleResolutionChange}
        runwayResolution={runway.runwayResolution}
        setRunwayResolution={runway.setRunwayResolution}
      />
    );
  }
  if (isReactor) {
    return (
      <ReactorPanel
        clipId={reactor.reactorClipId}
        onClipIdChange={reactor.setReactorClipId}
        continuableClips={reactorContinuableClips}
        imageModeActive={mode === 'image'}
        seconds={reactor.reactorSeconds}
        onSecondsChange={reactor.setReactorSeconds}
        seed={reactor.reactorSeed}
        onSeedChange={reactor.setReactorSeed}
        aspect={reactor.reactorAspect}
        onAspectChange={reactor.setReactorAspect}
      />
    );
  }
  return null;
}
