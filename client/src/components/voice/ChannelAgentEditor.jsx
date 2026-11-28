import { useId, useRef, useState } from 'react';
import { mergeChannelAgentPatch } from '../../../../server/lib/voiceChannels.js';
import { RotateCcw } from 'lucide-react';
import BlurCommitTextarea from '../ui/BlurCommitTextarea';
import useVoiceLlmProviders from '../../hooks/useVoiceLlmProviders';
import ChoiceChip from './ChoiceChip';
import VoiceLlmFields from './VoiceLlmFields';
import VoicePicker from './VoicePicker';

// Suggestions only: any value the user types is kept as written.
const SPEECH_STYLES = ['casual and brief', 'warm and gentle', 'formal and precise', 'dry and witty', 'calm and unhurried', 'upbeat and energetic'];
const ROLES = ['Chief of Staff', 'Research assistant', 'Coding partner', 'Creative director', 'Coach', 'Dispatcher', 'Storyteller'];
const TRAITS = ['concise', 'warm', 'proactive', 'curious', 'playful', 'skeptical', 'patient', 'direct', 'encouraging', 'witty', 'calm', 'meticulous'];
const TRAIT_MAX = 20;

const LABEL = 'block font-mono text-[10px] uppercase tracking-[0.14em] text-port-text-muted';
const INPUT = 'min-h-11 w-full min-w-0 rounded-lg border border-port-border bg-port-card px-2.5 font-mono text-xs text-port-text placeholder:text-port-text-muted focus:border-port-accent focus:outline-none';

/** A text field that saves on blur or Enter and follows saves from elsewhere while not being edited. */
function BlurInput({ id, label, value, onCommit, ...rest }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <input
      id={id}
      type="text"
      aria-label={label}
      value={draft ?? value}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      className={INPUT}
      {...rest}
    />
  );
}

function ChannelLlm({ agent, defaults, save }) {
  const { apiProviders, refreshing, refreshModels } = useVoiceLlmProviders();
  return (
    <VoiceLlmFields
      compact
      provider={agent.provider}
      model={agent.model || 'auto'}
      apiProviders={apiProviders}
      refreshing={refreshing}
      onRefreshModels={refreshModels}
      onChange={({ provider, model }) => save({ provider, model })}
      onSetupComplete={({ provider, model }) => save({ provider: provider || defaults.provider, model })}
    />
  );
}

/**
 * One channel's agent: voice, LLM and persona. Every field starts on "Default" and
 * inherits Settings → Voice until the user picks something for this channel.
 */
