import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ClipboardList,
  AlertTriangle,
  CheckCircle2,
  X,
  Plus,
  Trash2,
  Crown,
  FileText,
  Pencil,
  Check,
  XCircle,
  Maximize2,
  Minimize2,
  Eye,
  Clock3,
  BellRing,
  Inbox,
  ArrowRight,
  Brain as BrainIcon,
  MessageCircle,
  Mail,
  Activity,
  DatabaseBackup,
  CalendarDays,
  ListTodo,
  Hourglass,
  Sparkles,
  History as HistoryIcon,
  ExternalLink,
  Save
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import QueueInvestigationButton from '../components/ui/QueueInvestigationButton';
import PageSkeleton from '../components/ui/PageSkeleton';
import CollapsibleText from '../components/ui/CollapsibleText';
import MarkdownOutput from '../components/cos/MarkdownOutput';
import Drawer from '../components/Drawer';
import TabPills from '../components/ui/TabPills';
import useUrlParams from '../hooks/useUrlParams';
import useAsyncAction from '../hooks/useAsyncAction';
import { timeAgo, formatDateTime, formatCount, localDateKey } from '../utils/formatters';
import { markdownToPlainText, dropsMarkupWhenFlattened } from '../utils/markdownText';
import { useActionQueue } from '../hooks/useActionQueue';
import * as api from '../services/api';
import socket from '../services/socket';

// Cross-domain queue source → icon + accent (M42 P5 inbox-zero aggregator).
const QUEUE_SOURCE_CONFIG = {
  brain: { icon: BrainIcon, color: 'text-port-accent-2' },
  ask: { icon: MessageCircle, color: 'text-port-accent' },
  cos: { icon: Crown, color: 'text-port-accent' },
  drafts: { icon: Mail, color: 'text-port-accent' },
  feedback: { icon: MessageCircle, color: 'text-port-warning' },
  health: { icon: Activity, color: 'text-port-warning' },
  backup: { icon: DatabaseBackup, color: 'text-port-error' },
  threads: { icon: BrainIcon, color: 'text-port-accent-2' },
  todo: { icon: ListTodo, color: 'text-port-success' },
  history: { icon: HistoryIcon, color: 'text-gray-400' },
};

const QUEUE_SEVERITY_STYLE = {
  critical: 'border-port-error/40',
  high: 'border-port-warning/40',
  normal: 'border-port-border'
};

const TYPE_CONFIG = {
  alert: { label: 'Alerts', icon: AlertTriangle, color: 'text-port-warning' },
  cos: { label: 'CoS Actions', icon: Crown, color: 'text-port-accent' },
  todo: { label: 'Todos', icon: ClipboardList, color: 'text-port-success' },
  briefing: { label: 'Briefing', icon: FileText, color: 'text-gray-400' }
};

const TYPE_PRIORITY = { alert: 0, cos: 1, todo: 2, briefing: 3 };

const ACTION_VIEWS = [
  { id: 'today', label: 'Today', icon: CalendarDays },
  { id: 'all', label: 'All', icon: ListTodo },
  { id: 'waiting', label: 'Waiting', icon: Hourglass },
  { id: 'someday', label: 'Someday', icon: Sparkles },
  { id: 'snoozed', label: 'Snoozed', icon: Clock3 },
  { id: 'history', label: 'History', icon: HistoryIcon },
];
const ACTION_VIEW_IDS = new Set(ACTION_VIEWS.map(({ id }) => id));

const QUEUE_SNOOZE_OPTIONS = [
  { value: 60 * 60 * 1000, label: '1 hour' },
  { value: 24 * 60 * 60 * 1000, label: '1 day' },
  { value: 7 * 24 * 60 * 60 * 1000, label: '1 week' },
];

const queueItemKey = (itemOrId) => {
  if (itemOrId && typeof itemOrId === 'object') {
    return JSON.stringify([itemOrId.id || '', itemOrId.occurrence ?? '', itemOrId.revision ?? '']);
  }
  return JSON.stringify([itemOrId || '', '', '']);
};

const SOURCE_OWNED_REVIEW_CATEGORIES = new Set([
  'content-review',
  'goal-fidelity',
  'memory-approval',
  'plan-question',
  'task-approval',
  'autopilot-paused',
]);

function isSourceOwnedReviewItem(item) {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const hasReference = (value) => (typeof value === 'string' && value.trim())
    || (typeof value === 'number' && Number.isFinite(value));
  if (metadata.sourceOwned === true || metadata.triageOnly === true) return true;
  if (SOURCE_OWNED_REVIEW_CATEGORIES.has(metadata.category)) return true;
  if (item?.type === 'cos' && (hasReference(metadata.taskId) || hasReference(metadata.referenceId))) return true;
  return item?.type === 'alert';
}

function isGenericCompletableItem(item) {
  return !isSourceOwnedReviewItem(item);
}

function isActionableItem(item) {
  if (item.type === 'alert' || item.type === 'todo') return true;
  if (item.type === 'cos') {
    return item.metadata?.requiresAction === true || item.metadata?.approvalRequired === true;
  }
  return false;
}

