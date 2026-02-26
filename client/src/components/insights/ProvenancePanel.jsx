import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export default function ProvenancePanel({ references }) {
  const [expanded, setExpanded] = useState(false);

  if (!references || references.length === 0) return null;

  return (
    <div className="mt-3 border-t border-port-border/50 pt-2">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{references.length} {references.length === 1 ? 'reference' : 'references'}</span>
      </button>

      {expanded && (
        <ul className="mt-2 space-y-1.5">
          {references.map((ref, i) => (
            <li key={i} className="text-xs text-gray-500">
              <span className="text-gray-400">{ref.name ?? ref.study ?? ref}</span>
              {ref.year && <span className="ml-1 text-gray-600">({ref.year})</span>}
              {ref.source && (
                <span className="ml-1 px-1.5 py-0.5 bg-gray-800 text-gray-500 rounded text-[10px]">
                  {ref.source}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
