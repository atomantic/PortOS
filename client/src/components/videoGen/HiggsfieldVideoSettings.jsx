import { useState } from 'react';
import { FormField } from '../ui/FormField';
import HostedClipFields from './HostedClipFields.jsx';
import { hostedVideoClipOptions } from '../../lib/hostedVideoClipOptions.js';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { checkHiggsfieldNewModels } from '../../services/apiImageVideo.js';
import { formatUsd } from '../../utils/formatters';
import { HIGGSFIELD_DEFAULT_VIDEO_MODEL, HIGGSFIELD_VIDEO_MODELS, higgsfieldCapabilityHint } from '../../lib/higgsfieldVideoModels.js';

const SELECT_CLASS = 'w-full bg-port-bg border border-port-border rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

export default function HiggsfieldVideoSettings({
  higgsfieldModel, setHiggsfieldModelId, higgsfieldDuration, setHiggsfieldDuration,
  higgsfieldResolution, setHiggsfieldResolution, higgsfieldGenerateAudio, setHiggsfieldGenerateAudio,
  width, height, handleResolutionChange,
}) {
  const [unsupported, setUnsupported] = useState(null);
  const [runScan, scanning] = useAsyncAction(
    async () => setUnsupported((await checkHiggsfieldNewModels({ silent: true })).unsupported),
    { errorMessage: 'Could not check Higgsfield for new models' },
  );
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
              {`${m.label} · ${m.priceNote} · ${higgsfieldCapabilityHint(m)}${m.id === HIGGSFIELD_DEFAULT_VIDEO_MODEL ? ' (default)' : ''}`}
            </option>
          ))}
        </select>
      </FormField>
      <div className="col-span-2 -mt-1">
        <button
          type="button"
          onClick={runScan}
          disabled={scanning}
          className="px-2.5 py-1.5 min-h-[44px] pointer-fine:sm:min-h-0 text-xs rounded-lg border border-port-border text-gray-300 hover:border-port-accent hover:text-white disabled:opacity-50"
        >
          {scanning ? 'Checking Higgsfield…' : 'Check for new models'}
        </button>
        {unsupported && (unsupported.length === 0
          ? <p className="mt-1 text-[11px] text-gray-500">Every Higgsfield video model is already offered.</p>
          : (
            <div className="mt-1 text-[11px] text-gray-500 leading-snug">
              <p>Listed by Higgsfield but not offered here yet (each needs its request schema added first):</p>
              <ul className="mt-1 space-y-0.5">
                {unsupported.map((f) => (
                  <li key={f.family}>
                    <span className="text-gray-300">{f.title}</span>
                    {` · ${f.routes.join(', ')}`}
                    {f.maxSec != null && ` · ${f.minSec}–${f.maxSec}s`}
                    {f.resolutions.length > 0 && ` · ${f.resolutions.join('/')}`}
                    {f.pricePerSec != null && ` · from ${formatUsd(f.pricePerSec, { maximumFractionDigits: 3 })}/s`}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
      <HostedClipFields
        backend="higgsfield"
        options={hostedVideoClipOptions('higgsfield', higgsfieldModel.id)}
        duration={higgsfieldDuration}
        onDurationChange={setHiggsfieldDuration}
        resolution={higgsfieldResolution}
        onResolutionChange={setHiggsfieldResolution}
        generateAudio={higgsfieldGenerateAudio}
        onAudioChange={setHiggsfieldGenerateAudio}
        shape={{
          width, height, onChange: handleResolutionChange, className: 'col-span-2',
          note: 'Sets the shape: Higgsfield renders the closest aspect ratio it offers (a start frame sets its own).',
        }}
      />
      <p className="col-span-2 text-[11px] text-gray-500 leading-snug">
        Renders on Higgsfield&rsquo;s API from the prompt, a start frame (Image mode) or reference images (Text mode, on models
        that take them). Billed to your Higgsfield account at {higgsfieldModel.priceNote}; the exact charge shows in the Higgsfield console.
      </p>
    </div>
  );
}
