import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';

const PROMPT_MAX = 8000;
const savedPromptOf = (item) => (item.prompt === '(no prompt)' ? '' : (item.prompt || ''));

// The prompt block: a read-only preview while a compact list item hydrates,
// an editable textarea when the host passes onPromptChange, otherwise a
// copyable read-only view.
export default function LightboxPromptSection({ item, onPromptChange, copy }) {
  const [promptDraft, setPromptDraft] = useState('');
  const [promptStatus, setPromptStatus] = useState('idle');
  const [promptSaving, setPromptSaving] = useState(false);
  useEffect(() => {
    setPromptDraft(savedPromptOf(item));
    setPromptStatus('idle');
  }, [item?.key, item?.prompt]);
  const savePrompt = async () => {
    if (!onPromptChange || promptSaving) return;
    setPromptSaving(true);
    setPromptStatus('saving');
    await onPromptChange(item, promptDraft).then(
      () => setPromptStatus('saved'),
      () => setPromptStatus('error'),
    );
    setPromptSaving(false);
  };

  if (item.compact) {
    return (
      <div>
        <span className="block mb-1 text-gray-500 uppercase tracking-wide">Prompt</span>
        <p className="text-gray-400 whitespace-pre-wrap">{item.prompt}</p>
        {item.detailError
          ? <p role="alert" className="mt-1 text-port-error">Full details could not be loaded. Close and reopen to retry.</p>
          : <p role="status" className="mt-1 text-gray-500">Loading full details…</p>}
      </div>
    );
  }
  if (onPromptChange) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="media-prompt" className="text-gray-500 uppercase tracking-wide">Prompt</label>
          <div className="flex items-center gap-2 text-[10px] text-gray-500">
            {promptStatus === 'saving' && <span>Saving…</span>}
            {promptStatus === 'saved' && <span className="text-port-success">Saved</span>}
            {promptStatus === 'error' && <span role="alert" className="text-port-error">Save failed</span>}
            <span>{promptDraft.length}/{PROMPT_MAX}</span>
          </div>
        </div>
        <textarea id="media-prompt" value={promptDraft}
          onChange={(e) => { setPromptDraft(e.target.value.slice(0, PROMPT_MAX)); setPromptStatus('idle'); }}
          placeholder="Add the prompt used to create this media" rows={5} maxLength={PROMPT_MAX}
          className="w-full bg-port-bg border border-port-border rounded p-2 text-xs text-port-text placeholder:text-port-text-subtle focus:outline-none focus:border-port-accent resize-y" />
        <div className="flex justify-end mt-1">
          <button type="button" onClick={savePrompt} disabled={promptSaving || promptDraft === savedPromptOf(item)} className="min-h-[44px] min-w-[44px] px-2 py-1 rounded bg-port-accent text-white disabled:opacity-40">Save prompt</button>
        </div>
      </div>
    );
  }
  if (!item.prompt) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-gray-500 uppercase tracking-wide">Prompt</span>
        <button
          type="button"
          onClick={() => copy(item.prompt, 'Prompt')}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
          title="Copy prompt" aria-label="Copy prompt"
        >
          <Copy className="w-3 h-3" />
        </button>
      </div>
      <p className="text-gray-200 whitespace-pre-wrap">{item.prompt}</p>
    </div>
  );
}
