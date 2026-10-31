import { useState } from 'react';
import { Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

/**
 * What a model actually received, beside the prompt the user wrote (#11317):
 * one chip per block PortOS added (tap to read it), and a "Show full prompt"
 * view of the exact final text with Copy. Renders nothing for a record made
 * before sent prompts were recorded. The Image Gen form shows the same panel
 * from the server's preview before the render (`asWrittenText` names the tense).
 */
export default function SentPromptPanel({
  prompt = '', sentPrompt = null, sentNegativePrompt = null, additions = [],
  asWrittenText = 'Sent to the model exactly as written.',
}) {
  const [openChip, setOpenChip] = useState(null);
  const [showFull, setShowFull] = useState(false);
  if (typeof sentPrompt !== 'string') return null;

  const asWritten = !additions.length && !sentNegativePrompt && sentPrompt.trim() === (prompt || '').trim();
  if (asWritten) return <p className="text-[11px] text-gray-500">{asWrittenText}</p>;

  const base = sentNegativePrompt ? `${sentPrompt}\n\nNegative prompt: ${sentNegativePrompt}` : sentPrompt;
  // A request setting (not prose) travels with the copied text so the copy matches the request.
  const expansion = additions.find((addition) => addition.id === 'prompt-expansion');
  const fullText = expansion ? `${base}\n\n${expansion.text}` : base;
  const opened = additions.find((addition) => addition.id === openChip);

  return (
    <div className="space-y-2">
      {additions.length > 0 && (
        <div>
          <span className="block mb-1 text-gray-500 uppercase tracking-wide">Added to the prompt</span>
          <div className="flex flex-wrap gap-1">
            {additions.map((addition) => (
              <button
                key={addition.id}
                type="button"
                aria-pressed={openChip === addition.id}
                onClick={() => setOpenChip(openChip === addition.id ? null : addition.id)}
                className={`min-h-[32px] px-2 py-1 rounded-full border text-[11px] ${openChip === addition.id
                  ? 'border-port-accent text-white bg-port-accent/20'
                  : 'border-port-border text-gray-300 hover:text-white'}`}
              >
                + {addition.label}
              </button>
            ))}
          </div>
          {opened && <p className="mt-1 p-2 rounded bg-port-bg border border-port-border text-gray-300 whitespace-pre-wrap break-words">{opened.text}</p>}
        </div>
      )}
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-expanded={showFull}
          onClick={() => setShowFull(!showFull)}
          className="min-h-[44px] px-2 py-1 rounded text-port-accent hover:text-white"
        >
          {showFull ? 'Hide full prompt' : 'Show full prompt'}
        </button>
        {showFull && (
          <button
            type="button"
            onClick={() => copyToClipboard(fullText, 'Full prompt copied')}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            aria-label="Copy full prompt"
          >
            <Copy className="w-3 h-3" /> Copy
          </button>
        )}
      </div>
      {showFull && <pre className="p-2 rounded bg-port-bg border border-port-border text-gray-200 whitespace-pre-wrap break-words font-mono text-[11px]">{fullText}</pre>}
    </div>
  );
}
