import { Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard.js';

// A fenced block in thread notes, optionally preceded by a `**Label**` line —
// the shape a scheduled human action writes its ready-to-paste text in
// (server/lib/humanActions.js buildHumanActionNotes). The closing fence must be
// at least as long as the opening one, so a block holding ``` survives.
const BLOCK_RE = /(?:^\*\*(.+?)\*\*\n)?^(`{3,})[^\n]*\n([\s\S]*?)\n\2`*$/gm;

export function pasteBlocks(notes) {
  if (typeof notes !== 'string' || !notes.includes('```')) return [];
  return [...notes.matchAll(BLOCK_RE)]
    .map(([, label, , text], i) => ({ label: label?.trim() || `Text ${i + 1}`, text }))
    .filter((block) => block.text.trim());
}

// A scheduled step's numbered instructions: the list before its first heading.
export function stepLines(notes) {
  if (typeof notes !== 'string') return [];
  const head = notes.split(/^## /m)[0];
  return [...head.matchAll(/^\d+\.\s+(.+)$/gm)].map(([, line]) => line.trim());
}

/**
 * A scheduled human action's steps, then the text it asks you to paste, each
 * with its own Copy button, so the moment a reminder fires everything is one
 * tap away. Paste blocks show on any thread; the steps only on a scheduled
 * action (tag `human-action`), where the notes are known to start with them.
 */
export default function ThreadPasteBlocks({ notes, tags }) {
  const blocks = pasteBlocks(notes);
  const steps = Array.isArray(tags) && tags.includes('human-action') ? stepLines(notes) : [];
  if (!blocks.length && !steps.length) return null;
  return (
    <section aria-label="Ready to paste" className="space-y-2 rounded border border-port-border bg-port-bg p-2">
      {steps.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-200">
          {steps.map((line, i) => <li key={i} className="break-words">{line}</li>)}
        </ol>
      )}
      {blocks.length > 0 && <h4 className="text-xs font-medium text-gray-300">Ready to paste</h4>}
      {blocks.map((block, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-gray-400 min-w-0 break-words">{block.label}</span>
            <button type="button" onClick={() => copyToClipboard(block.text, `Copied: ${block.label}`)}
              className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-port-accent min-h-[44px] sm:min-h-0">
              <Copy size={12} /> Copy
            </button>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm text-gray-200">{block.text}</p>
        </div>
      ))}
    </section>
  );
}
