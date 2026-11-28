import { useState, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { searchNotes } from '../../../services/apiNotes.js';
import { Search, FileText, X, RefreshCw, Tag } from 'lucide-react';
import OfflineNotesNotice from '../../OfflineNotesNotice.jsx';
import useLatestRequest from '../../../hooks/useLatestRequest.js';

export default function SearchTab({ vaultId }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);
  const beginSearch = useLatestRequest();

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !vaultId) return;
    const isCurrent = beginSearch();
    setSearching(true);
    const data = await searchNotes(vaultId, query.trim(), 50).catch(() => null);
    if (!isCurrent()) return;
    setSearching(false);
    if (data) setResults(data);
  }, [query, vaultId, beginSearch]);

  const openNote = (notePath) => {
    const next = new URLSearchParams(searchParams);
    next.set('note', notePath);
    navigate({ pathname: '/wiki/browse', search: next.toString() });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Search bar */}
      <div className="flex items-center gap-2 bg-port-card border border-port-border rounded-lg pl-3.5 pr-2 py-1.5 focus-within:border-port-accent">
        <Search size={18} className="text-gray-500 shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Search wiki pages and raw sources..."
          aria-label="Search wiki pages and raw sources"
          className="flex-1 min-w-0 bg-transparent py-1.5 text-base sm:text-sm text-white placeholder-gray-500 focus:outline-none"
          autoFocus
        />
        {query && (
          <button
            type="button"
            onClick={() => { setQuery(''); setResults(null); }}
            aria-label="Clear search"
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded border border-transparent hover:border-port-border hover:bg-port-bg text-gray-500 hover:text-white shrink-0 transition-colors"
          >
            <X size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={handleSearch}
          disabled={searching || !query.trim()}
          aria-label="Search"
          className="min-h-[36px] px-3 py-1.5 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-50 shrink-0 transition-colors"
        >
          {searching ? <RefreshCw size={14} className="animate-spin" /> : 'Search'}
        </button>
      </div>

      {/* Results */}
      {results && (
        <div>
          <OfflineNotesNotice count={results.skippedUnavailable} className="mb-3" />
          <div className="text-sm text-gray-500 mb-3">
            {results.total} result{results.total !== 1 ? 's' : ''} for &ldquo;{results.query}&rdquo;
          </div>
          <div className="space-y-2">
            {results.results.map(result => (
              <button
                key={result.path}
                onClick={() => openNote(result.path)}
                className="w-full text-left bg-port-card border border-port-border rounded-lg p-4 hover:border-port-accent/50 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <FileText size={14} className="text-port-accent shrink-0" />
                  <span className="text-white font-medium">{result.name}</span>
                  {result.titleMatch && (
                    <span className="px-1.5 py-0.5 rounded text-xs bg-port-accent/20 text-port-accent">title match</span>
                  )}
                  {result.folder && (
                    <span className="text-xs text-gray-500">{result.folder}</span>
                  )}
                </div>
                {result.snippets?.length > 0 && (
                  <div className="space-y-1 mt-2">
                    {result.snippets.slice(0, 2).map((snippet, i) => (
                      <div key={i} className="text-xs text-gray-400 truncate">
                        <span className="text-gray-600 mr-1">L{snippet.line}:</span>
                        {snippet.text}
                      </div>
                    ))}
                  </div>
                )}
                {result.tags?.length > 0 && (
                  <div className="flex items-center gap-1 mt-2">
                    <Tag size={10} className="text-gray-500" />
                    {result.tags.slice(0, 5).map(tag => (
                      <span key={tag} className="text-xs text-port-accent/70">#{tag}</span>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {!results && (
        <div className="text-center py-12 text-gray-500">
          <Search size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Search across all wiki pages and raw sources</p>
          <p className="text-xs mt-1">Searches titles and content, ranked by relevance</p>
        </div>
      )}
    </div>
  );
}
