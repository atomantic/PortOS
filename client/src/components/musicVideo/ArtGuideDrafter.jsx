import { useRef, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import SentPromptPanel from '../media/SentPromptPanel.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { proposeMusicVideoArtGuides } from '../../services/apiMusicVideo.js';

const button = 'min-h-[44px] rounded border border-port-border px-3 py-1.5 text-sm disabled:opacity-50 sm:min-h-0';
const LABELS = { cast: 'Cast guide', environments: 'Environment guide', visualLanguage: 'Visual language and mood board' };

/**
 * Drafts the Cast guide, Environment guide and Visual language from the
 * director's "Story in your own words". Nothing is saved here: `onUse(fields)`
 * puts the chosen text into the planning draft, which the director saves.
 */
export default function ArtGuideDrafter({ project, disabled, onUse }) {
  const [open, setOpen] = useState(false);
  const llm = useProviderModels({ withEffort: true, silent: true, enabled: open });
  const [effort, setEffort] = useState('');
  const [executionOptions, setExecutionOptions] = useState({});
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState(null);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const flight = useRef(false);
  const hasStory = !!project.storySummary?.trim();
  const fieldId = `mv-art-guides-${project.id}`;

  const run = async (preview = false) => {
    if (flight.current || disabled || !hasStory || !llm.selectedProviderId) return;
    flight.current = true; setBusy(true); setError('');
    const result = await proposeMusicVideoArtGuides(project.id, { providerId: llm.selectedProviderId, model: llm.selectedModel || undefined,
      effort: effort || undefined, executionOptions, ...(instruction.trim() ? { instruction } : {}), preview }, { silent: true })
      .catch((err) => { setError(err?.message || 'Could not draft the guides.'); return null; });
    flight.current = false; setBusy(false);
    if (!result) return;
    setSent({ prompt: instruction, sentPrompt: result.sentPrompt, additions: result.promptAdditions });
    if (!preview) setProposal(result.proposal);
  };
  const proposed = Object.keys(LABELS).filter((key) => proposal?.[key]?.trim());

  if (!open) {
    return (
      <div className="space-y-1">
        <button type="button" className={button} disabled={disabled || !hasStory} onClick={() => setOpen(true)}>Draft guides from my story</button>
        {!hasStory && <p className="text-xs text-port-text-muted">Write the story in your own words on the Story step to draft these guides from it.</p>}
      </div>
    );
  }
  return (
    <section className="space-y-2 rounded border border-port-border p-2" aria-label="Draft guides from my story">
      <p className="text-xs text-port-text-muted">Drafts the Cast guide, Environment guide and Visual language from your story. Nothing changes until you use a draft and save.</p>
      <ProviderModelSelector providers={llm.providers} selectedProviderId={llm.selectedProviderId} selectedModel={llm.selectedModel}
        availableModels={llm.availableModels} onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); setExecutionOptions({}); }} onModelChange={llm.setSelectedModel}
        effort={effort} onEffortChange={setEffort} executionOptions={executionOptions} onExecutionOptionsChange={setExecutionOptions}
        loading={llm.loading} disabled={busy || disabled} />
      <label htmlFor={`${fieldId}-instruction`} className="block text-xs text-port-text-muted">Anything to add (optional)
        <textarea id={`${fieldId}-instruction`} rows={2} maxLength={4000} value={instruction} onChange={(e) => setInstruction(e.target.value)}
          placeholder="For example: she is seen at 8, 17 and 40; nobody sings on camera"
          className="w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy || disabled || !llm.selectedProviderId} onClick={() => run()}>{busy ? 'Drafting…' : proposal ? 'Draft again' : 'Draft guides'}</button>
        <button type="button" className={button} disabled={busy || disabled || !llm.selectedProviderId} onClick={() => run(true)}>Preview prompt</button>
        <button type="button" className={button} onClick={() => setOpen(false)}>Close</button>
      </div>
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
      {sent && <SentPromptPanel {...sent} />}
      {proposed.length > 0 && (
        <div className="space-y-2 border-t border-port-border pt-2">
          {proposed.map((key) => (
            <div key={key} className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-medium">{LABELS[key]}</h4>
                <button type="button" className={button} disabled={disabled} onClick={() => onUse({ [key]: proposal[key] })}>Use</button>
              </div>
              <p className="whitespace-pre-wrap break-words text-xs">{proposal[key]}</p>
            </div>
          ))}
          {proposed.length > 1 && (
            <button type="button" className={button} disabled={disabled}
              onClick={() => onUse(Object.fromEntries(proposed.map((key) => [key, proposal[key]])))}>Use all</button>
          )}
          <p className="text-xs text-port-text-muted">Used drafts fill the fields below. Save planning edits to keep them.</p>
        </div>
      )}
    </section>
  );
}
