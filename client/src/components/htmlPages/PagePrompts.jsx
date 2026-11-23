import { Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard.js';

function PromptBlock({ label, text, note, copyLabel }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-gray-400">{label}</p>
        {text && (
          <button
            type="button"
            onClick={() => copyToClipboard(text, `${label} copied`)}
            aria-label={`Copy the ${label.toLowerCase()} of ${copyLabel}`}
            title={`Copy the ${label.toLowerCase()}`}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded border border-port-border text-gray-300 hover:border-port-accent hover:text-white"
          >
            <Copy size={13} aria-hidden="true" />
          </button>
        )}
      </div>
      {text
        ? <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded border border-port-border p-2 font-mono text-[11px] text-gray-300">{text}</pre>
        : <p className="text-[11px] text-port-warning">{note}</p>}
    </div>
  );
}

/**
 * What one page was asked and what its model planned, each copyable so it can be reused on another model: the planning request, the plan it returned, and the page prompt that carried that plan. Pages stored before the plan step show only their page prompt, recorded on the run.
 */
export default function PagePrompts({ run, page, index, label }) {
  const prompt = page.prompt ?? run.prompts?.[index] ?? null;
  if (!prompt && !page.planPrompt) return null;
  return (
    <details className="rounded-lg border border-port-border bg-port-bg px-3 text-xs text-gray-400">
      <summary className="cursor-pointer text-gray-300">Prompt and plan</summary>
      <div className="space-y-2 pb-2">
        {page.planPrompt && <PromptBlock label="Plan request" text={page.planPrompt} copyLabel={label} />}
        {page.planPrompt && <PromptBlock label="Plan" text={page.plan} note={`No plan: ${page.planError || 'the plan step returned nothing'}. The page was built from the brief alone.`} copyLabel={label} />}
        <PromptBlock label="Page prompt" text={prompt} note="Not recorded." copyLabel={label} />
      </div>
    </details>
  );
}
