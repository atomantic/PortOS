import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, Trash2, X, Check, XCircle, Pencil } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import { MEMORY_TYPES, MEMORY_TYPE_COLORS } from '../constants';
import { getAppName } from '../../../utils/formatters';
import MemoryTimeline from './MemoryTimeline';
import MemoryGraph from './MemoryGraph';
import MemoryEditModal from './MemoryEditModal';
import ProviderModelSelector from '../../ProviderModelSelector';
import useProviderModels from '../../../hooks/useProviderModels';

export default function MemoryTab({ apps = [] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [memories, setMemories] = useState([]);
  const [pendingMemories, setPendingMemories] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [filters, setFilters] = useState({ types: [] });

  const view = searchParams.get('view') || 'list';
  const setView = useCallback((v) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('view', v);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [embeddingStatus, setEmbeddingStatus] = useState(null);
  const [editingMemory, setEditingMemory] = useState(null);

  // Embedding provider/model configuration
  const { providers, availableModels, setSelectedProviderId: setProviderHook, setSelectedModel: setModelHook, selectedProviderId: hookProviderId, selectedModel: hookModel } = useProviderModels();
  const [embeddingProviderId, setEmbeddingProviderId] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingConfigLoaded, setEmbeddingConfigLoaded] = useState(false);

  // Load current embedding config from CoS config
  useEffect(() => {
    if (embeddingConfigLoaded) return;
    api.getCosConfig().then(cfg => {
      if (cfg?.embeddingProviderId) {
        setEmbeddingProviderId(cfg.embeddingProviderId);
        setProviderHook(cfg.embeddingProviderId);
      }
      if (cfg?.embeddingModel) {
        setEmbeddingModel(cfg.embeddingModel);
        setModelHook(cfg.embeddingModel);
      }
      setEmbeddingConfigLoaded(true);
    }).catch(() => setEmbeddingConfigLoaded(true));
  }, [embeddingConfigLoaded, setProviderHook, setModelHook]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [memoriesRes, pendingRes, statsRes, embRes] = await Promise.all([
      api.getMemories({ limit: 100, ...filters }).catch(() => ({ memories: [] })),
      api.getMemories({ status: 'pending_approval', limit: 50 }).catch(() => ({ memories: [] })),
      api.getMemoryStats().catch(() => null),
      api.getEmbeddingStatus().catch(() => null)
    ]);
    setMemories(memoriesRes.memories || []);
    setPendingMemories(pendingRes.memories || []);
    setStats(statsRes);
    setEmbeddingStatus(embRes);
    setLoading(false);
  }, [filters]);

  const handleApprove = async (id) => {
    await api.approveMemory(id);
    toast.success('Memory approved');
    fetchData();
  };

  const handleReject = async (id) => {
    await api.rejectMemory(id);
    toast.success('Memory rejected');
    fetchData();
  };

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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white">Memory System</h3>
          <p className="text-sm text-gray-500">
            {stats?.active || 0} active memories
            {stats?.pendingApproval > 0 && <span className="text-yellow-400"> * {stats.pendingApproval} pending</span>}
            {embeddingStatus?.available ? ' * Embeddings online' : ' * Embeddings offline'}
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
          className="flex-1 bg-port-card border border-port-border rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-port-accent outline-none"
        />
        <button
          onClick={handleSearch}
          className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Search
        </button>
        {searchResults && (
          <button
            onClick={() => { setSearchResults(null); setSearchQuery(''); }}
            className="px-2 py-1.5 flex items-center justify-center bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
          >
            <X size={18} />
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
            className={`px-3 py-2 min-h-[36px] text-xs rounded-full border transition-colors ${
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

      {/* Pending Approvals */}
      {pendingMemories.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-lg font-semibold text-yellow-500">Pending Approval ({pendingMemories.length})</h3>
          {pendingMemories.map(memory => (
            <div key={memory.id} className="bg-port-card border border-yellow-500/50 rounded-lg p-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className={`px-2 py-1 text-xs rounded-full border ${MEMORY_TYPE_COLORS[memory.type]}`}>
                      {memory.type}
                    </span>
                    <span className="text-xs text-gray-500">{memory.category}</span>
                    <span className="text-xs text-yellow-400">
                      {((memory.confidence || 0) * 100).toFixed(0)}% confidence
                    </span>
                  </div>
                  <p className="text-white text-sm">{memory.summary || memory.content?.substring(0, 200)}</p>
                  {memory.tags?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {memory.tags.map(tag => (
                        <span key={tag} className="px-2 py-1 text-xs bg-port-border rounded text-gray-400">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-gray-500 mt-2 flex flex-wrap gap-2">
                    <span>{new Date(memory.createdAt).toLocaleDateString()}</span>
                    {getAppName(memory.sourceAppId, apps) && (
                      <>
                        <span>*</span>
                        <span className="text-port-accent">{getAppName(memory.sourceAppId, apps)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-2 sm:flex-col md:flex-row">
                  <button
                    onClick={() => setEditingMemory(memory)}
                    className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded-lg transition-colors"
                    title="Edit before approving"
                  >
                    <Pencil size={20} />
                  </button>
                  <button
                    onClick={() => handleApprove(memory.id)}
                    className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-green-500/20 text-green-400 hover:bg-green-500/30 rounded-lg transition-colors"
                    title="Approve"
                  >
                    <Check size={20} />
                  </button>
                  <button
                    onClick={() => handleReject(memory.id)}
                    className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors"
                    title="Reject"
                  >
                    <XCircle size={20} />
                  </button>
                </div>
              </div>
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
              {searchQuery ? (
                'No memories found for this search'
              ) : (
                <div className="space-y-4">
                  <p>No memories yet.</p>
                  {!embeddingStatus?.available && (
                    <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-4 text-left max-w-md mx-auto">
                      <p className="text-port-warning font-medium mb-2">Embedding Service Unavailable</p>
                      <p className="text-sm text-gray-400">
                        Cannot connect to embedding service{embeddingStatus?.endpoint && (
                          <span>: <code className="text-port-accent">{embeddingStatus.endpoint}</code></span>
                        )}
                      </p>
                      {embeddingStatus?.error && (
                        <p className="text-sm text-gray-500 mt-1">Error: {embeddingStatus.error}</p>
                      )}
                      <div className="mt-3">
                        <ProviderModelSelector
                          providers={providers}
                          selectedProviderId={embeddingProviderId || hookProviderId}
                          selectedModel={embeddingModel || hookModel}
                          availableModels={availableModels}
                          onProviderChange={(id) => { setEmbeddingProviderId(id); setProviderHook(id); setEmbeddingModel(''); }}
                          onModelChange={(m) => { setEmbeddingModel(m); setModelHook(m); }}
                          label="Embedding Provider"
                        />
                      </div>
                      <button
                        onClick={async () => {
                          const pid = embeddingProviderId || hookProviderId;
                          const mid = embeddingModel || hookModel;
                          await api.updateCosConfig({ embeddingProviderId: pid, embeddingModel: mid });
                          toast.success('Embedding config saved');
                          fetchData();
                        }}
                        className="mt-3 px-4 py-2 min-h-[40px] text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
                      >
                        Save &amp; Retry
                      </button>
                    </div>
                  )}
                  {embeddingStatus?.available && (
                    <p className="text-sm">
                      Memories are automatically extracted when CoS agents complete tasks successfully.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            displayMemories.map(memory => (
              <div key={memory.id} className="bg-port-card border border-port-border rounded-lg p-4">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={`px-2 py-1 text-xs rounded-full border ${MEMORY_TYPE_COLORS[memory.type]}`}>
                        {memory.type}
                      </span>
                      <span className="text-xs text-gray-500">{memory.category}</span>
                      {memory.similarity && (
                        <span className="text-xs text-port-accent">{(memory.similarity * 100).toFixed(0)}% match</span>
                      )}
                    </div>
                    <p className="text-white text-sm">{memory.summary || memory.content?.substring(0, 200)}</p>
                    {memory.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {memory.tags.map(tag => (
                          <span key={tag} className="px-2 py-1 text-xs bg-port-border rounded text-gray-400">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mt-2 flex flex-wrap gap-2">
                      <span>{new Date(memory.createdAt).toLocaleDateString()}</span>
                      <span>*</span>
                      <span>importance: {((memory.importance || 0.5) * 100).toFixed(0)}%</span>
                      {getAppName(memory.sourceAppId, apps) && (
                        <>
                          <span>*</span>
                          <span className="text-port-accent">{getAppName(memory.sourceAppId, apps)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 sm:gap-1">
                    <button
                      onClick={() => setEditingMemory(memory)}
                      className="p-3 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-port-accent transition-colors"
                      title="Edit memory"
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      onClick={() => handleDelete(memory.id)}
                      className="p-3 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-port-error transition-colors"
                      title="Archive memory"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
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

      {/* Edit Modal */}
      {editingMemory && (
        <MemoryEditModal
          memory={editingMemory}
          apps={apps}
          onSave={() => {
            setEditingMemory(null);
            fetchData();
          }}
          onClose={() => setEditingMemory(null)}
        />
      )}
    </div>
  );
}