export default function ChannelAgentEditor({ number, agent: savedAgent = {}, defaults = {}, onSave }) {
  const id = useId();
  const persona = defaults.personality || {};
  // Each save sends only the fields it changes and the server merges them, so quick
  // successive edits all land. The edits in flight show at once, and the overlay
  // drops once the latest save settles and the saved agent has caught up.
  const [pending, setPending] = useState([]);
  const saveSeq = useRef(0);
  const agent = pending.reduce(mergeChannelAgentPatch, savedAgent);
  const send = (patch) => {
    const seq = ++saveSeq.current;
    setPending((list) => [...list, patch]);
    Promise.resolve(onSave(patch)).catch(() => {}).finally(() => {
      if (seq === saveSeq.current) setPending([]);
    });
  };
  const save = (change) => send(Object.fromEntries(
    Object.entries(change).map(([field, value]) => [field, value === '' || value === undefined ? null : value]),
  ));

  const ownLlm = Boolean(agent.provider);
  const style = agent.speechStyle || '';
  const styleOptions = style && !SPEECH_STYLES.includes(style) ? [...SPEECH_STYLES, style] : SPEECH_STYLES;
  const ownTraits = Array.isArray(agent.traits);
  const traits = ownTraits ? agent.traits : (persona.traits || []);
  const traitOptions = [...new Set([...TRAITS, ...(persona.traits || []), ...traits])];
  const toggleTrait = (trait) => {
    const next = traits.includes(trait) ? traits.filter((t) => t !== trait) : [...traits, trait].slice(0, TRAIT_MAX);
    save({ traits: next });
  };
  const addTrait = (text) => {
    const trait = text.trim().toLowerCase();
    if (trait && !traits.includes(trait)) save({ traits: [...traits, trait].slice(0, TRAIT_MAX) });
  };
  const tuned = Object.keys(agent).length > 0;
  const brainDefault = defaults.model && defaults.model !== 'auto' ? defaults.model : `${defaults.provider || 'lmstudio'} (auto)`;

  return (
    <div role="group" aria-label={`Agent for channel ${number}`} className="flex min-w-0 flex-col gap-3 rounded-lg border border-port-border bg-port-card p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-[11px] text-port-text-muted">Anything left on Default follows Settings → Voice.</p>
        {tuned && (
          <button type="button" onClick={() => send(null)} className="satphone-key inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[10px] font-semibold uppercase tracking-wider">
            <RotateCcw size={12} aria-hidden="true" />
            Use defaults
          </button>
        )}
      </div>

      <VoicePicker
        label="Voice"
        value={agent.voiceId || null}
        onChange={(voiceId) => save({ voiceId })}
        placeholder={`Default${defaults.voiceLabel ? ` (${defaults.voiceLabel})` : ''}`}
      />

      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Voice brain (LLM)</span>
        <div className="flex flex-wrap gap-1.5">
          <ChoiceChip pressed={!ownLlm} onClick={() => save({ provider: null })} title="Use the global voice LLM">
            {`Default (${brainDefault})`}
          </ChoiceChip>
          <ChoiceChip pressed={ownLlm} onClick={ownLlm ? undefined : () => save({ provider: defaults.provider || 'lmstudio', model: defaults.model || 'auto' })} title="Pick an LLM for this channel">
            Own LLM
          </ChoiceChip>
        </div>
        {ownLlm && <ChannelLlm agent={agent} defaults={defaults} save={save} />}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span aria-hidden="true" className={LABEL}>Name</span>
          <BlurInput id={`${id}-name`} label="Name" value={agent.name || ''} maxLength={64} placeholder={persona.name || 'Default'} onCommit={(name) => save({ name })} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <span aria-hidden="true" className={LABEL}>Role</span>
          <BlurInput id={`${id}-role`} label="Role" value={agent.role || ''} maxLength={128} list={`${id}-roles`} placeholder={persona.role || 'Default'} onCommit={(role) => save({ role })} />
          <datalist id={`${id}-roles`}>{ROLES.map((role) => <option key={role} value={role} />)}</datalist>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Speech style</span>
        <div role="group" aria-label={`Speech style for channel ${number}`} className="flex flex-wrap gap-1.5">
          <ChoiceChip pressed={!style} onClick={() => save({ speechStyle: null })} title="Use the global speech style">
            {`Default${persona.speechStyle ? ` (${persona.speechStyle})` : ''}`}
          </ChoiceChip>
          {styleOptions.map((option) => (
            <ChoiceChip key={option} pressed={style === option} onClick={() => save({ speechStyle: option })}>{option}</ChoiceChip>
          ))}
        </div>
        <BlurInput
          label={`Describe the speech style for channel ${number}`}
          value={style && !SPEECH_STYLES.includes(style) ? style : ''}
          maxLength={256}
          placeholder="Or describe it…"
          onCommit={(speechStyle) => save({ speechStyle })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={LABEL}>Traits</span>
        <div role="group" aria-label={`Traits for channel ${number}`} className="flex flex-wrap gap-1.5">
          <ChoiceChip pressed={!ownTraits} onClick={() => save({ traits: null })} title="Use the global traits">Default</ChoiceChip>
          {traitOptions.map((trait) => (
            <ChoiceChip key={trait} pressed={traits.includes(trait)} onClick={() => toggleTrait(trait)} className={ownTraits ? '' : 'opacity-70'}>
              {trait}
            </ChoiceChip>
          ))}
        </div>
        <BlurInput label={`Add a trait to channel ${number}`} value="" maxLength={64} placeholder="Add a trait…" onCommit={addTrait} />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-prompt`} className={LABEL}>Custom prompt</label>
        <BlurCommitTextarea
          id={`${id}-prompt`}
          rows={2}
          maxLength={2000}
          value={agent.customPrompt || ''}
          placeholder={persona.customPrompt || 'Default (nothing extra)'}
          onCommit={(customPrompt) => save({ customPrompt: customPrompt.trim() })}
          className="min-h-[60px] w-full rounded-lg border border-port-border bg-port-bg px-2.5 py-2 font-mono text-xs text-port-text placeholder:text-port-text-muted focus:border-port-accent focus:outline-none"
        />
      </div>
    </div>
  );
}
