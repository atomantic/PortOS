import { FormField } from '../ui/FormField';
import RunwayCatalogStatus from '../imageGen/RunwayCatalogStatus.jsx';
import RunwayVideoInputPanel from './RunwayVideoInputPanel.jsx';
import ResolutionField from '../media/ResolutionField';
import { VIDEO_RESOLUTIONS } from '../../lib/videoGenResolutions';
import { VIDEO_EDGE_BOUNDS } from '../../lib/videoGenParams.js';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, describeRunwayVideoRate, estimateRunwayVideoCostUsd, runwayVideoLengths } from '../../lib/runwayVideoModels.js';
import { formatUsd } from '../../utils/formatters';

export default function RunwayVideoSettings({
  mode, runwayCatalog, runwayModel, runwayModelId, setRunwayModelId, runwaySpecial,
  runwayInputs, setRunwayInputs, runwayDuration, setRunwayDuration, width, height,
  handleResolutionChange, runwayResolutions, runwayResolution, setRunwayResolution, runwaySizeModel,
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="col-span-2"><RunwayCatalogStatus catalog={runwayCatalog} /></div>
      <FormField className="col-span-2" label="Runway model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          id="runway-video-model"
          value={runwayModel?.id || runwayModelId}
          onChange={(e) => setRunwayModelId(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        >
          {!runwayCatalog.videoModels.some((m) => m.id === runwayModel?.id) && <option value={runwayModel?.id || runwayModelId}>{runwayModel?.label || runwayModelId} (unavailable)</option>}
          {runwayCatalog.videoModels.map((m) => (
            <option key={m.id} value={m.id}>
              {`${m.label} · ${describeRunwayVideoRate(m.id) || 'price varies'}${m.id === RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL ? ' (default)' : ''}`}
            </option>
          ))}
        </select>
      </FormField>
      {runwaySpecial ? <RunwayVideoInputPanel key={mode} mode={mode} value={runwayInputs} onChange={setRunwayInputs} /> : <>
      <FormField label="Clip length" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <select
          id="runway-video-length"
          value={runwayDuration}
          onChange={(e) => setRunwayDuration(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        >
          <option value="">{`${runwayModel?.duration.defaultSec}s (default)`}</option>
          {runwayVideoLengths(runwayModel).map((sec) => <option key={sec} value={String(sec)}>{sec} seconds</option>)}
        </select>
      </FormField>
      <ResolutionField
        presets={VIDEO_RESOLUTIONS}
        width={width}
        height={height}
        onChange={handleResolutionChange}
        {...VIDEO_EDGE_BOUNDS}
        snapOnBlur
        note="Sets the shape: Runway renders the closest aspect ratio it offers."
      />
      {runwayResolutions.length > 1 && (
        <FormField label="Output size" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            id="runway-video-resolution"
            value={runwayResolution}
            onChange={(e) => setRunwayResolution(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          >
            <option value="">{`${runwaySizeModel.size.default} (default)`}</option>
            {runwayResolutions.map((res) => <option key={res} value={res}>{`${res} · ${describeRunwayVideoRate(runwayModel.id, res) || 'price varies'}`}</option>)}
          </select>
        </FormField>
      )}
      </>}
      <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
        {runwaySpecial ? 'Uses your video inputs' : mode === 'image' ? 'Animates your start frame' : 'Renders from your prompt'} on the Runway API. Counts against your Runway credits
        {(() => {
          const estimate = estimateRunwayVideoCostUsd({
            modelId: runwayModel?.id, seconds: runwayDuration === '' ? null : Number(runwayDuration), resolution: runwayResolution,
          });
          return estimate == null ? ' — cost unknown for this model.' : ` — about ${formatUsd(estimate)} at list price.`;
        })()}
      </p>
    </div>
  );
}
