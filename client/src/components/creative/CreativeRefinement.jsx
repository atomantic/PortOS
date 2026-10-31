import SentPromptPanel from '../media/SentPromptPanel';
import { useId, useRef, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import useMounted from '../../hooks/useMounted';

// The host owns persistence and decides which draft fields may be proposed.
// `onFork(fields)` (optional) saves the proposal onto a new fork instead of the editor.
export default function CreativeRefinement({ initialDraft, fieldLimits = {}, converse, onApply, onFork, disabled = false }) {
  const id = useId();
  const mounted = useMounted();
  const flight = useRef(false);
  const selection = useProviderModels({ withEffort: true });
  const [effort, setEffort] = useState('');
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState(null);
  const proposalBase = useRef(null);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);
  const [hasProposal, setHasProposal] = useState(false);
  const [resolutions, setResolutions] = useState({});
  const patchEntries = hasProposal ? Object.entries(draft).filter(([key, value]) => value !== proposalBase.current?.[key]) : [];
  const conflicts = patchEntries.filter(([key, value]) => initialDraft[key] !== proposalBase.current?.[key] && initialDraft[key] !== value);
  const resolutionFor = (key, value) => {
    const resolution = resolutions[key];
    return resolution?.current === initialDraft[key] && resolution?.proposed === value ? resolution.choice : null;
  };
  const run = async (preview = false) => {
    if (flight.current || !feedback.trim() || !selection.selectedProviderId) return;
    flight.current = true; setBusy(true); setError('');
    const turns = [...messages, { role: 'user', content: feedback }];
    const currentDraft = hasProposal ? draft : initialDraft;
    if (!preview && !hasProposal) proposalBase.current = currentDraft;
    const result = await converse({ draft: currentDraft, messages: turns, providerId: selection.selectedProviderId,
      model: selection.selectedModel || undefined, effort: effort || undefined }, { preview, silent: true })
      .catch(err => { if (mounted.current) setError(err.message); return null; });
    flight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (!result) return;
    setSent({ sentPrompt: result.sentPrompt, additions: result.promptAdditions || [], prompt: feedback });
    if (!preview) {
      setMessages([...turns, { role: 'assistant', content: result.reply }]);
      setDraft(result.draft); setFeedback(''); setHasProposal(true);
    }
  };
  return <section aria-label="Creative redesign conversation" className="rounded border border-port-border p-3 space-y-3 min-w-0">
    <p className="text-sm font-semibold">Experiment with a redesign</p>
    <p className="text-xs text-gray-400">{onFork ? 'Suggestions stay here until applied to your editor or saved as a fork, which leaves the original as it is.'
      : 'Fork into this universe first to preserve the original. Suggestions stay here until applied to your editor; Save commits your changes.'}</p>
    <ProviderModelSelector providers={selection.providers} selectedProviderId={selection.selectedProviderId}
      selectedModel={selection.selectedModel} availableModels={selection.availableModels}
      onProviderChange={selection.setSelectedProviderId} onModelChange={selection.setSelectedModel}
      effort={effort} onEffortChange={setEffort} loading={selection.loading} disabled={busy} />
    <div role="log" aria-label="Redesign conversation" className="space-y-2 max-h-80 overflow-y-auto break-words">
      {messages.map((message, index) => <p key={index} className="text-sm whitespace-pre-wrap"><strong>{message.role === 'user' ? 'You' : 'Creative assistant'}:</strong> {message.content}</p>)}
    </div>
    <label htmlFor={`${id}-feedback`} className="block text-xs">Direction or follow-up question</label>
    <textarea id={`${id}-feedback`} value={feedback} onChange={event => { setFeedback(event.target.value); setSent(null); }} maxLength={16000} rows={3}
      disabled={busy || messages.length >= 40} className="w-full bg-port-bg border border-port-border rounded p-2 text-sm" />
    <div className="flex flex-wrap gap-3 text-sm">
      <button type="button" onClick={() => run()} disabled={busy || !feedback.trim() || !selection.selectedProviderId || messages.length >= 40} className="min-h-11 rounded border border-port-accent px-3 py-2 text-port-accent hover:bg-port-accent/10 disabled:opacity-40">{busy ? 'Working…' : 'Send direction'}</button>
      <button type="button" onClick={() => run(true)} disabled={busy || !feedback.trim() || !selection.selectedProviderId || messages.length >= 40} className="min-h-11 rounded border border-port-accent px-3 py-2 text-port-accent hover:bg-port-accent/10 disabled:opacity-40">Preview prompt and context</button>
    </div>
    {error && <p role="alert" className="text-port-error text-sm">{error}</p>}
    {sent && <SentPromptPanel {...sent} />}
    {hasProposal && <div className="space-y-2">
      {Object.entries(draft).map(([key, value]) => <div key={key}><label htmlFor={`${id}-${key}`} className="block text-xs">{key.replace(/([A-Z])/g, ' $1')}</label>
        <textarea id={`${id}-${key}`} value={value} maxLength={fieldLimits[key] ?? 12000} disabled={busy} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} rows={3} className="w-full bg-port-bg border border-port-border rounded p-2 text-sm" /></div>)}
      {conflicts.map(([key, value]) => <div key={key} className="rounded border border-port-warning p-3 space-y-2 text-sm">
        <p>The editor and proposal both changed {key.replace(/([A-Z])/g, ' $1')}. Choose which to keep.</p>
        <p className="whitespace-pre-wrap break-words"><strong>Editor:</strong> {initialDraft[key]}</p>
        <p className="whitespace-pre-wrap break-words"><strong>Proposal:</strong> {value}</p>
        <div className="flex flex-wrap gap-2">
          {['editor', 'proposal'].map(choice => <button key={choice} type="button" aria-pressed={resolutionFor(key, value) === choice}
            onClick={() => setResolutions(previous => ({ ...previous, [key]: { current: initialDraft[key], proposed: value, choice } }))}
            className="min-h-11 rounded border border-port-accent px-3 py-2 text-port-accent hover:bg-port-accent/10 aria-pressed:bg-port-accent/20">
            {choice === 'editor' ? 'Keep editor' : 'Use proposal'} for {key.replace(/([A-Z])/g, ' $1')}
          </button>)}
        </div>
      </div>)}
      <button type="button" disabled={disabled || busy || conflicts.some(([key, value]) => !resolutionFor(key, value))} onClick={() => {
        const patch = Object.fromEntries(patchEntries.filter(([key, value]) => resolutionFor(key, value) !== 'editor'));
        onApply(patch); setHasProposal(false); setResolutions({});
      }} className="min-h-11 rounded border border-port-accent px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-40">Apply proposal to editor</button>
      {onFork && <button type="button" disabled={busy || !patchEntries.length} onClick={() => onFork(Object.fromEntries(patchEntries))}
        className="ml-2 min-h-11 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-40">Save as fork…</button>}
    </div>}
  </section>;
}