export default function Review() {
  const navigate = useNavigate();
  const { actionId } = useParams();
  const [searchParams, updateParams] = useUrlParams();
  const requestedActionView = searchParams.get('view');
  const actionView = ACTION_VIEW_IDS.has(requestedActionView) ? requestedActionView : 'today';
  const [items, setItems] = useState([]);
  const [briefing, setBriefing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newTodo, setNewTodo] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [briefingFullscreen, setBriefingFullscreen] = useState(false);
  const [counts, setCounts] = useState(null);
  const countsRequestId = useRef(0);

  // Cross-domain live queue (M42 P5). Source payloads remain live projections;
  // presentation decisions are durable server-side markers keyed by the row's
  // canonical action identity, occurrence, and revision.
  const { data: queue, error: queueError, loading: queueLoading, refetch: fetchQueue } = useActionQueue(actionView);
  const [dismissedQueueIds, setDismissedQueueIds] = useState(() => new Set());
  // Rows with an inline accept/promote in flight — disables the button so a
  // double-tap can't double-resolve while the request is pending.
  const [resolvingQueueIds, setResolvingQueueIds] = useState(() => new Set());

  const fetchItems = useCallback(async () => {
    const params = filter === 'all' ? {} : { status: filter };
    const data = await api.getReviewItems(params).catch(() => []);
    setItems(data);
    setLoading(false);
  }, [filter]);

  const fetchCounts = useCallback(() => {
    const requestId = ++countsRequestId.current;
    api.getReviewCounts({ silent: true }).then(data => {
      if (requestId === countsRequestId.current) setCounts(data);
    }).catch(() => null);
  }, []);

  const fetchBriefing = useCallback(async () => {
    const data = await api.getReviewBriefing().catch(() => null);
    setBriefing(data);
  }, []);

  useEffect(() => {
    fetchItems();
    fetchCounts();
    fetchBriefing();
  }, [fetchItems, fetchCounts, fetchBriefing]);

  useEffect(() => {
    const handleCreated = (item) => {
      fetchCounts();
      if (item.metadata?.privateSecurity) { fetchItems(); return; }
      setItems(prev => {
        if (prev.some(i => i.id === item.id)) return prev;
        return [item, ...prev];
      });
    };
    const handleUpdated = (item) => {
      fetchCounts();
      if (item.metadata?.privateSecurity) { fetchItems(); return; }
      setItems(prev => prev.map(i => i.id === item.id ? item : i));
    };
    const handleDeleted = (item) => {
      fetchCounts();
      setItems(prev => prev.filter(i => i.id !== item.id));
    };
    // Bulk status change ("Mark all read" / "Complete all") — one state
    // update for every affected id instead of N per-item events.
    const handleBulkUpdated = ({ ids, status, updatedAt }) => {
      fetchCounts();
      const idSet = new Set(ids);
      setItems(prev => prev.map(i => idSet.has(i.id) ? { ...i, status, updatedAt } : i));
    };

    socket.on('review:item:created', handleCreated);
    socket.on('review:item:updated', handleUpdated);
    socket.on('review:item:deleted', handleDeleted);
    socket.on('review:items:bulk-updated', handleBulkUpdated);

    return () => {
      socket.off('review:item:created', handleCreated);
      socket.off('review:item:updated', handleUpdated);
      socket.off('review:item:deleted', handleDeleted);
      socket.off('review:items:bulk-updated', handleBulkUpdated);
    };
  }, [fetchCounts, fetchItems]);

  const handleCreateTodo = async (e) => {
    e.preventDefault();
    if (!newTodo.trim()) return;
    const thread = await api.createThread({ title: newTodo.trim() }, { silent: true }).catch(() => null);
    setNewTodo('');
    await fetchQueue();
    if (thread?.id) {
      const threadView = actionView === 'all' || actionView === 'today' ? actionView : 'today';
      navigate(`/review/${encodeURIComponent(`threads:${thread.id}`)}?view=${threadView}`);
    }
  };

  const handleComplete = async (id) => {
    await api.completeReviewItem(id).catch(() => null);
  };

  const handleDismiss = async (id) => {
    await api.dismissReviewItem(id).catch(() => null);
  };

  const handleDelete = async (id) => {
    await api.deleteReviewItem(id).catch(() => null);
  };

  const handleSaveEdit = async (id, title, description) => {
    await api.updateReviewItem(id, { title, description }).catch(() => null);
    setEditingId(null);
  };

  const handleMarkAllRead = () => api.bulkUpdateReviewStatus({ status: 'dismissed' }).catch(() => null);
  const handleCompleteAll = () => api.bulkUpdateReviewStatus({ status: 'completed' }).catch(() => null);

  const handleQueueDismiss = (itemOrId) => {
    const key = queueItemKey(itemOrId);
    setDismissedQueueIds(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const handleQueueDrill = (item) => {
    if (item.drillTo) navigate(item.drillTo);
  };

  const handleQueueSelect = (item) => {
    navigate(`/review/${encodeURIComponent(item.id)}?view=${actionView}`);
  };

  const handleQueueResolve = async (item, operation, input = {}) => {
    if (resolvingQueueIds.has(item.id)) return;
    setResolvingQueueIds(prev => new Set(prev).add(item.id));
    // The helper toasts on failure (default), so don't add a custom catch toast.
    const ok = await api.resolveReviewQueueItem(
      item.id,
      operation ? { operation, ...input } : {},
    ).then(() => true).catch(() => false);
    setResolvingQueueIds(prev => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    // Keep the visible row responsive, then re-read the canonical source. This
    // matters for status views: a completed commitment must disappear from
    // Today but remain reachable in History.
    if (ok) {
      handleQueueDismiss(item);
      await fetchQueue();
      if (actionId === item.id) navigate(`/review?view=${actionView}`, { replace: true });
    }
    return ok;
  };

  const handleQueueTriage = async (item, operation, input = {}) => {
    if (resolvingQueueIds.has(item.id)) return false;
    setResolvingQueueIds(prev => new Set(prev).add(item.id));
    const ok = await api.triageReviewQueueItem(item.id, { operation, ...input })
      .then(() => true)
      .catch(() => false);
    setResolvingQueueIds(prev => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    if (ok) {
      handleQueueDismiss(item);
      await fetchQueue();
      if (actionId === item.id) navigate(`/review?view=${actionView}`, { replace: true });
    }
    return ok;
  };

  const handleQueuePromoteAsk = async (item, target, goalId) => {
    if (resolvingQueueIds.has(item.id)) return;
    setResolvingQueueIds(prev => new Set(prev).add(item.id));
    // The helper toasts on failure (default), so don't add a custom catch toast.
    const ok = await api.promoteAskReviewQueueItem(item.id, target, goalId ? { goalId } : {}).then(() => true).catch(() => false);
    setResolvingQueueIds(prev => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    // Reactive removal — drop the promoted row in place, then refresh the
    // source-backed queue so counts and partial-source metadata stay truthful.
    if (ok) {
      handleQueueDismiss(item);
      await fetchQueue();
    }
  };

  const setActionView = (view) => {
    setDismissedQueueIds(new Set());
    updateParams({ view });
  };

  // Derived review state. Memoized because this page subscribes to
  // review:item:created/updated/deleted socket events and re-renders on each —
  // without memoization every one of these filter/sort passes over `items` reruns
  // on unrelated re-renders (typing, hover state). Hooks must run before the
  // loading early-return, so they live here above it.
  // Keep the detailed list aligned with the active status tab while socket
  // events update the cached items from every status.
  const visibleItems = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter(item => item.status === filter);
  }, [items, filter]);

  const grouped = useMemo(() => visibleItems.reduce((acc, item) => {
    if (!acc[item.type]) acc[item.type] = [];
    acc[item.type].push(item);
    return acc;
  }, {}), [visibleItems]);

  const queueItems = useMemo(
    () => (queue?.items || []).filter(i => !dismissedQueueIds.has(queueItemKey(i))),
    [queue, dismissedQueueIds]);
  const queueSourceErrors = useMemo(
    () => Object.entries(queue?.sources || {}).filter(([, s]) => s.error),
    [queue]);
  const selectedAction = useMemo(
    () => (queue?.items || []).find((item) => item.id === actionId) || null,
    [queue, actionId]);
  // Keep old stored Review records rendered only as a compatibility fallback
  // while the live Actions projection is empty. Once a canonical row exists,
  // rendering the old lists as well would show the same obligation twice.
  const showLegacyReviewSurface = queue && !queueError && queueItems.length === 0 && queueSourceErrors.length === 0 && !queue.partial;

  const pendingItems = useMemo(() => items.filter(i => i.status === 'pending'), [items]);
  const genericCompletableCount = pendingItems.filter(isGenericCompletableItem).length;

  const actionableItems = useMemo(() => pendingItems
    .filter(isActionableItem)
    .sort((a, b) => {
      const priority = TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
      if (priority !== 0) return priority;
      return new Date(b.createdAt) - new Date(a.createdAt);
    }), [pendingItems]);

  if (loading) {
    return <PageSkeleton
        label="Loading Actions"
        header="bar"
        padded
        fullHeight
        titleWidthClass="w-40"
        cards={4}
        sidebar={false}
      />;
  }

  // Cheap derivations off the memoized `pendingItems`/`actionableItems` — plain
  // consts, not memos: the action list is an O(8) slice with no consumer that
  // needs referential stability, so a hook here would be pure ceremony.
  const topActionItems = actionableItems.slice(0, 8);

  // This count controls actions for the currently loaded filter; the global
  // triage summary below comes from the unfiltered counts endpoint.
  const pendingCount = pendingItems.length;
  const remainingActionCount = Math.max(0, actionableItems.length - topActionItems.length);

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={ClipboardList}
        iconColor="text-white"
        title="Actions"
        actions={(
          <>
            <select
              aria-label="Filter review items by status"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm text-gray-300"
            >
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
              <option value="dismissed">Dismissed</option>
              <option value="all">All</option>
            </select>
            {pendingCount > 0 && (
              <>
                {genericCompletableCount > 0 && (
                  <button
                    onClick={handleCompleteAll}
                    className="px-3 py-2 text-sm bg-port-success/10 hover:bg-port-success/20 border border-port-success/30 rounded-lg text-port-success transition-colors"
                    title="Mark all general pending items as completed"
                  >
                    Complete All
                  </button>
                )}
                <button
                  onClick={handleMarkAllRead}
                  className="px-3 py-2 text-sm bg-port-border/50 hover:bg-port-border rounded-lg text-gray-300 transition-colors"
                  title="Dismiss all pending items"
                >
                  Dismiss All
                </button>
              </>
            )}
          </>
        )}
      />
      <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-3">
        <TabPills
          tabs={ACTION_VIEWS}
          activeTab={actionView}
          onChange={setActionView}
          ariaLabel="Actions views"
          mobileCompact
          mobileSelectId="actions-view-select"
          controlsIdPrefix="actions-view"
        />
        {/* Triage summary */}
        <section className="flex flex-wrap gap-2">
          {queue && <span className="text-sm text-port-text">{queue.partial || queueError ? 'At least ' : ''}{formatCount(queueItems.filter(item => item.required === true).length)} required</span>}
          {queueLoading && !queue && <span role="status">Loading actions…</span>}
          {queueError && <span role="alert">Actions unavailable{queue ? ' — showing last known actions' : ''}. <button onClick={fetchQueue}>Retry</button></span>}
        </section>
        <details>
          <summary className="text-xs text-port-text-muted">Stored review history counts</summary>
          <section className="flex flex-wrap gap-2">
            <SummaryPill icon={BellRing} label="Pending" value={counts?.total ?? 0} tone="text-white" />
            <SummaryPill icon={AlertTriangle} label="Alerts" value={counts?.alert ?? 0} tone="text-port-warning" urgent={(counts?.alert ?? 0) > 0} />
            <SummaryPill icon={Crown} label="CoS" value={counts?.cos ?? 0} tone="text-port-accent" />
            <SummaryPill icon={ClipboardList} label="Todos" value={counts?.todo ?? 0} tone="text-port-success" />
          </section>
        </details>

        {/* Canonical Actions queue — live-pulled from Brain commitments, manual
            todos, Ask, CoS, Messages, Health, and Backups. Shown whenever there
            are items OR a source failed to load (so the degraded-source notice
            isn't hidden behind an otherwise-empty queue). */}
        {(queueItems.length > 0 || queueSourceErrors.length > 0 || queue?.partial) && (
          <section className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Inbox size={16} className="text-port-accent" />
                Actions
              </h3>
              {queueItems.length > 0 && (
                <span className="text-xs rounded-full px-2 py-0.5 bg-port-accent/10 text-port-accent border border-port-accent/20">
                  {formatCount(queueItems.length)} across domains
                </span>
              )}
            </div>
            {queueItems.length > 0 && (
              <div className="space-y-2">
                {queueItems.map(item => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    onSelect={handleQueueSelect}
                    onDrill={handleQueueDrill}
                    onResolve={handleQueueResolve}
                    onPromoteAsk={handleQueuePromoteAsk}
                    onTriage={handleQueueTriage}
                    resolving={resolvingQueueIds.has(item.id)}
                  />
                ))}
              </div>
            )}
            {queueSourceErrors.length > 0 && (
              <p role="status" className="text-xs text-gray-600">
                Couldn&apos;t load: {queueSourceErrors.map(([, s]) => s.label).join(', ')}.
              </p>
            )}
            {queue?.partial && (
              <p role="status" className="text-xs text-gray-500">
                This bounded view may omit additional actions; open a source to see its complete list.
              </p>
            )}
          </section>
        )}

        {/* Quick Add */}
        <form onSubmit={handleCreateTodo} className="flex gap-2">
          <input
            type="text"
            value={newTodo}
            onChange={(e) => setNewTodo(e.target.value)}
            aria-label="Quick add action"
            placeholder="Quick add action..."
            className="flex-1 bg-port-card border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
          />
          <button
            type="submit"
            disabled={!newTodo.trim()}
            className="px-3 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-white text-sm font-medium transition-colors flex items-center gap-1.5"
          >
            <Plus size={16} />
            Add
          </button>
        </form>

        {/* Legacy Review list — only shown when the canonical projection is
            empty, so old stored records remain usable without duplicating the
            Actions rows. */}
        {showLegacyReviewSurface && topActionItems.length > 0 && (
          <section className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Eye size={16} className="text-port-warning" />
                Action Queue
              </h3>
              <span className="text-xs rounded-full px-2 py-0.5 bg-port-warning/10 text-port-warning border border-port-warning/20">
                {formatCount(actionableItems.length)} actionable
              </span>
            </div>
            <div className="space-y-2">
              {topActionItems.map(item => (
                <ReviewItem
                  key={item.id}
                  item={item}
                  config={TYPE_CONFIG[item.type]}
                  idScope="action-queue"
                  isEditing={editingId === item.id}
                  onComplete={handleComplete}
                  onDismiss={handleDismiss}
                  onDelete={handleDelete}
                  onStartEdit={() => setEditingId(item.id)}
                  onSaveEdit={handleSaveEdit}
                  onCancelEdit={() => setEditingId(null)}
                  compact={false}
                />
              ))}
            </div>
            {remainingActionCount > 0 && (
              <p className="text-xs text-gray-500">
                {formatCount(remainingActionCount)} more actionable item{remainingActionCount !== 1 ? 's' : ''} below.
              </p>
            )}
          </section>
        )}

        {/* Daily Briefing remains available as compatibility/history context. */}
        {showLegacyReviewSurface && briefing && briefing.source !== 'none' && (
          <section className={`bg-port-card border border-port-border rounded-xl p-4 ${briefingFullscreen ? 'fixed inset-0 z-50 overflow-y-auto m-0 rounded-none' : ''}`}>
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <FileText size={16} className="text-gray-400" />
                Daily Briefing
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-600">
                  {briefing.source} &middot; {formatDateTime(briefing.generatedAt)}
                </span>
                <button
                  onClick={() => setBriefingFullscreen(prev => !prev)}
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-white transition-colors rounded-md hover:bg-white/5"
                  title={briefingFullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={briefingFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {briefingFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
              </div>
            </div>
            <div className={`text-gray-400 text-sm overflow-y-auto ${briefingFullscreen ? '' : 'max-h-[32rem]'}`}>
              <MarkdownOutput content={briefing.content} />
            </div>
          </section>
        )}

        {/* Detailed sections — tiled two-up on wide screens so the per-type
            queues use the full width instead of stacking in one column. */}
        {showLegacyReviewSurface && <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        {['alert', 'cos', 'todo', 'briefing'].map(type => {
          const typeItems = grouped[type];
          if (!typeItems?.length) return null;
          const config = TYPE_CONFIG[type];
          const TypeIcon = config.icon;

          return (
            <section key={type} className="space-y-2">
              <h3 className={`text-sm font-semibold uppercase tracking-wide ${config.color} flex items-center gap-2`}>
                <TypeIcon size={16} />
                {config.label}
                <span className="text-gray-600">({formatCount(typeItems.length)})</span>
              </h3>
              <div className="space-y-1">
                {typeItems.map(item => (
                  <ReviewItem
                    key={item.id}
                    item={item}
                    config={config}
                    idScope={`section-${type}`}
                    isEditing={editingId === item.id}
                    onComplete={handleComplete}
                    onDismiss={handleDismiss}
                    onDelete={handleDelete}
                    onStartEdit={() => setEditingId(item.id)}
                    onSaveEdit={handleSaveEdit}
                    onCancelEdit={() => setEditingId(null)}
                    compact={topActionItems.some(topItem => topItem.id === item.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
        </div>}

        {showLegacyReviewSurface && visibleItems.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
            <p className="text-lg">No review items in this view</p>
            <p className="text-sm mt-1">This hub will fill up as agents surface alerts, actions, and briefing context.</p>
          </div>
        )}
      </div>
      <ActionDetail
        item={selectedAction}
        onClose={() => navigate(`/review?view=${actionView}`, { replace: true })}
        onResolve={handleQueueResolve}
        onTriage={handleQueueTriage}
        triagePending={Boolean(actionId && resolvingQueueIds.has(actionId))}
        onSaved={fetchQueue}
        onDrill={handleQueueDrill}
      />
    </div>
  );
}

// Priority badge tint for CoS rows so HIGH/MEDIUM/LOW read at a glance.
const QUEUE_PRIORITY_STYLE = {
  HIGH: 'text-port-error border-port-error/30 bg-port-error/10',
  MEDIUM: 'text-port-warning border-port-warning/30 bg-port-warning/10',
  LOW: 'text-gray-400 border-gray-500/30 bg-gray-500/10'
};

// Render the source-appropriate triage chips from item.meta. Each field is
// optional — the server omits it when the underlying record lacks it, so we
// only render the chips that are present (no fabricated values).
function QueueMetaChips({ meta }) {
  if (!meta) return null;
  const chips = [];
  if (meta.priority) {
    chips.push(
      <span key="priority" className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${QUEUE_PRIORITY_STYLE[meta.priority] || QUEUE_PRIORITY_STYLE.LOW}`}>
        {meta.priority}
      </span>
    );
  }
  if (typeof meta.turnCount === 'number') {
    chips.push(
      <span key="turns" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {formatCount(meta.turnCount)} turn{meta.turnCount === 1 ? '' : 's'}
      </span>
    );
  }
  if (meta.recipient) {
    chips.push(
      <span key="recipient" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400 max-w-[12rem] truncate" title={meta.recipient}>
        → {meta.recipient}
      </span>
    );
  }
  if (meta.channel) {
    chips.push(
      <span key="channel" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {meta.channel}
      </span>
    );
  }
  if (meta.captureSource) {
    chips.push(
      <span key="capture" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {meta.captureSource}
      </span>
    );
  }
  if (meta.alertType) {
    chips.push(
      <span key="alert" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {meta.alertType}
      </span>
    );
  }
  if (meta.localStatus) {
    chips.push(
      <span key="local-status" className="text-[10px] px-1.5 py-0.5 rounded border border-port-accent/30 text-port-accent">
        local: {meta.localStatus}
      </span>
    );
  }
  if (meta.externalState) {
    chips.push(
      <span key="external-state" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        external: {meta.externalState}
      </span>
    );
  }
  if (!chips.length) return null;
  return <div className="flex items-center gap-1.5 flex-wrap mt-1">{chips}</div>;
}

// Promote-target label for the Ask picker buttons.
const PROMOTE_TARGET_LABEL = { brain: 'Brain', task: 'Task', goal: 'Goal' };

function FeedbackRatingControls({ id, onSubmit, disabled = false, options = ['positive', 'negative', 'neutral'] }) {
  const [rating, setRating] = useState('');
  const [comment, setComment] = useState('');
  const safeId = String(id || 'feedback').replace(/[^a-zA-Z0-9_-]/g, '-');
  const ratingId = `feedback-rating-${safeId}`;
  const commentId = `feedback-comment-${safeId}`;
  const submit = () => {
    if (!rating) return;
    const trimmedComment = comment.trim();
    onSubmit({ rating, ...(trimmedComment ? { comment: trimmedComment } : {}) });
  };

  return (
    <div className="flex items-end gap-2 flex-wrap rounded-md border border-port-border/60 bg-port-bg/40 p-2">
      <label className="text-xs text-gray-400" htmlFor={ratingId}>
        Rating (required)
        <select
          id={ratingId}
          value={rating}
          onChange={(event) => setRating(event.target.value)}
          disabled={disabled}
          className="mt-1 block min-h-[36px] rounded border border-port-border bg-port-card px-2 py-1 text-xs text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent disabled:opacity-50"
        >
          <option value="">Choose…</option>
          {options.map((option) => (
            <option key={option} value={option}>{option[0].toUpperCase() + option.slice(1)}</option>
          ))}
        </select>
      </label>
      <label className="min-w-[12rem] flex-1 text-xs text-gray-400" htmlFor={commentId}>
        Comment (optional)
        <input
          id={commentId}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={5000}
          disabled={disabled}
          className="mt-1 block min-h-[36px] w-full rounded border border-port-border bg-port-card px-2 py-1 text-xs text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent disabled:opacity-50"
        />
      </label>
      <button
        type="button"
        onClick={submit}
        disabled={disabled || !rating}
        className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-port-success/30 bg-port-success/10 px-2 py-1 text-xs font-medium text-port-success hover:bg-port-success/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Check size={14} />
        Rate
      </button>
    </div>
  );
}

function QueueTriageControls({ item, onTriage, disabled = false }) {
  const operations = Array.isArray(item?.triageOperations)
    ? item.triageOperations.filter((operation) => operation?.available !== false)
    : [];
  if (!onTriage || operations.length === 0) return null;

  const hasOperation = (id) => operations.some((operation) => operation.id === id);
  const snooze = (event) => {
    const duration = Number(event.target.value);
    event.target.value = '';
    if (!Number.isFinite(duration) || duration <= 0) return;
    onTriage(item, 'snooze', { snoozedUntil: new Date(Date.now() + duration).toISOString() });
  };

  return (
    <div className="inline-flex items-center gap-2 flex-wrap">
      {hasOperation('snooze') && (
        <label className="inline-flex items-center">
          <span className="sr-only">Snooze {item.title}</span>
          <select
            defaultValue=""
            aria-label={`Snooze ${item.title}`}
            onChange={snooze}
            disabled={disabled}
            className="min-h-[36px] rounded-md border border-port-warning/30 bg-port-warning/10 px-2 py-1 text-xs font-medium text-port-warning transition-colors hover:bg-port-warning/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent disabled:cursor-not-allowed disabled:opacity-40"
            title="Snooze this action"
          >
            <option value="">Snooze…</option>
            {QUEUE_SNOOZE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
      {hasOperation('unsnooze') && (
        <button
          type="button"
          onClick={() => onTriage(item, 'unsnooze')}
          disabled={disabled}
          className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-port-warning/30 bg-port-warning/10 px-2 py-1 text-xs font-medium text-port-warning transition-colors hover:bg-port-warning/20 disabled:cursor-not-allowed disabled:opacity-40"
          title="Show this action again"
        >
          <Clock3 size={13} />
          Unsnooze
        </button>
      )}
      {hasOperation('dismiss') && (
        <button
          type="button"
          onClick={() => onTriage(item, 'dismiss')}
          disabled={disabled}
          className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-md border border-port-border px-2 py-1 text-gray-500 transition-colors hover:border-port-warning/40 hover:text-port-warning disabled:cursor-not-allowed disabled:opacity-40"
          title="Dismiss this recommendation"
          aria-label="Dismiss this recommendation"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}

function QueueRow({ item, onSelect, onDrill, onResolve, onPromoteAsk, onTriage, resolving = false }) {
  const config = QUEUE_SOURCE_CONFIG[item.source] || { icon: Inbox, color: 'text-gray-400' };
  const Icon = config.icon;
  const borderTone = QUEUE_SEVERITY_STYLE[item.severity] || QUEUE_SEVERITY_STYLE.normal;
  const promoteTargets = Array.isArray(item.promoteTargets) ? item.promoteTargets : [];
  const goalOptions = Array.isArray(item.goalOptions) ? item.goalOptions : [];
  // The goal target needs a goalId, so it's rendered as a picker rather than a
  // one-click button — split it out from the simple brain/task targets.
  const simpleTargets = promoteTargets.filter(t => t !== 'goal');
  const showGoalPicker = promoteTargets.includes('goal') && goalOptions.length > 0;
  const sourceOperations = !promoteTargets.length && Array.isArray(item.operations)
    ? item.operations.filter(operation => operation && operation.available !== false)
    : [];
  const rateOperation = sourceOperations.find((operation) => operation.id === 'rate' && operation.input?.type === 'rating');
  const inlineActions = item.action
    ? [{ id: 'resolve', label: item.action }]
    : sourceOperations.filter((operation) => operation.id !== 'rate');

  return (
    <div className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 p-3 rounded-lg border bg-port-card ${borderTone}`}>
      <div className={`mt-0.5 shrink-0 ${config.color}`}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onSelect?.(item)}
            className="min-w-0 break-words text-sm font-medium text-white text-left hover:text-port-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent rounded"
            aria-label={`Open action ${item.title}`}
          >
            {item.title}
          </button>
          <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-current/20 ${config.color}`}>
            {item.sourceLabel}
          </span>
        </div>
        {item.summary && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 break-words">{item.summary}</p>
        )}
        <QueueMetaChips meta={item.meta} />
        {item.timestamp && (
          <p className="text-xs text-gray-600 mt-1 flex items-center gap-1">
            <Clock3 size={12} />
            {timeAgo(item.timestamp)}
          </p>
        )}
      </div>
      <div className="col-span-2 flex min-w-0 items-center gap-2 flex-wrap border-t border-port-border/50 pt-2 sm:col-start-2 sm:col-span-1 [&_button]:min-h-[44px] [&_select]:min-h-[44px]">
        <QueueInvestigation item={item} />
        {onResolve && rateOperation && (
          <FeedbackRatingControls
            id={item.id}
            options={rateOperation.input.options}
            disabled={resolving}
            onSubmit={(input) => onResolve(item, rateOperation.id, input)}
          />
        )}
        {onResolve && inlineActions.map(action => (
          <button
            key={action.id}
            onClick={() => onResolve(item, action.id === 'resolve' ? undefined : action.id)}
            disabled={resolving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-port-success bg-port-success/10 hover:bg-port-success/20 border border-port-success/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={`${action.label} this item in place`}
          >
            <Check size={14} />
            {action.label}
          </button>
        ))}
        {onPromoteAsk && simpleTargets.map(target => (
          <button
            key={target}
            onClick={() => onPromoteAsk(item, target)}
            disabled={resolving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-port-accent bg-port-accent/10 hover:bg-port-accent/20 border border-port-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={`Promote the latest answer to ${PROMOTE_TARGET_LABEL[target] || target}`}
          >
            <ArrowRight size={12} />
            {PROMOTE_TARGET_LABEL[target] || target}
          </button>
        ))}
        {showGoalPicker && onPromoteAsk && (
          <label className="inline-flex items-center gap-1 text-xs">
            <span className="sr-only">Promote the latest answer to a goal</span>
            <select
              defaultValue=""
              disabled={resolving}
              onChange={(e) => {
                const goalId = e.target.value;
                if (!goalId) return;
                onPromoteAsk(item, 'goal', goalId);
                e.target.value = '';
              }}
              className="px-2 py-1 rounded-md text-xs font-medium text-port-accent bg-port-accent/10 hover:bg-port-accent/20 border border-port-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
              title="Promote the latest answer into a goal's progress"
            >
              <option value="">→ Goal…</option>
              {goalOptions.map(g => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </label>
        )}
        <QueueTriageControls item={item} onTriage={onTriage} disabled={resolving} />
        <button
          type="button"
          onClick={() => onDrill(item)}
          className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-accent transition-colors"
          title="Open" aria-label="Open"
        >
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}

function QueueInvestigation({ item }) {
  if (item.investigation) {
    return <QueueInvestigationButton key={item.id} task={item.investigation} className="min-h-[44px] max-w-full" />;
  }
  return item.investigationUnavailable
    ? <p className="w-full text-xs text-port-text-muted">{item.investigationUnavailable}</p>
    : null;
}

function SummaryPill({ icon: Icon, label, value, tone = 'text-white', urgent = false }) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 bg-port-card ${urgent ? 'border-port-warning/40' : 'border-port-border'}`}>
      <Icon size={14} className={urgent ? 'text-port-warning' : tone} />
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-bold ${tone}`}>{formatCount(value, { fallback: '0' })}</span>
    </div>
  );
}

// `idScope` namespaces the body's DOM id. An actionable item renders twice —
// once in the Action Queue and again (dimmed) in its per-type section — so
// without a scope both copies would share one id and the disclosure's
// aria-controls would be ambiguous.
function ReviewItem({ item, config, idScope, isEditing, onComplete, onDismiss, onDelete, onStartEdit, onSaveEdit, onCancelEdit, compact = false }) {
  const [editTitle, setEditTitle] = useState(item.title);
  const [editDescription, setEditDescription] = useState(item.description || '');
  const isPending = item.status === 'pending';
  // The page re-renders on every socket event and on every keystroke in the
  // quick-add input, and a body can be a multi-thousand-word agent prompt —
  // flatten once per description rather than once per render, per card.
  const body = useMemo(() => ({
    preview: markdownToPlainText(item.description),
    lossy: dropsMarkupWhenFlattened(item.description)
  }), [item.description]);

  useEffect(() => {
    if (isEditing) {
      setEditTitle(item.title);
      setEditDescription(item.description || '');
    }
  }, [isEditing, item.title, item.description]);

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border ${compact ? 'border-port-border/60 bg-port-card/40 opacity-70' : 'border-port-border'} ${
      isPending ? 'bg-port-card' : 'bg-port-card/50 opacity-60'
    }`}>
      <div className={`mt-0.5 shrink-0 ${config.color}`}>
        {item.status === 'completed' ? (
          <CheckCircle2 size={18} className="text-port-success" />
        ) : item.status === 'dismissed' ? (
          <XCircle size={18} className="text-gray-500" />
        ) : (
          <config.icon size={18} />
        )}
      </div>

      <div className="flex-1 min-w-0">
        {isEditing ? (
          <div className="space-y-2">
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              aria-label="Title"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-port-accent"
              autoFocus
            />
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              aria-label="Description"
              placeholder="Description (optional)"
              rows={2}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-300 focus:outline-none focus:border-port-accent resize-none"
            />
            <div className="flex gap-2">
              <button onClick={() => onSaveEdit(item.id, editTitle.trim(), editDescription.trim())} aria-label="Save" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-port-success hover:text-port-success/80" title="Save">
                <Check size={16} />
              </button>
              <button onClick={onCancelEdit} aria-label="Cancel" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-white" title="Cancel">
                <X size={16} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {/* Titles clamp to two lines so cards scan as a uniform list.
                    They get a real disclosure rather than a `title` tooltip:
                    an alert title runs to 120 characters and overflows two
                    lines on a phone, where a hover tooltip never fires. */}
                <CollapsibleText
                  id={`review-item-title-${idScope}-${item.id}`}
                  lines={2}
                  text={item.title}
                  className={`text-sm font-medium ${isPending ? 'text-white' : 'text-gray-400 line-through'}`}
                />
                {/* Triage is a scanning task, so the body is a fixed 3-line
                    plain-text preview: the raw markdown for a CoS task prompt
                    or a stack trace runs thousands of words, and rendering it
                    through MarkdownOutput both defeated the clamp (line-clamp
                    doesn't apply across block children) and injected the
                    prompt's own headings into this page's outline. The real
                    markdown renders — height-capped — behind Show more. */}
                {item.description && (
                  <CollapsibleText
                    id={`review-item-body-${idScope}-${item.id}`}
                    lines={3}
                    text={body.preview}
                    className="text-xs text-gray-500 mt-0.5"
                    expandedContent={<MarkdownOutput content={item.description} />}
                    expandedClassName="max-h-80 overflow-y-auto pr-1"
                    // Flattening drops links, images and tables, so a body that
                    // fits in three lines still needs a route to its rendered
                    // form — otherwise a short description holding a scan-report
                    // link becomes permanently inert text. Markup loss only:
                    // a body that merely lost a trailing newline gets no toggle.
                    forceToggle={body.lossy}
                  />
                )}
                {item.metadata?.reportUrl && (
                  <a
                    href={api.normalizeBrainScanReportPath(item.metadata.reportUrl)}
                    className={`mt-2 inline-flex items-center gap-1 text-xs hover:underline ${item.metadata.verdict === 'DANGEROUS' ? 'text-port-error' : 'text-port-accent'}`}
                  >
                    <FileText size={13} />
                    View scan report{item.metadata.verdict ? ` (${item.metadata.verdict})` : ''}
                  </a>
                )}
              </div>
              {isPending && (
                <span className={`text-[10px] uppercase tracking-wide px-2 py-1 rounded-full border border-current/20 ${config.color}`}>
                  {config.label}
                </span>
              )}
            </div>
            <p className="text-xs text-gray-600 mt-2 flex items-center gap-1">
              <Clock3 size={12} />
              {formatDateTime(item.createdAt)}
            </p>
          </>
        )}
      </div>

      {isPending && !isEditing && (
        <div className="flex items-center gap-2 shrink-0">
          {item.type === 'todo' && (
            <button
              onClick={onStartEdit}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-white transition-colors"
              title="Edit" aria-label="Edit"
            >
              <Pencil size={14} />
            </button>
          )}
          {isGenericCompletableItem(item) && (
            <button
              onClick={() => onComplete(item.id)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-success transition-colors"
              title="Complete" aria-label="Complete"
            >
              <CheckCircle2 size={16} />
            </button>
          )}
          <button
            onClick={() => onDismiss(item.id)}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-warning transition-colors"
            title={item.type === 'alert' ? 'Reject' : 'Dismiss'} aria-label={item.type === 'alert' ? 'Reject' : 'Dismiss'}
          >
            <X size={16} />
          </button>
          {isGenericCompletableItem(item) && (
            <button
              onClick={() => onDelete(item.id)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-error transition-colors"
              title="Delete" aria-label="Delete"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const threadDraft = (record) => ({
  title: record?.title || '',
  status: record?.status || 'open',
  priority: record?.priority || 'normal',
  nextAction: record?.nextAction || '',
  dueAt: typeof record?.dueAt === 'string' ? localDateKey(new Date(record.dueAt)) : '',
  notes: record?.notes || '',
});

function ActionDetail({ item, onClose, onResolve, onTriage, triagePending = false, onSaved, onDrill }) {
  const isThread = item?.source === 'threads';
  const isTodo = item?.source === 'todo';
  const [record, setRecord] = useState(item);
  const [draft, setDraft] = useState(() => (isThread ? threadDraft(item) : {
    title: item?.title || '',
    description: item?.summary || '',
  }));

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setRecord(item);
    setDraft(isThread ? threadDraft(item) : {
      title: item.title || '',
      description: item.summary || '',
    });
    if (isThread && item.sourceRef) {
      api.getThread(item.sourceRef, { silent: true })
        .then((full) => {
          if (cancelled) return;
          setRecord(full);
          setDraft(threadDraft(full));
        })
        .catch(() => null);
    }
    return () => { cancelled = true; };
  }, [item?.id, item?.sourceRef, isThread]);

  const [save, saving] = useAsyncAction(async () => {
    if (!item || !draft || (!isThread && !isTodo)) return null;
    const updated = isThread
      ? await api.updateThread(item.sourceRef, {
        title: draft.title.trim(),
        status: draft.status,
        priority: draft.priority,
        nextAction: draft.nextAction.trim(),
        dueAt: draft.dueAt ? new Date(`${draft.dueAt}T00:00:00`).toISOString() : null,
        notes: draft.notes,
      }, { silent: true })
      : await api.updateReviewItem(item.sourceRef, {
        title: draft.title.trim(),
        description: draft.description.trim(),
      }, { silent: true });
    setRecord((previous) => ({ ...previous, ...updated }));
    setDraft(isThread ? threadDraft({ ...record, ...updated }) : {
      title: updated.title || '',
      description: updated.description || '',
    });
    await onSaved?.(updated);
    return updated;
  }, { errorMessage: 'Failed to save action' });

  if (!item) return null;

  const operations = Array.isArray(item.operations)
    ? item.operations.filter((operation) => operation?.available !== false)
    : [];
  const localStatus = item.meta?.localStatus || record?.status || item.meta?.status;
  const externalState = item.meta?.externalState;
  const updateDraft = (patch) => setDraft((previous) => ({ ...previous, ...patch }));
  const resolve = async (operation, input = {}) => {
    const ok = await onResolve(item, operation, input);
    if (ok) onClose();
  };

  return (
    <Drawer
      open
      onClose={onClose}
      title={item.title}
      subtitle={item.sourceLabel}
      size="md"
      closeLabel="Close action"
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm text-gray-300">{item.summary || 'No additional context.'}</p>
          <div className="flex flex-wrap gap-2 text-xs">
            {localStatus && <span className="rounded border border-port-accent/30 px-2 py-1 text-port-accent">Local: {localStatus}</span>}
            {externalState && <span className="rounded border border-port-border px-2 py-1 text-gray-400">External: {externalState}</span>}
            {item.meta?.externalSource && <span className="rounded border border-port-border px-2 py-1 text-gray-400">Source: {item.meta.externalSource}</span>}
          </div>
        </div>

        {(isThread || isTodo) && (
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Edit commitment</h3>
            <label className="block text-xs text-gray-400" htmlFor="action-detail-title">
              Title
              <input
                id="action-detail-title"
                value={draft?.title || ''}
                onChange={(e) => updateDraft({ title: e.target.value })}
                className="mt-1 w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white"
              />
            </label>
            {isThread ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block text-xs text-gray-400" htmlFor="action-detail-status">
                    Local status
                    <select id="action-detail-status" value={draft.status} onChange={(e) => updateDraft({ status: e.target.value })} className="mt-1 w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white">
                      <option value="open">Open</option>
                      <option value="waiting">Waiting</option>
                      <option value="someday">Someday</option>
                      <option value="done">Done</option>
                      <option value="archived">Archived</option>
                    </select>
                  </label>
                  <label className="block text-xs text-gray-400" htmlFor="action-detail-priority">
                    Priority
                    <select id="action-detail-priority" value={draft.priority} onChange={(e) => updateDraft({ priority: e.target.value })} className="mt-1 w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white">
                      <option value="urgent">Urgent</option>
                      <option value="high">High</option>
                      <option value="normal">Normal</option>
                      <option value="low">Low</option>
                    </select>
                  </label>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block text-xs text-gray-400" htmlFor="action-detail-next-action">
                    Next action
                    <input id="action-detail-next-action" value={draft.nextAction} onChange={(e) => updateDraft({ nextAction: e.target.value })} className="mt-1 w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white" />
                  </label>
                  <label className="block text-xs text-gray-400" htmlFor="action-detail-due">
                    Due date
                    <input id="action-detail-due" type="date" value={draft.dueAt} onChange={(e) => updateDraft({ dueAt: e.target.value })} className="mt-1 w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white" />
                  </label>
                </div>
                <label className="block text-xs text-gray-400" htmlFor="action-detail-notes">
                  Notes
                  <textarea id="action-detail-notes" rows={5} value={draft.notes} onChange={(e) => updateDraft({ notes: e.target.value })} className="mt-1 w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white resize-y" />
                </label>
              </>
            ) : (
              <label className="block text-xs text-gray-400" htmlFor="action-detail-description">
                Notes
                <textarea id="action-detail-description" rows={5} value={draft.description} onChange={(e) => updateDraft({ description: e.target.value })} className="mt-1 w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white resize-y" />
              </label>
            )}
            <button type="button" onClick={save} disabled={saving || !draft?.title?.trim()} className="inline-flex items-center gap-2 rounded border border-port-accent/40 px-3 py-2 text-sm text-port-accent hover:bg-port-accent/10 disabled:opacity-50">
              <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
            </button>
          </section>
        )}

        <QueueInvestigation item={item} />
        {item.source === 'health' && <p className="text-sm text-gray-400">Mark resolved after correcting the issue. Earlier runs will no longer count toward run-based alerts; new evidence can raise another alert.</p>}
        {operations.length > 0 && (
          <section className="flex flex-wrap gap-2">
            {operations.map((operation) => (
              operation.input?.type === 'rating'
                ? <FeedbackRatingControls
                    key={operation.id}
                    id={`detail-${item.id}`}
                    options={operation.input.options}
                    onSubmit={(input) => resolve(operation.id, input)}
                  />
                : <button key={operation.id} type="button" onClick={() => resolve(operation.id)} className="inline-flex items-center gap-2 rounded bg-port-success/10 border border-port-success/30 px-3 py-2 text-sm text-port-success hover:bg-port-success/20">
                    <Check size={14} /> {operation.label}
                  </button>
            ))}
          </section>
        )}

        <QueueTriageControls
          item={item}
          onTriage={async (...args) => {
            const ok = await onTriage?.(...args);
            if (ok) onClose();
            return ok;
          }}
          disabled={triagePending}
        />

        {item.drillTo && (
          <button type="button" onClick={() => { onClose(); onDrill(item); }} className="inline-flex items-center gap-2 text-sm text-port-accent hover:underline">
            <ExternalLink size={14} /> Open source editor
          </button>
        )}
      </div>
    </Drawer>
  );
}
