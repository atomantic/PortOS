import { FormField } from '../ui/FormField';
import HostedClipFields from './HostedClipFields.jsx';
import { hostedVideoClipOptions } from '../../lib/hostedVideoClipOptions.js';
import { FAL_DEFAULT_IMAGE_VIDEO_MODEL, FAL_DEFAULT_TEXT_VIDEO_MODEL, FAL_VIDEO_MODELS, estimateFalVideoCostUsd, falCapabilityHint } from '../../lib/falVideoModels.js';
import { formatUsd } from '../../utils/formatters';

export default function FalVideoSettings({
  mode, falModelId, setFalModelId, falDuration, setFalDuration,
  falResolution, setFalResolution, falGenerateAudio, setFalGenerateAudio, width, height,
}) {
  const defaultModelId = mode === 'image' ? FAL_DEFAULT_IMAGE_VIDEO_MODEL : FAL_DEFAULT_TEXT_VIDEO_MODEL;
  const selectedModelId = falModelId.trim();
  const options = hostedVideoClipOptions('fal', selectedModelId || defaultModelId);
  // Jobs queued before the picker could restore a duration between supported steps.
  const duration = options && falDuration !== '' ? String(options.coerceSeconds(falDuration)) : falDuration;
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
          placeholder={defaultModelId}
          className="w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
        />
        <datalist id="fal-video-model-suggestions">
          {FAL_VIDEO_MODELS.filter((m) => m.kind === (mode === 'image' ? 'i2v' : 't2v')).map((m) => (
            <option key={m.id} value={m.id}>{m.label} · {falCapabilityHint(m)}</option>
          ))}
        </datalist>
      </FormField>
      <HostedClipFields
        backend="fal"
        options={options}
        duration={duration}
        onDurationChange={setFalDuration}
        resolution={falResolution}
        onResolutionChange={setFalResolution}
        generateAudio={falGenerateAudio}
        onAudioChange={setFalGenerateAudio}
        showSize={Boolean(selectedModelId)}
      />
      <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
        Renders on fal.ai's queue API — leave the model blank to use PortOS's default (text-to-video, or image-to-video in Image mode). Counts against your fal.ai balance
        {(() => {
          const estimate = estimateFalVideoCostUsd({
            modelId: selectedModelId || defaultModelId,
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
