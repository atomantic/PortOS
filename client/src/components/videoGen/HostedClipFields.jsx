import { FormField } from '../ui/FormField';
import ResolutionField from '../media/ResolutionField';
import { VIDEO_RESOLUTIONS } from '../../lib/videoGenResolutions';
import { VIDEO_EDGE_BOUNDS } from '../../lib/videoGenParams.js';

const INPUT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';
const LABEL_CLASS = 'block text-xs font-medium text-gray-400 mb-1';

export default function HostedClipFields({
  backend, options, duration, onDurationChange, resolution, onResolutionChange,
  generateAudio, onAudioChange, shape, showSize = true, formatSize = (size) => size,
}) {
  const shapeField = shape && (
    <div className={shape.className}>
      <ResolutionField
        presets={VIDEO_RESOLUTIONS}
        width={shape.width}
        height={shape.height}
        onChange={shape.onChange}
        {...VIDEO_EDGE_BOUNDS}
        snapOnBlur
        note={shape.note}
      />
    </div>
  );
  return (
    <>
      {options?.lengths.length > 0 && (
        <FormField label="Clip length" labelClassName={LABEL_CLASS}>
          <select
            id={`${backend}-video-length`}
            value={duration}
            onChange={(e) => onDurationChange(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">{`${options.defaultSec}s (default)`}</option>
            {options.lengths.map((sec) => <option key={sec} value={String(sec)}>{sec} seconds</option>)}
          </select>
        </FormField>
      )}
      {backend === 'fal' && !options && (
        <FormField label="Clip length (sec)" labelClassName={LABEL_CLASS}>
          <input
            type="number"
            min={1}
            max={60}
            value={duration}
            onChange={(e) => onDurationChange(e.target.value)}
            placeholder="model default"
            className={INPUT_CLASS}
          />
        </FormField>
      )}
      {backend === 'runway' && shapeField}
      {showSize && options?.resolutions.length > 0 && (
        <FormField label={backend === 'fal' ? 'Resolution' : 'Output size'} labelClassName={LABEL_CLASS}>
          <select
            id={`${backend}-video-resolution`}
            value={resolution}
            onChange={(e) => onResolutionChange(e.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">{`${options.defaultResolution} (default)`}</option>
            {options.resolutions.map((size) => <option key={size} value={size}>{formatSize(size)}</option>)}
          </select>
        </FormField>
      )}
      {backend !== 'runway' && shapeField}
      {options?.hasAudioSwitch && (
        <label htmlFor={`${backend}-provider-audio`} className="flex items-center gap-2 text-sm text-gray-400">
          <input
            id={`${backend}-provider-audio`}
            type="checkbox"
            checked={generateAudio}
            onChange={(e) => onAudioChange(e.target.checked)}
            className="accent-port-accent"
          />
          Provider audio
        </label>
      )}
    </>
  );
}
