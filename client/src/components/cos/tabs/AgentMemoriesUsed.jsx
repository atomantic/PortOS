import { Link } from 'react-router';
import { Brain } from 'lucide-react';

/**
 * "Memories sent" — the memories whose text was injected into this run's prompt
 * (`agent.metadata.injectedMemories`, #10495). Each links to the Memory tab's
 * editor, where it can be corrected or archived. Records carry a `preview` of
 * the text sent; older ones show only the id. Renders nothing for a run that
 * had none, and for a record written before the field existed.
 */
export default function AgentMemoriesUsed({ injectedMemories }) {
  if (!Array.isArray(injectedMemories) || injectedMemories.length === 0) return null;
  return (
    <details className="mb-2 text-xs text-gray-400">
      <summary className="cursor-pointer min-h-[32px] inline-flex items-center gap-1.5 select-none hover:text-gray-200">
        <Brain size={12} aria-hidden="true" />
        Memories sent ({injectedMemories.length})
      </summary>
      <ul className="mt-1 flex flex-col gap-1">
        {injectedMemories.map(m => (
          <li key={m.id} className="min-w-0">
            <Link
              to={`/cos/memory/${encodeURIComponent(m.id)}${m.version != null ? `?version=${encodeURIComponent(m.version)}` : ''}`}
              className="flex min-w-0 items-baseline gap-2 rounded px-1.5 py-1 bg-port-border/60 hover:bg-port-border text-gray-300 hover:text-white"
              title={m.version != null ? `Open memory version ${m.version}` : 'Open memory'}
            >
              {m.preview && <span className="min-w-0 flex-1 truncate">{m.preview}</span>}
              <span className="shrink-0 font-mono text-port-accent">
                {m.id.slice(0, 8)}
                {m.version != null && <span className="text-gray-500"> v{m.version}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
