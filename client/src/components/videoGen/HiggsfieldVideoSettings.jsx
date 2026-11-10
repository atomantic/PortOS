import { FormField } from '../ui/FormField';
import ResolutionField from '../media/ResolutionField';
import { VIDEO_RESOLUTIONS } from '../../lib/videoGenResolutions';
import { VIDEO_EDGE_BOUNDS } from '../../lib/videoGenParams.js';
import { HIGGSFIELD_DEFAULT_VIDEO_MODEL, HIGGSFIELD_VIDEO_MODELS, higgsfieldVideoLengths } from '../../lib/higgsfieldVideoModels.js';

const SELECT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

export default function HiggsfieldVideoSettings({
  higgsfieldModel, setHiggsfieldModelId, higgsfieldDuration, setHiggsfieldDuration,
  higgsfieldResolution, setHiggsfieldResolution, higgsfieldGenerateAudio, setHiggsfieldGenerateAudio,
  width, height, handleResolutionChange,
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField className="col-span-2" label="Higgsfield model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          id="higgsfield-video-model"
          value={higgsfieldModel.id}
          onChange={(e) => setHiggsfieldModelId(e.target.value)}
          className={SELECT_CLASS}
        >
          {HIGGSFIELD_VIDEO_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {`${m.label} · ${m.priceNote}${m.id === HIGGSFIELD_DEFAULT_VIDEO_MODEL ? ' (default)' : ''}`}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Clip length" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          id="higgsfield-video-length"
          value={higgsfieldDuration}
          onChange={(e) => setHiggsfieldDuration(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">{`${higgsfieldModel.duration.defaultSec}s (default)`}</option>
          {higgsfieldVideoLengths(higgsfieldModel).map((sec) => <option key={sec} value={String(sec)}>{sec} seconds</option>)}
        </select>
      </FormField>
      {higgsfieldModel.resolutions && (
        <FormField label="Output size" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            id="higgsfield-video-resolution"
            value={higgsfieldResolution}
            onChange={(e) => setHiggsfieldResolution(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">{`${higgsfieldModel.defaultResolution} (default)`}</option>
            {higgsfieldModel.resolutions.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
          </select>
        </FormField>
      )}
      <div className="col-span-2">
        <ResolutionField
          presets={VIDEO_RESOLUTIONS}
          width={width}
          height={height}
          onChange={handleResolutionChange}
          {...VIDEO_EDGE_BOUNDS}
          snapOnBlur
          note="Sets the shape: Higgsfield renders the closest aspect ratio it offers (a start frame sets its own)."
        />
      </div>
      {higgsfieldModel.audio && (
        <label htmlFor="higgsfield-provider-audio" className="flex items-center gap-2 text-sm text-gray-400">
          <input
            id="higgsfield-provider-audio"
            type="checkbox"
            checked={higgsfieldGenerateAudio}
            onChange={(e) => setHiggsfieldGenerateAudio(e.target.checked)}
            className="accent-port-accent"
          />
          Provider audio
        </label>
      )}
      <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
        Renders on Higgsfield&rsquo;s API from the prompt, a start frame (Image mode) or reference images (Text mode, on models
        that take them). Billed to your Higgsfield account at {higgsfieldModel.priceNote}; the exact charge shows in the Higgsfield console.
      </p>
    </div>
  );
}
