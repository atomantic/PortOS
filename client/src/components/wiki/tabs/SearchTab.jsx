import { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as api from '../../../services/api';
import { Search, FileText, X, RefreshCw, Tag } from 'lucide-react';

export default function SearchTab({ vaultId }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef(null);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !vaultId) return;
    setSearching(true);
    const data = await api.searchNotes(vaultId, query.trim(), 50).catch(() => null);
    setSearching(false);
    if (data) setResults(data);
  }, [query, vaultId]);

  const openNote = (notePath) => {
    navigate('/wiki/browse', { state: { openNote: notePath } });
  };

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      {/* Search bar */}
      <div className="relative">
        <Search size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Search wiki pages and raw sources..."
          className="w-full bg-port-card border border-port-border rounded-lg pl-11 pr-20 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
          autoFocus
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
          {query && (
            <button onClick={() => { setQuery(''); setResults(null); }} className="text-gray-500 hover:text-white">
              <X size={16} />
            </button>
          )}
          <button
            onClick={handleSearch}
            disabled={searching || !query.trim()}
            className="px-3 py-1 rounded bg-port-accent text-white text-sm disabled:opacity-50"
          >
            {searching ? <RefreshCw size={14} className="animate-spin" /> : 'Search'}
          </button>
        </div>
      </div>

      {/* Results */}
      {results && (
        <div>
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
