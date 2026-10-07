import { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {Trash2, X, Check, XCircle, Pencil, AlertTriangle, Brain, Bot} from 'lucide-react';
import toast from '../../ui/Toast';
import Banner from '../../ui/Banner';
import * as api from '../../../services/api';
import { useSocketResource } from '../../../hooks/useSocketResource';
import { MEMORY_TYPES, MEMORY_TYPE_COLORS } from '../constants';
import { getAppName, formatDateNumeric, formatPercent } from '../../../utils/formatters';
import MemoryTimeline from './MemoryTimeline';
// Lazy: MemoryGraph pulls the three.js stack; load it only when rendered.
const MemoryGraph = lazy(() => import('./MemoryGraph'));
import MemoryEditModal from './MemoryEditModal';
import ProviderModelSelector from '../../ProviderModelSelector';
import useProviderModels from '../../../hooks/useProviderModels';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import CopyableId from '../../ui/CopyableId';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';

const MEMORY_EVENTS = ['cos:memory:created', 'cos:memory:updated', 'cos:memory:deleted', 'cos:memory:extracted'];
const QUEUE_EVENTS = [...MEMORY_EVENTS, 'cos:memory:approval-needed'];
const STATUS_EVENTS = [];

export default function MemoryTab({ apps = [] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [submittedSearch, setSubmittedSearch] = useState('');
  const [filters, setFilters] = useState({ types: [] });
  const [sourceFilter, setSourceFilter] = useState('all'); // 'all' | 'cos' | 'brain'

  const view = searchParams.get('view') || 'list';
  const setView = useCallback((v) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('view', v);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  // /cos/memory/:id deep-links one memory (e.g. from an agent card's "Memories
  // used"). The shared `cos/:tab/:agentId` route names that segment `agentId`.
  const { agentId: linkedMemoryId } = useParams();
  const navigate = useNavigate();
  const linkedMemory = useMemo(() => (linkedMemoryId ? { id: linkedMemoryId } : null), [linkedMemoryId]);
  const openMemory = linkedMemory;
  const closeMemory = useCallback(() => {
    if (linkedMemoryId) navigate('/cos/memory', { replace: true });
  }, [linkedMemoryId, navigate]);
  const { isConfirming, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  // Embedding provider/model configuration
  const { providers, availableModels, setSelectedProviderId: setProviderHook, setSelectedModel: setModelHook, selectedProviderId: hookProviderId, selectedModel: hookModel } = useProviderModels();
  const [embeddingProviderId, setEmbeddingProviderId] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingConfigLoaded, setEmbeddingConfigLoaded] = useState(false);

  // Load current embedding config from CoS config
  useEffect(() => {
    if (embeddingConfigLoaded) return;
    let active = true;
    api.getCosConfig().then(cfg => {
      if (!active) return;
      if (cfg?.embeddingProviderId) {
        setEmbeddingProviderId(cfg.embeddingProviderId);
        setProviderHook(cfg.embeddingProviderId);
      }
      if (cfg?.embeddingModel) {
        setEmbeddingModel(cfg.embeddingModel);
        setModelHook(cfg.embeddingModel);
      }
      setEmbeddingConfigLoaded(true);
    }).catch(() => { if (active) setEmbeddingConfigLoaded(true); });
    return () => { active = false; };
  }, [embeddingConfigLoaded, setProviderHook, setModelHook]);

  const appId = sourceFilter === 'brain' ? 'brain' : sourceFilter === 'cos' ? '__not_brain' : undefined;
  const queryKey = JSON.stringify([sourceFilter, filters, submittedSearch]);
  const list = useSocketResource(async ({ signal }) => {
    const result = submittedSearch
      ? await api.searchMemories(submittedSearch, { limit: 20, appId }, { signal, silent: true })
      : await api.getMemories({ limit: 100, ...filters, appId }, { signal, silent: true });
    return result.memories || [];
  }, { namespace: 'cos', events: MEMORY_EVENTS, resourceKey: queryKey, enabled: view !== 'graph' });

  const queue = useSocketResource(async ({ signal }) => {
    const pending = await api.getMemories({ status: 'pending_approval', limit: 50, appId }, { signal, silent: true });
    return pending.memories || [];
  }, { namespace: 'cos', events: QUEUE_EVENTS, resourceKey: sourceFilter });
  // Counts and pending approvals fail independently: a stats outage must never
  // discard a usable approval queue (or vice versa).
  const counts = useSocketResource(
    ({ signal }) => api.getMemoryStats({ signal, silent: true }),
    { namespace: 'cos', events: QUEUE_EVENTS }
  );

  const status = useSocketResource(async () => {
    const [embeddingStatus, backendStatus] = await Promise.all([
      api.getEmbeddingStatus(), api.getMemoryBackendStatus()
    ]);
    return { embeddingStatus, backendStatus };
  }, { events: STATUS_EVENTS });

  const memories = list.data || [];
  const pendingMemories = queue.data || [];
  const stats = counts.data;
  const embeddingStatus = status.data?.embeddingStatus;
  const backendStatus = status.data?.backendStatus;
  const fetchData = useCallback(() => {
    list.refetch();
    queue.refetch();
    counts.refetch();
    status.refetch();
  }, [list.refetch, queue.refetch, counts.refetch, status.refetch]);

  const [actionInFlight, setActionInFlight] = useState(null);
  const actionRef = useRef(false);

  const handleMemoryAction = async (id, action, label, updateStats) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionInFlight(id);
    const result = await action(id, { silent: true }).catch(err => {
      toast.error(err?.message || `Failed to ${label.toLowerCase()} memory`);
      return null;
    });
    actionRef.current = false;
    setActionInFlight(null);
    if (!result) return;
    toast.success(`Memory ${label}`);
    queue.updateData(prev => prev?.filter(m => m.id !== id));
    counts.updateData(prev => prev ? {
      ...prev,
      pendingApproval: Math.max(0, (prev.pendingApproval || 0) - 1),
      ...(updateStats ? updateStats(prev) : {})
    } : prev);
    list.refetch();
    queue.refetch();
    counts.refetch();
  };

  const handleApprove = (id) => handleMemoryAction(id, api.approveMemory, 'approved', (prev) => ({ active: (prev.active || 0) + 1 }));
  const handleReject = (id) => handleMemoryAction(id, api.rejectMemory, 'rejected', () => ({}));

  const handleSearch = () => {
    const query = searchQuery.trim();
    if (query === submittedSearch) list.refetch();
    else setSubmittedSearch(query);
  };

  const handleDelete = async (id) => {
    await api.deleteMemory(id);
    toast.success('Memory archived');
    list.updateData(prev => prev?.filter(memory => memory.id !== id));
    list.refetch();
    queue.refetch();
    counts.refetch();
  };

  const displayMemories = memories;

  return (
    <div className="space-y-6">
      {/* Backend status banner */}
      {backendStatus?.backend === 'file' && (
        <Banner
          size="lg"
          icon={AlertTriangle}
          title="PostgreSQL unavailable — using file storage"
          actions={
            <button
              onClick={fetchData}
              className="px-3 py-1.5 text-sm bg-port-warning/20 text-port-warning hover:bg-port-warning/30 rounded-lg transition-colors"
            >
              Retry
            </button>
          }
        >
          {backendStatus.db?.error && (
            <p className="text-sm text-gray-400 mt-1">{backendStatus.db.error}</p>
          )}
          <p className="text-sm text-gray-500 mt-1">Some PostgreSQL-only features like cross-instance sync and DB snapshots are unavailable.</p>
        </Banner>
      )}

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
          aria-label="Search memories"
          className="flex-1 bg-port-card border border-port-border rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-port-accent outline-hidden"
        />
        <button
          onClick={handleSearch}
          className="px-3 py-1.5 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Search
        </button>
        {submittedSearch && (
          <button
            onClick={() => { setSubmittedSearch(''); setSearchQuery(''); }}
            aria-label="Close"
            className="px-2 py-1.5 flex items-center justify-center bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors min-h-[44px] min-w-[44px]"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Source + Type Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Source filter */}
        {['all', 'cos', 'brain'].map(src => (
          <button
            key={src}
            onClick={() => setSourceFilter(src)}
            className={`px-3 py-2 min-h-[36px] text-xs rounded-full border transition-colors flex items-center gap-1.5 ${
              sourceFilter === src
                ? 'border-port-accent text-port-accent bg-port-accent/10'
                : 'border-port-border text-gray-500 hover:text-gray-300'
            }`}
          >
            {src === 'brain' && <Brain size={12} />}
            {src === 'cos' && <Bot size={12} />}
            {src === 'all' ? 'All Sources' : src === 'cos' ? 'CoS' : 'Brain'}
          </button>
        ))}
        <span className="w-px h-5 bg-port-border" />
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
                      {formatPercent((memory.confidence || 0) * 100, { decimals: 0 })} confidence
                    </span>
                  </div>
                  <p className="text-white text-sm whitespace-pre-wrap">{memory.summary || memory.content}</p>
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
                    <span>{formatDateNumeric(memory.createdAt)}</span>
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
                    onClick={() => navigate(`/cos/memory/${encodeURIComponent(memory.id)}`)}
                    disabled={actionInFlight === memory.id}
                    className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-port-accent/20 text-port-accent hover:bg-port-accent/30 active:bg-port-accent/40 rounded-lg transition-colors disabled:opacity-50"
                    title="Edit before approving"
                    aria-label="Edit before approving"
                  >
                    <Pencil size={20} />
                  </button>
                  <button
                    onClick={() => handleApprove(memory.id)}
                    disabled={!!actionInFlight}
                    className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-port-success/20 text-port-success hover:bg-port-success/30 active:bg-port-success/40 rounded-lg transition-colors disabled:opacity-50"
                    title="Approve"
                    aria-label="Approve memory"
                  >
                    {actionInFlight === memory.id ? <BrailleSpinner /> : <Check size={20} />}
                  </button>
                  <button
                    onClick={() => handleReject(memory.id)}
                    disabled={!!actionInFlight}
                    className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-red-500/20 text-red-400 hover:bg-red-500/30 active:bg-red-500/40 rounded-lg transition-colors disabled:opacity-50"
                    title="Reject"
                    aria-label="Reject memory"
                  >
                    {actionInFlight === memory.id ? <BrailleSpinner /> : <XCircle size={20} />}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {(list.error || queue.error || counts.error || status.error) && (
        <Banner tone="warning" title="Unable to refresh memories" actions={<button onClick={fetchData}>Retry</button>}>
          Existing rows are retained. Retry to reconcile the latest changes.
        </Banner>
      )}

      {/* Content */}
      {view !== 'graph' && list.loading ? (
        <div className="flex items-center justify-center py-12">
          <BrailleSpinner text="Loading" />
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
                    <Banner tone="warning" size="lg" title="Embedding Service Unavailable" className="text-left max-w-md mx-auto">
                      <p className="text-sm text-gray-400 mt-2">
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
                          selectedProviderId={
                            providers?.some((p) => p.id === embeddingProviderId)
                              ? embeddingProviderId
                              : providers?.some((p) => p.id === hookProviderId)
                                ? hookProviderId
                                : ''
                          }
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
                    </Banner>
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
                      {memory.sourceAppId === 'brain' ? (
                        <span className="flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-port-accent-2/10 text-port-accent-2 border border-port-accent-2/30">
                          <Brain size={10} /> Brain
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 px-2 py-1 text-xs rounded-full bg-port-accent/10 text-port-accent border border-port-accent/30">
                          <Bot size={10} /> CoS
                        </span>
                      )}
                      {memory.similarity && (
                        <span className="text-xs text-port-accent">{formatPercent(memory.similarity * 100, { decimals: 0 })} match</span>
                      )}
                    </div>
                    <p className="text-white text-sm whitespace-pre-wrap">{memory.summary || memory.content}</p>
                    {memory.tags?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {memory.tags.map(tag => (
                          <span key={tag} className="px-2 py-1 text-xs bg-port-border rounded text-gray-400">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mt-2 flex flex-wrap items-center gap-2">
                      <span>{formatDateNumeric(memory.createdAt)}</span>
                      <span>*</span>
                      <span>importance: {formatPercent((memory.importance || 0.5) * 100, { decimals: 0 })}</span>
                      {getAppName(memory.sourceAppId, apps) && (
                        <>
                          <span>*</span>
                          <span className="text-port-accent">{getAppName(memory.sourceAppId, apps)}</span>
                        </>
                      )}
                      {memory.id && <span>*</span>}
                      <CopyableId id={memory.id} />
                    </div>
                  </div>
                  <div className="flex gap-2 sm:gap-1">
                    <button
                      onClick={() => navigate(`/cos/memory/${encodeURIComponent(memory.id)}`)}
                      className="p-3 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-port-accent transition-colors"
                      title="Edit memory"
                      aria-label="Edit memory"
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      onClick={() => requestDelete(memory.id)}
                      className="p-3 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-port-error transition-colors"
                      title="Archive memory"
                      aria-label="Archive memory"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
                {isConfirming(memory.id) && (
                  <InlineConfirmRow
                    className="mt-3"
                    question="Archive this memory? It will be hidden from active memory and search. Its contents remain stored."
                    confirmText="Archive"
                    confirmTitle="Confirm archive"
                    cancelTitle="Cancel archive"
                    onConfirm={() => confirmDelete(() => handleDelete(memory.id))}
                    onCancel={cancelDelete}
                  />
                )}
              </div>
            ))
          )}
        </div>
      ) : view === 'timeline' ? (
        <MemoryTimeline memories={memories} />
      ) : (
        <Suspense fallback={<BrailleSpinner text="Loading graph" />}>
          <MemoryGraph />
        </Suspense>
      )}

      {/* Edit Modal */}
      {openMemory && (
        <MemoryEditModal
          key={openMemory.id}
          memory={openMemory}
          apps={apps}
          onSave={updated => {
            list.updateData(prev => prev?.map(memory => memory.id === updated.id ? updated : memory));
            queue.updateData(prev => prev?.map(memory => memory.id === updated.id ? updated : memory));
            closeMemory();
            fetchData();
          }}
          onClose={closeMemory}
        />
      )}
    </div>
  );
}
