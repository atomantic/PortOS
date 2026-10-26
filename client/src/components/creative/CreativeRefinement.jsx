import SentPromptPanel from '../media/SentPromptPanel';
import { useId, useRef, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import useMounted from '../../hooks/useMounted';

// The host owns persistence and decides which draft fields may be proposed.
export default function CreativeRefinement({ initialDraft, fieldLimits = {}, converse, onApply, disabled = false }) {
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
    <p className="text-xs text-gray-400">Fork into this universe first to preserve the original. Suggestions stay here until applied to your editor; Save commits your changes.</p>
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
      <button type="button" disabled={disabled || busy} onClick={() => {
        const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== proposalBase.current?.[key]));
        onApply(patch); setHasProposal(false);
      }} className="min-h-11 rounded border border-port-accent px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-40">Apply proposal to editor</button>
    </div>}
  </section>;
}
