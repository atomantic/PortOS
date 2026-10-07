import { Link } from 'react-router';
import { Brain } from 'lucide-react';
import { formatPercent } from '../../../utils/formatters';

/**
 * "Memories used" — the memories whose text was injected into this run's prompt
 * (`agent.metadata.injectedMemories`, #10495). Each links to the Memory tab's
 * detail view. Renders nothing for a run that had none, and for a record
 * written before the field existed.
 */
export default function AgentMemoriesUsed({ injectedMemories }) {
  if (!Array.isArray(injectedMemories) || injectedMemories.length === 0) return null;
  return (
    <details className="mb-2 text-xs text-gray-400">
      <summary className="cursor-pointer min-h-[32px] inline-flex items-center gap-1.5 select-none hover:text-gray-200">
        <Brain size={12} aria-hidden="true" />
        Memories used ({injectedMemories.length})
      </summary>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {injectedMemories.map(m => (
          <li key={m.id}>
            <Link
              to={`/cos/memory/${encodeURIComponent(m.id)}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-port-border font-mono text-port-accent hover:text-port-accent/80"
              title={m.relevance != null ? `Relevance ${formatPercent(m.relevance * 100, { decimals: 0 })}` : 'Open memory'}
            >
              {m.id.slice(0, 8)}
              {m.version != null && <span className="text-gray-500">v{m.version}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
