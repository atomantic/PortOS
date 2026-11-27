import { useId } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import MusicVideoLlmPicker from '../musicVideo/MusicVideoLlmPicker';
import SentPromptPanel from '../media/SentPromptPanel';

const AUTO = 'Default — the active provider';

export function GreyboxAiDraftPreview({ ai, locked, blocked, busy, actionButton }) {
  const { draft, instruction, applyDraft, setDraft } = ai;
  return (
    <div role="status" className="rounded-lg border border-port-accent/50 bg-port-accent/10 p-3 space-y-3">
      <p className="text-sm text-white">
        Draft preview, not saved yet ({draft.providerId}{draft.model ? ` › ${draft.model}` : ''}). {draft.edited ? 'This replaces the current layout.' : ''}
      </p>
      <SentPromptPanel prompt={instruction} sentPrompt={draft.sentPrompt} additions={draft.promptAdditions} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={actionButton} onClick={applyDraft} disabled={locked || blocked}>
          {busy === 'apply' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />} Apply draft
        </button>
        <button type="button" className={actionButton} onClick={() => setDraft(null)} disabled={blocked}>
          <X size={14} aria-hidden="true" /> Discard
        </button>
      </div>
    </div>
  );
}

export default function GreyboxAiDraftCard({ saved, manual, blocked, busy, actionButton, ai }) {
  const id = useId();
  const { instruction, setInstruction, llm, setLlm, fromScratch, setFromScratch, preview, generate } = ai;
  return (
    <div className="rounded-lg border border-port-border p-3 space-y-3">
      <h3 className="text-sm font-medium text-white flex items-center gap-1.5"><Sparkles size={14} aria-hidden="true" />{saved ? 'Edit with AI' : 'Create with AI'}</h3>
      <MusicVideoLlmPicker idPrefix="greybox" value={llm} onChange={setLlm} label="Provider › model › effort"
        emptyProviderOption={AUTO} fallbackName="The active provider" hint="Runs only when you tap the button. The place description and your words are sent as shown under Show full prompt." />
      <div>
        <label htmlFor={`${id}-instruction`} className="block text-xs text-gray-400 mb-1">
          {saved && !fromScratch ? 'What should change?' : 'Describe the layout'}
        </label>
        <textarea id={`${id}-instruction`} value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} maxLength={4000}
          placeholder={saved ? 'Move the DJ booth to the east wall and add a rental counter by the entrance' : 'An oval roller-skating rink, 30 by 14 meters, with a rail, a DJ booth, a snack bar and bench seating along the north wall'}
          className="w-full rounded-lg bg-port-bg border border-port-border p-2 text-sm text-white" />
      </div>
      {saved && (
        <label htmlFor={`${id}-scratch`} className="flex items-center gap-2 text-xs text-gray-300 min-h-[32px]">
          <input id={`${id}-scratch`} type="checkbox" checked={fromScratch} onChange={(e) => setFromScratch(e.target.checked)} />
          Start over instead of editing the current layout
        </label>
      )}
      {preview && <SentPromptPanel prompt={instruction} sentPrompt={preview.sentPrompt} additions={preview.promptAdditions} />}
      <button type="button" className={actionButton} onClick={generate} disabled={blocked || !!manual || !instruction.trim()}>
        {busy === 'draft' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
        {busy === 'draft' ? 'Drafting…' : saved && !fromScratch ? 'Draft the edit' : 'Draft a greybox'}
      </button>
    </div>
  );
}
