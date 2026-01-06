import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import { MEMORY_TYPES, MEMORY_TYPE_COLORS } from '../constants';
import MemoryTimeline from './MemoryTimeline';
import MemoryGraph from './MemoryGraph';

export default function MemoryTab() {
  const [memories, setMemories] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [view, setView] = useState('list'); // list, timeline, graph
  const [filters, setFilters] = useState({ types: [], categories: [] });
  const [categories, setCategories] = useState([]);
  const [embeddingStatus, setEmbeddingStatus] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [memoriesRes, statsRes, catsRes, embRes] = await Promise.all([
      api.getMemories({ limit: 100, ...filters }).catch(() => ({ memories: [] })),
      api.getMemoryStats().catch(() => null),
      api.getMemoryCategories().catch(() => []),
      api.getEmbeddingStatus().catch(() => null)
    ]);
    setMemories(memoriesRes.memories || []);
    setStats(statsRes);
    setCategories(catsRes);
    setEmbeddingStatus(embRes);
    setLoading(false);
  }, [filters]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    const results = await api.searchMemories(searchQuery, { limit: 20 }).catch(() => ({ memories: [] }));
    setSearchResults(results.memories || []);
    setLoading(false);
  };

  const handleDelete = async (id) => {
    await api.deleteMemory(id);
    toast.success('Memory archived');
    fetchData();
  };

  const displayMemories = searchResults || memories;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Memory System</h3>
          <p className="text-sm text-gray-500">
            {stats?.active || 0} active memories
            {embeddingStatus?.available ? ' * LM Studio connected' : ' * LM Studio offline'}
          </p>
        </div>
        <div className="flex gap-2">
          {['list', 'timeline', 'graph'].map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                view === v ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'
              }`}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search memories semantically..."
          className="flex-1 bg-port-card border border-port-border rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-port-accent outline-none"
        />
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Search
        </button>
        {searchResults && (
          <button
            onClick={() => { setSearchResults(null); setSearchQuery(''); }}
            className="px-3 py-2 bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Type Filters */}
      <div className="flex flex-wrap gap-2">
        {MEMORY_TYPES.map(type => (
          <button
            key={type}
            onClick={() => {
              const newTypes = filters.types.includes(type)
                ? filters.types.filter(t => t !== type)
                : [...filters.types, type];
              setFilters({ ...filters, types: newTypes });
            }}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              filters.types.includes(type) ? MEMORY_TYPE_COLORS[type] : 'border-port-border text-gray-500 hover:text-gray-300'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Stats Row */}
      {stats && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          {Object.entries(stats.byType || {}).map(([type, count]) => (
            <div key={type} className={`p-2 rounded-lg border text-center ${MEMORY_TYPE_COLORS[type] || 'border-port-border'}`}>
              <div className="text-lg font-bold">{count}</div>
              <div className="text-xs opacity-75">{type}</div>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="animate-spin text-port-accent" size={24} />
        </div>
      ) : view === 'list' ? (
        <div className="space-y-3">
          {displayMemories.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              {searchQuery ? 'No memories found for this search' : 'No memories yet. Memories are extracted from agent task completions.'}
            </div>
          ) : (
            displayMemories.map(memory => (
              <div key={memory.id} className="bg-port-card border border-port-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full border ${MEMORY_TYPE_COLORS[memory.type]}`}>
                        {memory.type}
                      </span>
                      <span className="text-xs text-gray-500">{memory.category}</span>
                      {memory.similarity && (
                        <span className="text-xs text-port-accent">{(memory.similarity * 100).toFixed(0)}% match</span>
                      )}
                    </div>
                    <p className="text-white text-sm">{memory.summary || memory.content?.substring(0, 200)}</p>
                    {memory.tags?.length > 0 && (
                      <div className="flex gap-1 mt-2">
                        {memory.tags.map(tag => (
                          <span key={tag} className="px-2 py-0.5 text-xs bg-port-border rounded text-gray-400">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mt-2">
                      {new Date(memory.createdAt).toLocaleDateString()} * importance: {((memory.importance || 0.5) * 100).toFixed(0)}%
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(memory.id)}
                    className="p-2 text-gray-500 hover:text-port-error transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : view === 'timeline' ? (
        <MemoryTimeline memories={memories} />
      ) : (
        <MemoryGraph />
      )}
    </div>
  );
}
