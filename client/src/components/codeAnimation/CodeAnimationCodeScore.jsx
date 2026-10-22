import { useEffect, useState } from 'react';
import CodePanel from '../music/CodePanel';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import { ensureCodeAnimationSoundtrackTrack } from '../../services/api';
import { formatCount } from '../../utils/formatters';

// Mirrors MAX_SCENE in server/services/musicCode.js.
const SCRIPT_MAX = 20000;

const inputClass = 'w-full rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:border-port-accent focus:outline-none';
const labelClass = 'mb-1 block text-xs text-gray-400';

/** The animation's own words, offered as the coding model's script. */
export function animationScript(job) {
  const input = job?.input || {};
  return [
    input.title || job?.title || '',
    input.concept || '',
    input.onScreenText ? `On-screen text:\n${input.onScreenText}` : '',
  ].map((part) => part.trim()).filter(Boolean).join('\n\n');
}

/**
 * A coding model writes the soundtrack as Strudel, Tone.js or SuperCollider
 * code from the animation script, at the film's length. The take saves onto
 * the animation's soundtrack track (created on the first save), which then
 * becomes the animation's audio.
 */
export default function CodeAnimationCodeScore({
  job, trackId, description, filmSec, pin, onPinChange, onSaved,
}) {
  const [script, setScript] = useState(() => animationScript(job));
  const [effort, setEffort] = useState(pin?.effort || '');
  const [pinApplied, setPinApplied] = useState(false);
  useEffect(() => { setScript(animationScript(job)); }, [job?.id]);

  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading,
  } = useProviderModels({ silent: true, withEffort: true });

  // Open on the last pick, else on the provider that wrote the animation.
  useEffect(() => {
    if (pinApplied || loading || !providers.length) return;
    setPinApplied(true);
    const wanted = pin?.providerId ? pin : { providerId: job?.providerId, model: job?.model };
    const provider = providers.find((item) => item.id === wanted.providerId);
    if (!provider) return;
    setSelectedProviderId(provider.id);
    const models = (provider.models?.length ? provider.models : [provider.defaultModel])
      .map((model) => (typeof model === 'string' ? model : model?.id)).filter(Boolean);
    if (wanted.model && models.includes(wanted.model)) setSelectedModel(wanted.model);
  }, [pinApplied, loading, providers, pin, job?.providerId, job?.model, setSelectedProviderId, setSelectedModel]);

  const remember = (patch) => onPinChange({ providerId: selectedProviderId || '', model: selectedModel || '', effort, ...patch });

  const providerPicker = (
    <ProviderModelSelector
      providers={providers}
      selectedProviderId={selectedProviderId}
      selectedModel={selectedModel}
      availableModels={availableModels}
      onProviderChange={(providerId) => { setSelectedProviderId(providerId); setEffort(''); remember({ providerId, model: '', effort: '' }); }}
      onModelChange={(model) => { setSelectedModel(model); remember({ model }); }}
      effort={effort}
      onEffortChange={(next) => { setEffort(next); remember({ effort: next }); }}
      disabled={loading}
      layout="stacked"
    />
  );

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="ca-soundtrack-script" className={labelClass}>Animation script (sent to the coding model)</label>
        <textarea id="ca-soundtrack-script" rows={4} value={script} maxLength={SCRIPT_MAX}
          onChange={(event) => setScript(event.target.value)}
          className={`${inputClass} resize-y`} />
        {script.length > SCRIPT_MAX && (
          <p role="alert" className="text-xs text-port-warning">The script has {formatCount(script.length)} characters; the limit is {formatCount(SCRIPT_MAX)}.</p>
        )}
      </div>
      <CodePanel
        trackId={trackId || null}
        draftKey={`code-animation:${job.id}`}
        resolveTrackId={async () => (await ensureCodeAnimationSoundtrackTrack(job.id, { silent: true }))?.trackId}
        description={description}
        scene={script}
        fixedLengthSec={filmSec || null}
        title=""
        providerId={selectedProviderId}
        model={selectedModel}
        effort={effort}
        providerPicker={providerPicker}
        onRendered={onSaved}
      />
    </div>
  );
}
