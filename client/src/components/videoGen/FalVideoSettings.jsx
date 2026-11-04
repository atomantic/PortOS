import { FormField } from '../ui/FormField';
import { FAL_DEFAULT_IMAGE_VIDEO_MODEL, FAL_DEFAULT_TEXT_VIDEO_MODEL, FAL_VIDEO_MODELS, estimateFalVideoCostUsd } from '../../lib/falVideoModels.js';
import { formatUsd } from '../../utils/formatters';

export default function FalVideoSettings({
  mode, falModelId, setFalModelId, falDuration, setFalDuration, falModel,
  falResolution, setFalResolution, falResolutions, falGenerateAudio, setFalGenerateAudio, width, height,
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormField label="fal.ai model" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        {/* Free text stays: any fal endpoint id renders (on the legacy
            body, cost unknown); the list suggests the curated ones
            whose request body and price PortOS knows. */}
        <input
          type="text"
          list="fal-video-model-suggestions"
          value={falModelId}
          onChange={(e) => setFalModelId(e.target.value)}
          placeholder={mode === 'image' ? FAL_DEFAULT_IMAGE_VIDEO_MODEL : FAL_DEFAULT_TEXT_VIDEO_MODEL}
          className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        />
        <datalist id="fal-video-model-suggestions">
          {FAL_VIDEO_MODELS.filter((m) => m.kind === (mode === 'image' ? 'i2v' : 't2v')).map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </datalist>
      </FormField>
      <FormField label="Clip length (sec)" labelClassName="block text-xs font-medium text-gray-400 mb-1">
        <input
          type="number"
          min={1}
          max={60}
          value={falDuration}
          onChange={(e) => setFalDuration(e.target.value)}
          placeholder="model default"
          className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        />
      </FormField>
      {falModel?.resolution && (
        <FormField label="Resolution" labelClassName="block text-xs font-medium text-gray-400 mb-1">
          <select
            value={falResolution}
            onChange={(e) => setFalResolution(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          >
            <option value="">Model default</option>
            {falResolutions.map((resolution) => (
              <option key={resolution} value={resolution}>{resolution}</option>
            ))}
          </select>
        </FormField>
      )}
      {falModel?.audio && (
        <label htmlFor="fal-provider-audio" className="flex items-center gap-2 text-sm text-gray-400">
          <input
            id="fal-provider-audio"
            type="checkbox"
            checked={falGenerateAudio}
            onChange={(e) => setFalGenerateAudio(e.target.checked)}
            className="accent-port-accent"
          />
          Provider audio
        </label>
      )}
      <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
        Renders on fal.ai's queue API — leave the model blank to use PortOS's default (text-to-video, or image-to-video in Image mode). Counts against your fal.ai balance
        {(() => {
          const estimate = estimateFalVideoCostUsd({
            modelId: falModelId?.trim() || (mode === 'image' ? FAL_DEFAULT_IMAGE_VIDEO_MODEL : FAL_DEFAULT_TEXT_VIDEO_MODEL),
            seconds: falDuration === '' ? null : Number(falDuration),
            width, height, resolution: falResolution, generateAudio: falGenerateAudio,
          });
          return estimate == null
            ? ' — cost unknown for this model.'
            : ` — about ${formatUsd(estimate)} at list price, at ${falResolution || "the model's default resolution"} with provider audio ${falGenerateAudio ? 'on' : 'off'}.`;
        })()}
      </p>
    </div>
  );
}
