import { FormField } from '../ui/FormField';
import ResolutionField from '../media/ResolutionField';
import { VIDEO_RESOLUTIONS } from '../../lib/videoGenResolutions';
import { VIDEO_EDGE_BOUNDS } from '../../lib/videoGenParams.js';
import { GOOGLE_DEFAULT_VIDEO_MODEL, GOOGLE_VIDEO_MODELS } from '../../lib/googleVideoModels.js';

const SELECT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

export default function GoogleVideoSettings({
  googleModel, setGoogleModelId, googleDuration, setGoogleDuration,
  googleResolution, setGoogleResolution, googleGenerateAudio, setGoogleGenerateAudio,
  width, height, handleResolutionChange,
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField className="col-span-2" label="Veo model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          id="google-video-model"
          value={googleModel.id}
          onChange={(e) => setGoogleModelId(e.target.value)}
          className={SELECT_CLASS}
        >
          {GOOGLE_VIDEO_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {`${m.label} · ${m.priceNote}${m.id === GOOGLE_DEFAULT_VIDEO_MODEL ? ' (default)' : ''}`}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Clip length" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          id="google-video-length"
          value={googleDuration}
          onChange={(e) => setGoogleDuration(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">{`${googleModel.defaultSec}s (default)`}</option>
          {googleModel.lengths.map((sec) => <option key={sec} value={String(sec)}>{sec} seconds</option>)}
        </select>
      </FormField>
      <FormField label="Output size" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          id="google-video-resolution"
          value={googleResolution}
          onChange={(e) => setGoogleResolution(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">{`${googleModel.defaultResolution} (default)`}</option>
          {googleModel.resolutions.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
        </select>
      </FormField>
      <div className="col-span-2">
        <ResolutionField
          presets={VIDEO_RESOLUTIONS}
          width={width}
          height={height}
          onChange={handleResolutionChange}
          {...VIDEO_EDGE_BOUNDS}
          snapOnBlur
          note="Sets the shape: Veo renders 16:9 or 9:16, whichever is closer (a start frame sets its own)."
        />
      </div>
      <label htmlFor="google-provider-audio" className="flex items-center gap-2 text-sm text-gray-400">
        <input
          id="google-provider-audio"
          type="checkbox"
          checked={googleGenerateAudio}
          onChange={(e) => setGoogleGenerateAudio(e.target.checked)}
          className="accent-port-accent"
        />
        Provider audio
      </label>
      <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
        Renders on Google Cloud Agent Platform from the prompt, a start frame (Image mode) or reference images (Text mode, Veo 3.1,
        8-second clips). Billed to your Google Cloud account at {googleModel.priceNote}; the billing console shows the exact charge.
      </p>
    </div>
  );
}
