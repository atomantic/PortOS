import { cardRecordLabels } from '../cardRecordLabels';
import { useState, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {Trash2, X, Check, XCircle, Pencil, AlertTriangle, Brain, Bot} from 'lucide-react';
import toast from '../../ui/Toast';
import Banner from '../../ui/Banner';
import {
  searchMemories,
  getMemories,
  getMemoryStats,
  getEmbeddingStatus,
  getMemoryBackendStatus,
  approveMemory,
  rejectMemory,
  deleteMemory,
} from '../../../services/apiMemory.js';
import { useSocketResource } from '../../../hooks/useSocketResource';
import { MEMORY_TYPES, MEMORY_TYPE_COLORS } from '../constants';
import { getAppName, formatCount, formatDateNumeric, formatPercent } from '../../../utils/formatters';
import MemoryTimeline from './MemoryTimeline';
// Lazy: MemoryGraph pulls the three.js stack; load it only when rendered.
const MemoryGraph = lazy(() => import('./MemoryGraph'));
import MemoryEditModal from './MemoryEditModal';
import EmbeddingSourceNotice from '../../settings/EmbeddingSourceNotice';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import CopyableId from '../../ui/CopyableId';
import { useConfirmDelete } from '../../../hooks/useConfirmDelete';

const MEMORY_EVENTS = ['cos:memory:created', 'cos:memory:updated', 'cos:memory:deleted', 'cos:memory:extracted'];
const QUEUE_EVENTS = [...MEMORY_EVENTS, 'cos:memory:approval-needed'];
const MODEL_STATUS_EVENTS = ['memory:models:changed', 'providers:changed'];
const BACKEND_STATUS_EVENTS = [];
const MEMORY_PAGE_SIZE = 50;
const SECONDARY_BUTTON = 'rounded-lg border border-port-border px-3 py-2 text-sm hover:bg-port-border/40 focus-visible:outline-port-accent';

function memorySnippet(memory) {
  const summary = memory.summary?.trim() || memory.content?.trim() || memory.id;
  return summary.length > 100 ? `${summary.slice(0, 100)}…` : summary;
}

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

  const appId = sourceFilter === 'brain' ? 'brain' : sourceFilter === 'cos' ? '__not_brain' : undefined;
  const queryKey = JSON.stringify([sourceFilter, filters, submittedSearch]);
  const browseRequest = useRef(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const list = useSocketResource(async ({ signal, events }) => {
    if (submittedSearch) {
      const result = await searchMemories(submittedSearch, {
        limit: 20, appId, ...(filters.types.length ? { types: filters.types } : {})
      }, { signal, silent: true });
      if (!Array.isArray(result?.memories)) throw new Error('Invalid memory search response');
      return result;
    }

    const request = browseRequest.current;
    // A Load more click can reuse the visible prefix. Socket reconciliation
    // rereads it because insertions and removals may shift the page offsets.
    const previous = events.length === 0 ? request?.appendFrom : null;
    if (request) request.appendFrom = null;
    const target = request?.limit ?? MEMORY_PAGE_SIZE;
    const memories = [...(previous?.memories ?? [])];
    let total = previous?.total ?? target;
    while (memories.length < Math.min(target, total)) {
      const result = await getMemories({
        limit: Math.min(MEMORY_PAGE_SIZE, target - memories.length), offset: memories.length, ...filters, appId
      }, { signal, silent: true });
      if (!Array.isArray(result?.memories) || !Number.isSafeInteger(result.total) || result.total < 0) {
        throw new Error('Invalid memory list response');
      }
      total = result.total;
      if (result.memories.length === 0) break;
      memories.push(...result.memories);
    }
    return { memories, total };
  }, { namespace: 'cos', events: MEMORY_EVENTS, resourceKey: queryKey, enabled: view !== 'graph' });

  const queue = useSocketResource(async ({ signal }) => {
    const pending = await getMemories({ status: 'pending_approval', limit: 50, appId }, { signal, silent: true });
    if (!Array.isArray(pending?.memories)) throw new Error('Invalid pending memory response');
    return pending.memories;
  }, { namespace: 'cos', events: QUEUE_EVENTS, resourceKey: sourceFilter });
  // Counts and pending approvals fail independently: a stats outage must never
  // discard a usable approval queue (or vice versa).
  const counts = useSocketResource(
    async ({ signal }) => {
      const result = await getMemoryStats({ signal, silent: true });
      if (!Number.isFinite(result?.active)) throw new Error('Invalid memory counts response');
      return result;
    },
    { namespace: 'cos', events: QUEUE_EVENTS }
  );

  const modelStatus = useSocketResource(
    ({ signal }) => getEmbeddingStatus({ signal, silent: true }),
    { events: MODEL_STATUS_EVENTS }
  );
  const backend = useSocketResource(
    ({ signal }) => getMemoryBackendStatus({ signal }),
    { events: BACKEND_STATUS_EVENTS }
  );

  const memories = list.data?.memories ?? [];
  const pendingMemories = queue.data || [];
  const stats = counts.data;
  const embeddingStatus = modelStatus.data;
  const classifierStatus = embeddingStatus?.classifier;
  const backendStatus = backend.data;
  const fetchData = useCallback(() => {
    list.refetch();
    queue.refetch();
    counts.refetch();
    modelStatus.refetch();
    backend.refetch();
  }, [list.refetch, queue.refetch, counts.refetch, modelStatus.refetch, backend.refetch]);

  const [actionInFlight, setActionInFlight] = useState(null);
  const actionRef = useRef(false);

  const handleMemoryAction = async (id, action, label) => {
    if (actionRef.current) return;
    actionRef.current = true;
    setActionInFlight(id);
    const result = await action(id, { silent: true }).catch(err => {
      toast.error(err?.message || `Failed to mark memory as ${label}`);
      return null;
    });
    actionRef.current = false;
    setActionInFlight(null);
    if (!result) return;
    toast.success(`Memory ${label}`);
    queue.updateData(prev => prev?.filter(m => m.id !== id));
  };

  const handleApprove = (id) => handleMemoryAction(id, approveMemory, 'approved');
  const handleReject = (id) => handleMemoryAction(id, rejectMemory, 'rejected');

  const resetBrowse = () => {
    browseRequest.current = null;
    setLoadingMore(false);
  };

  const handleSearch = () => {
    const query = searchQuery.trim();
    if (query === submittedSearch) list.refetch();
    else {
      resetBrowse();
      setSubmittedSearch(query);
    }
  };

  const handleLoadMore = async () => {
    if (!list.data || loadingMore || browseRequest.current?.appendFrom) return;
    const request = { limit: memories.length + MEMORY_PAGE_SIZE, appendFrom: list.data };
    browseRequest.current = request;
    setLoadingMore(true);
    await list.refetch();
    if (browseRequest.current === request) setLoadingMore(false);
  };

  const handleDelete = async (id) => {
    const result = await deleteMemory(id, false, { silent: true }).catch(err => {
      toast.error(err?.message || 'Failed to archive memory');
      return null;
    });
    if (!result) return false;
    toast.success('Memory archived');
    // A socket read may already have removed this row and reconciled the total.
    list.updateData(prev => prev?.memories.some(memory => memory.id === id) ? {
      memories: prev.memories.filter(memory => memory.id !== id),
      total: (prev.total ?? prev.memories.length) - 1,
    } : prev);
    return true;
  };

  const snippets = cardRecordLabels([...pendingMemories, ...memories].map(memory => [memory.id, memorySnippet(memory)]));

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
            {formatCount(stats?.active)} active memories
            {stats?.pendingApproval > 0 && <span className="text-yellow-400"> * {stats.pendingApproval} pending</span>}
            {embeddingStatus?.available ? ' * Embeddings online' : ' * Embeddings offline'}
            {classifierStatus && (
              <> * {classifierStatus.available ? 'Memory extraction online' : (
                <Link to="/settings/ai-assignments?q=Memory+extraction+model" className="text-port-accent underline">
                  Memory extraction {classifierStatus.disabled ? 'disabled' : 'offline'}
                </Link>
              )}</>
            )}
          </p>
        </div>
        <div role="group" aria-label="Memory view" className="flex gap-2">
          {['list', 'timeline', 'graph'].map(v => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
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

      {/* Search and type filters only apply to the list and timeline. */}
      {view !== 'graph' && <div className="flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search memories..."
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
            type="button"
            onClick={() => { resetBrowse(); setSubmittedSearch(''); setSearchQuery(''); }}
            aria-label="Clear search"
            className="px-2 py-1.5 flex items-center justify-center bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors min-h-[44px] min-w-[44px]"
          >
            <X size={18} />
          </button>
        )}
      </div>}

      {/* Source selection scopes pending approvals in every view. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">{view === 'graph' ? 'Pending approval source:' : 'Source:'}</span>
        {['all', 'cos', 'brain'].map(src => (
          <button
            key={src}
            aria-pressed={sourceFilter === src}
            onClick={() => {
              if (src === sourceFilter) return;
              resetBrowse();
              setSourceFilter(src);
            }}
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
        {view !== 'graph' && <span className="w-px h-5 bg-port-border" />}
        {view !== 'graph' && MEMORY_TYPES.map(type => (
          <button
            key={type}
            aria-pressed={filters.types.includes(type)}
            onClick={() => {
              const newTypes = filters.types.includes(type)
                ? filters.types.filter(t => t !== type)
                : [...filters.types, type];
              resetBrowse();
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
          {pendingMemories.map(memory => {
            const snippet = snippets.get(memory.id);
            return (
              <div key={memory.id} role="group" aria-label={`Memory: ${snippet}`} className="bg-port-card border border-yellow-500/50 rounded-lg p-4">
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
                      aria-label={`Edit before approving: ${snippet}`}
                    >
                      <Pencil size={20} />
                    </button>
                    <button
                      onClick={() => handleApprove(memory.id)}
                      disabled={!!actionInFlight}
                      className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-port-success/20 text-port-success hover:bg-port-success/30 active:bg-port-success/40 rounded-lg transition-colors disabled:opacity-50"
                      title="Approve"
                      aria-label={`Approve memory: ${snippet}`}
                    >
                      {actionInFlight === memory.id ? <BrailleSpinner /> : <Check size={20} />}
                    </button>
                    <button
                      onClick={() => handleReject(memory.id)}
                      disabled={!!actionInFlight}
                      className="flex-1 sm:flex-none p-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-red-500/20 text-red-400 hover:bg-red-500/30 active:bg-red-500/40 rounded-lg transition-colors disabled:opacity-50"
                      title="Reject"
                      aria-label={`Reject memory: ${snippet}`}
                    >
                      {actionInFlight === memory.id ? <BrailleSpinner /> : <XCircle size={20} />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(list.error || queue.error || counts.error || modelStatus.error || backend.error) && (
        <Banner tone="warning" title="Unable to refresh memories" actions={<button type="button" className={SECONDARY_BUTTON} onClick={fetchData}>Retry</button>}>
          Existing rows are retained. Retry to reconcile the latest changes.
        </Banner>
      )}

      {/* Content */}
      {view !== 'graph' && list.loading ? (
        <div className="flex items-center justify-center py-12">
          <BrailleSpinner text="Loading" />
        </div>
      ) : view !== 'graph' && list.error && list.data == null ? (
        <p role="alert" className="text-port-text-muted">Memory list unavailable.</p>
      ) : view === 'list' ? (
        <div className="space-y-3">
          {memories.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              {submittedSearch ? (
                'No memories found for this search'
              ) : (
                <div className="space-y-4">
                  <p>No memories yet.</p>
                  {!embeddingStatus?.available && (
                    <Banner tone="warning" size="lg" title={embeddingStatus?.disabled ? 'Embeddings Disabled' : 'Embedding Service Unavailable'} className="text-left max-w-md mx-auto">
                      {!embeddingStatus?.disabled && (
                        <p className="text-sm text-gray-400 mt-2">
                          Cannot connect to embedding service{embeddingStatus?.endpoint && (
                            <span>: <code className="text-port-accent">{embeddingStatus.endpoint}</code></span>
                          )}
                        </p>
                      )}
                      {embeddingStatus?.error && (
                        <p className="text-sm text-gray-500 mt-1">Error: {embeddingStatus.error}</p>
                      )}
                      {/* The backend is the shared settings.embeddings store (#18296), edited on Models → Embeddings. */}
                      <EmbeddingSourceNotice className="mt-3" />
                      <button
                        type="button"
                        onClick={fetchData}
                        className="mt-3 px-4 py-2 min-h-[40px] text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
                      >
                        Retry
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
            memories.map(memory => {
              const snippet = snippets.get(memory.id);
              return <div key={memory.id} role="group" aria-label={`Memory: ${snippet}`} className="bg-port-card border border-port-border rounded-lg p-4">
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
                      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-3 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-port-accent transition-colors"
                      title="Edit memory"
                      aria-label={`Edit memory: ${snippet}`}
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      onClick={() => requestDelete(memory.id)}
                      className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-3 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-port-error transition-colors"
                      title="Archive memory"
                      aria-label={`Archive memory: ${snippet}`}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
                {isConfirming(memory.id) && (
                  <InlineConfirmRow
                    className="mt-3"
                    autoFocus
                    aria-label={`Confirm archive memory ${snippet}`}
                    question="Archive this memory? It will be hidden from active memory and search. Its contents remain stored."
                    confirmText="Archive"
                    confirmTitle="Confirm archive"
                    cancelTitle="Cancel archive"
                    onConfirm={() => confirmDelete(() => handleDelete(memory.id))}
                    onCancel={cancelDelete}
                  />
                )}
              </div>;
            })
          )}
        </div>
      ) : view === 'timeline' ? (
        <MemoryTimeline memories={memories} />
      ) : (
        <Suspense fallback={<BrailleSpinner text="Loading graph" />}>
          <MemoryGraph />
        </Suspense>
      )}

      {view !== 'graph' && !submittedSearch && list.data?.total > memories.length && (
        <button
          type="button"
          className={`${SECONDARY_BUTTON} disabled:opacity-50`}
          disabled={loadingMore}
          onClick={handleLoadMore}
        >
          {loadingMore ? 'Loading more…' : `Load more (showing ${formatCount(memories.length)} of ${formatCount(list.data.total)})`}
        </button>
      )}

      {/* Edit Modal */}
      {openMemory && (
        <MemoryEditModal
          key={openMemory.id}
          memory={openMemory}
          apps={apps}
          onSave={updated => {
            if (!submittedSearch && memories.some(memory => memory.id === updated.id)) {
              const matchesSource = sourceFilter === 'all' || (sourceFilter === 'brain') === (updated.sourceAppId === 'brain');
              const matchesType = filters.types.length === 0 || filters.types.includes(updated.type);
              list.updateData(prev => {
                if (!prev?.memories.some(memory => memory.id === updated.id)) return prev;
                return matchesSource && matchesType
                  ? { ...prev, memories: prev.memories.map(memory => memory.id === updated.id ? updated : memory) }
                  : { memories: prev.memories.filter(memory => memory.id !== updated.id), total: prev.total - 1 };
              });
            }
            if (pendingMemories.some(memory => memory.id === updated.id)) {
              queue.updateData(prev => prev?.map(memory => memory.id === updated.id ? updated : memory));
            }
            closeMemory();
          }}
          onClose={closeMemory}
          onArchive={async id => {
            const archived = await handleDelete(id);
            if (archived) {
              queue.updateData(prev => prev?.filter(memory => memory.id !== id));
              closeMemory();
            }
            return archived;
          }}
        />
      )}
    </div>
  );
}
