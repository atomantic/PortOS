import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Brain, Cpu, Package, History, HeartPulse, Search, Loader2 } from 'lucide-react';
import { useCmdKSearch } from '../hooks/useCmdKSearch';
import { search } from '../services/api';

const ICON_MAP = { Brain, Cpu, Package, History, HeartPulse };

function Highlight({ text, query }) {
  if (!query || !text) return <span>{text}</span>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <mark key={i} className="bg-port-accent/30 text-white rounded px-0.5 not-italic">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </span>
  );
}

export default function CmdKSearch() {
  const { open, setOpen } = useCmdKSearch();
  const navigate = useNavigate();
  const inputRef = useRef(null);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [expandedSources, setExpandedSources] = useState(new Set());
  const resultRefs = useRef([]);

  // Auto-focus input when overlay opens
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Lock body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Clear state when overlay closes
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setFocusedIndex(0);
      setExpandedSources(new Set());
    }
  }, [open]);

  // Debounced search-as-you-type
  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      search(query)
        .then(data => {
          setResults(data?.sources ?? []);
        })
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Reset focusedIndex when results change
  useEffect(() => {
    setFocusedIndex(0);
  }, [results]);

  // Compute flat result list for keyboard navigation
  const flatResults = results.flatMap(source => {
    const isExpanded = expandedSources.has(source.id);
    const visible = isExpanded ? source.results : source.results.slice(0, 3);
    return visible.map(result => ({ ...result, sourceId: source.id }));
  });

  // Scroll focused result into view
  useEffect(() => {
    const el = resultRefs.current[focusedIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const handleNavigate = useCallback((url) => {
    navigate(url);
    close();
  }, [navigate, close]);

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex(i => Math.min(i + 1, flatResults.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const item = flatResults[focusedIndex];
      if (item) handleNavigate(item.url);
    } else if (e.key === 'Escape') {
      close();
    }
  };

  if (!open) return null;

  // Build a flat index counter across sources for focusedIndex mapping
  let flatIdx = 0;

  const overlay = (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center pt-[10vh]"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={close}
        aria-hidden="true"
      />

      {/* Modal container */}
      <div className="relative w-full max-w-3xl mx-4 bg-port-card rounded-xl border border-port-border shadow-2xl overflow-hidden">

        {/* Search input row */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-port-border">
          <Search size={18} className="text-gray-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search Brain, Memory, Health..."
            className="flex-1 bg-transparent text-white placeholder-gray-500 outline-none text-sm"
            aria-label="Search PortOS"
          />
          <span className="text-xs text-gray-500 border border-port-border rounded px-1.5 py-0.5 flex-shrink-0">
            {navigator.platform?.includes('Mac') ? '⌘K' : 'Ctrl+K'}
          </span>
        </div>

        {/* Results area */}
        <div className="max-h-96 overflow-y-auto p-2">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={20} className="animate-spin text-gray-400" />
            </div>
          )}

          {!loading && query.length >= 2 && results.length === 0 && (
            <div className="text-center text-sm text-gray-500 py-8">
              No results for &ldquo;{query}&rdquo;
            </div>
          )}

          {!loading && query.length < 2 && (
            <div className="text-center text-sm text-gray-600 py-8">
              Type 2+ characters to search across Brain, Memory, Apps, History, and Health
            </div>
          )}

          {!loading && results.map(source => {
            const SourceIcon = ICON_MAP[source.icon] ?? Search;
            const isExpanded = expandedSources.has(source.id);
            const visible = isExpanded ? source.results : source.results.slice(0, 3);
            const hasMore = source.results.length > 3 && !isExpanded;

            return (
              <div key={source.id} className="mb-2">
                {/* Source header */}
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-400 uppercase tracking-wide">
                  <SourceIcon size={14} />
                  <span>{source.label}</span>
                </div>

                {/* Result rows */}
                {visible.map(result => {
                  const currentIdx = flatIdx;
                  flatIdx++;
                  const isFocused = focusedIndex === currentIdx;

                  return (
                    <div
                      key={result.id}
                      ref={el => { resultRefs.current[currentIdx] = el; }}
                      onClick={() => handleNavigate(result.url)}
                      className={`flex items-start gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        isFocused ? 'bg-port-accent/10' : 'hover:bg-white/5'
                      }`}
                      role="option"
                      aria-selected={isFocused}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white truncate">{result.title}</p>
                        {result.snippet && (
                          <p className="text-xs text-gray-400 truncate mt-0.5">
                            <Highlight text={result.snippet} query={query} />
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Show more button */}
                {hasMore && (
                  <button
                    onClick={() => setExpandedSources(prev => new Set([...prev, source.id]))}
                    className="text-xs text-port-accent px-3 py-1 hover:underline"
                  >
                    Show {source.results.length - 3} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
