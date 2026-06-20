import { Copy } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

// Inline, click-to-copy record id badge. Shows a short prefix of the id (full
// id stays in the `title` tooltip and is what gets copied) so the user can read
// it off a card and reference a specific record by id when asking the agent
// questions about it. Monospace + muted so it reads as metadata, not content.
//
//   id    — the full record id (required; renders nothing when absent)
//   chars — how many leading chars to show before the ellipsis (default 8)
export default function CopyableId({ id, chars = 8, className = '' }) {
  if (!id) return null;
  const short = id.length > chars ? `${id.slice(0, chars)}…` : id;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); copyToClipboard(id, 'ID copied'); }}
      title={`Copy id: ${id}`}
      aria-label={`Copy id ${id}`}
      className={`inline-flex items-center gap-1 font-mono text-[10px] text-gray-500 hover:text-gray-300 transition-colors ${className}`.trim()}
    >
      <span>{short}</span>
      <Copy size={10} aria-hidden="true" className="shrink-0" />
    </button>
  );
}
