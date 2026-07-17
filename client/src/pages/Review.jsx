import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
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
  DatabaseBackup
} from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import MarkdownOutput from '../components/cos/MarkdownOutput';
import { timeAgo, formatDateTime } from '../utils/formatters';
import { coalesce } from '../utils/coalesce';
import * as api from '../services/api';
import socket from '../services/socket';

// Producer-domain socket events that change what the cross-domain "Needs
// Attention" queue (GET /api/review/queue) would return. The queue is derived
// live from each producer, so when any of these fire — a draft sent, an inbox
// item classified, a CoS task resolved, a backup finishing — we re-pull the
// queue (debounced) instead of waiting for a manual reload. Ask is omitted
// (no socket emit) and proactive alerts are live-computed (no event).
const QUEUE_INVALIDATION_EVENTS = [
  'brain:classified',          // inbox item classified / re-reviewed
  'cos:tasks:user:changed',    // CoS user-task list changed
  'cos:tasks:cos:changed',     // CoS internal-task list changed
  'messages:changed',          // draft approved/deleted/status changed
  'messages:draft:created',    // new draft awaiting review
  'messages:draft:sent',       // draft sent (resolves a drafts row)
  'backup:started',            // backup state transitioning
  'backup:completed',          // backup succeeded (clears a failed-backup row)
  'backup:failed'              // backup errored (surfaces a failed-backup row)
];

// Cross-domain queue source → icon + accent (M42 P5 inbox-zero aggregator).
const QUEUE_SOURCE_CONFIG = {
  brain: { icon: BrainIcon, color: 'text-port-accent-2' },
  ask: { icon: MessageCircle, color: 'text-port-accent' },
  cos: { icon: Crown, color: 'text-port-accent' },
  drafts: { icon: Mail, color: 'text-port-accent' },
  health: { icon: Activity, color: 'text-port-warning' },
  backup: { icon: DatabaseBackup, color: 'text-port-error' }
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

function isActionableItem(item) {
  if (item.type === 'alert' || item.type === 'todo') return true;
  if (item.type === 'cos') {
    return item.metadata?.requiresAction === true || item.metadata?.approvalRequired === true;
  }
  return false;
}

export default function Review() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [briefing, setBriefing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newTodo, setNewTodo] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [briefingFullscreen, setBriefingFullscreen] = useState(false);

  // Cross-domain live queue (M42 P5). These rows are derived live from each
  // producer, not stored, so "dismiss" is a per-session client-side hide rather
  // than a server mutation. Rows whose producer declares an inline action also
  // get a server-backed accept/promote that resolves the underlying record.
  const [queue, setQueue] = useState(null);
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

  const fetchBriefing = useCallback(async () => {
    const data = await api.getReviewBriefing().catch(() => null);
    setBriefing(data);
  }, []);

  const fetchQueue = useCallback(async () => {
    // Owns its own fallback, so silence the helper's default error toast.
    const data = await api.getReviewQueue({ silent: true }).catch(() => null);
    setQueue(data);
  }, []);

  useEffect(() => {
    fetchItems();
    fetchBriefing();
    fetchQueue();
  }, [fetchItems, fetchBriefing, fetchQueue]);

  useEffect(() => {
    const handleCreated = (item) => {
      setItems(prev => {
        if (prev.some(i => i.id === item.id)) return prev;
        return [item, ...prev];
      });
    };
    const handleUpdated = (item) => {
      setItems(prev => prev.map(i => i.id === item.id ? item : i));
    };
    const handleDeleted = (item) => {
      setItems(prev => prev.filter(i => i.id !== item.id));
    };

    socket.on('review:item:created', handleCreated);
    socket.on('review:item:updated', handleUpdated);
    socket.on('review:item:deleted', handleDeleted);

    return () => {
      socket.off('review:item:created', handleCreated);
      socket.off('review:item:updated', handleUpdated);
      socket.off('review:item:deleted', handleDeleted);
    };
  }, []);

  // Live-invalidate the cross-domain queue. A burst of producer events (e.g.
  // a draft sent fires both messages:draft:sent and messages:changed) coalesces
  // into a single refetch on the trailing edge. dismissedQueueIds still filters
  // the result, so a row the user dismissed this session won't pop back; a
  // re-resolved item simply isn't returned by the server anymore.
  useEffect(() => {
    const refetch = coalesce(() => fetchQueue(), 400);
    for (const evt of QUEUE_INVALIDATION_EVENTS) socket.on(evt, refetch);
    return () => {
      for (const evt of QUEUE_INVALIDATION_EVENTS) socket.off(evt, refetch);
      refetch.cancel();
    };
  }, [fetchQueue]);

  const handleCreateTodo = async (e) => {
    e.preventDefault();
    if (!newTodo.trim()) return;
    await api.createReviewTodo({ title: newTodo.trim() }).catch(() => null);
    setNewTodo('');
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

  const handleQueueDismiss = (id) => {
    setDismissedQueueIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const handleQueueDrill = (item) => {
    handleQueueDismiss(item.id);
    if (item.drillTo) navigate(item.drillTo);
  };

  const handleQueueResolve = async (item) => {
    if (resolvingQueueIds.has(item.id)) return;
    setResolvingQueueIds(prev => new Set(prev).add(item.id));
    // The helper toasts on failure (default), so don't add a custom catch toast.
    const ok = await api.resolveReviewQueueItem(item.id).then(() => true).catch(() => false);
    setResolvingQueueIds(prev => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    // Reactive removal — drop the resolved row in place rather than refetching.
    if (ok) handleQueueDismiss(item.id);
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
    // Reactive removal — drop the promoted row in place rather than refetching.
    if (ok) handleQueueDismiss(item.id);
  };

  // Derived review state. Memoized because this page subscribes to
  // review:item:created/updated/deleted socket events and re-renders on each —
  // without memoization every one of these filter/sort passes over `items` reruns
  // on unrelated re-renders (typing, hover state). Hooks must run before the
  // loading early-return, so they live here above it.
  const grouped = useMemo(() => items.reduce((acc, item) => {
    if (!acc[item.type]) acc[item.type] = [];
    acc[item.type].push(item);
    return acc;
  }, {}), [items]);

  const queueItems = useMemo(
    () => (queue?.items || []).filter(i => !dismissedQueueIds.has(i.id)),
    [queue, dismissedQueueIds]);
  const queueSourceErrors = useMemo(
    () => Object.entries(queue?.sources || {}).filter(([, s]) => s.error),
    [queue]);

  const pendingItems = useMemo(() => items.filter(i => i.status === 'pending'), [items]);

  const actionableItems = useMemo(() => pendingItems
    .filter(isActionableItem)
    .sort((a, b) => {
      const priority = TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
      if (priority !== 0) return priority;
      return new Date(b.createdAt) - new Date(a.createdAt);
    }), [pendingItems]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading review hub" />
      </div>
    );
  }

  // Cheap derivations off the memoized `pendingItems`/`actionableItems` — plain
  // consts, not memos: each is O(n) filter or O(8) slice with no consumer that
  // needs referential stability, so a hook here would be pure ceremony.
  const pendingAlerts = pendingItems.filter(i => i.type === 'alert');
  const pendingCos = pendingItems.filter(i => i.type === 'cos');
  const pendingTodos = pendingItems.filter(i => i.type === 'todo');
  const topActionItems = actionableItems.slice(0, 8);

  const pendingCount = pendingItems.length;
  const remainingActionCount = Math.max(0, actionableItems.length - topActionItems.length);

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="space-y-3">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ClipboardList size={20} />
            Review Hub
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <select
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
                <button
                  onClick={handleCompleteAll}
                  className="px-3 py-2 text-sm bg-port-success/10 hover:bg-port-success/20 border border-port-success/30 rounded-lg text-port-success transition-colors"
                  title="Mark all pending items as completed"
                >
                  Complete All
                </button>
                <button
                  onClick={handleMarkAllRead}
                  className="px-3 py-2 text-sm bg-port-border/50 hover:bg-port-border rounded-lg text-gray-300 transition-colors"
                  title="Dismiss all pending items"
                >
                  Dismiss All
                </button>
              </>
            )}
          </div>
        </div>

        {/* Triage summary */}
        <section className="flex flex-wrap gap-2">
          <SummaryPill icon={BellRing} label="Pending" value={pendingCount} tone="text-white" />
          <SummaryPill icon={AlertTriangle} label="Alerts" value={pendingAlerts.length} tone="text-port-warning" urgent={pendingAlerts.length > 0} />
          <SummaryPill icon={Crown} label="CoS" value={pendingCos.length} tone="text-port-accent" />
          <SummaryPill icon={ClipboardList} label="Todos" value={pendingTodos.length} tone="text-port-success" />
        </section>

        {/* Cross-domain "Needs Attention" queue (M42 P5) — live-pulled from
            Brain, Ask, CoS, Messages, Health, and Backups. Shown whenever there
            are items OR a source failed to load (so the degraded-source notice
            isn't hidden behind an otherwise-empty queue). */}
        {(queueItems.length > 0 || queueSourceErrors.length > 0) && (
          <section className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Inbox size={16} className="text-port-accent" />
                Needs Attention
              </h3>
              {queueItems.length > 0 && (
                <span className="text-xs rounded-full px-2 py-0.5 bg-port-accent/10 text-port-accent border border-port-accent/20">
                  {queueItems.length} across domains
                </span>
              )}
            </div>
            {queueItems.length > 0 && (
              <div className="space-y-2">
                {queueItems.map(item => (
                  <QueueRow
                    key={item.id}
                    item={item}
                    onDrill={handleQueueDrill}
                    onDismiss={handleQueueDismiss}
                    onResolve={handleQueueResolve}
                    onPromoteAsk={handleQueuePromoteAsk}
                    resolving={resolvingQueueIds.has(item.id)}
                  />
                ))}
              </div>
            )}
            {queueSourceErrors.length > 0 && (
              <p className="text-xs text-gray-600">
                Couldn&apos;t load: {queueSourceErrors.map(([, s]) => s.label).join(', ')}.
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
            placeholder="Quick add todo..."
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

        {/* Action queue — only shown when there are actionable items */}
        {topActionItems.length > 0 && (
          <section className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Eye size={16} className="text-port-warning" />
                Action Queue
              </h3>
              <span className="text-xs rounded-full px-2 py-0.5 bg-port-warning/10 text-port-warning border border-port-warning/20">
                {actionableItems.length} actionable
              </span>
            </div>
            <div className="space-y-2">
              {topActionItems.map(item => (
                <ReviewItem
                  key={item.id}
                  item={item}
                  config={TYPE_CONFIG[item.type]}
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
                {remainingActionCount} more actionable item{remainingActionCount !== 1 ? 's' : ''} below.
              </p>
            )}
          </section>
        )}

        {/* Daily Briefing */}
        {briefing && briefing.source !== 'none' && (
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
                  className="p-1 text-gray-500 hover:text-white transition-colors rounded-md hover:bg-white/5"
                  title={briefingFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
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
                <span className="text-gray-600">({typeItems.length})</span>
              </h3>
              <div className="space-y-1">
                {typeItems.map(item => (
                  <ReviewItem
                    key={item.id}
                    item={item}
                    config={config}
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
        </div>

        {items.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
            <p className="text-lg">No review items yet</p>
            <p className="text-sm mt-1">This hub will fill up as agents surface alerts, actions, and briefing context.</p>
          </div>
        )}
      </div>
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
        {meta.turnCount} turn{meta.turnCount === 1 ? '' : 's'}
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
  if (!chips.length) return null;
  return <div className="flex items-center gap-1.5 flex-wrap mt-1">{chips}</div>;
}

// Promote-target label for the Ask picker buttons.
const PROMOTE_TARGET_LABEL = { brain: 'Brain', task: 'Task', goal: 'Goal' };

function QueueRow({ item, onDrill, onDismiss, onResolve, onPromoteAsk, resolving = false }) {
  const config = QUEUE_SOURCE_CONFIG[item.source] || { icon: Inbox, color: 'text-gray-400' };
  const Icon = config.icon;
  const borderTone = QUEUE_SEVERITY_STYLE[item.severity] || QUEUE_SEVERITY_STYLE.normal;
  const promoteTargets = Array.isArray(item.promoteTargets) ? item.promoteTargets : [];
  const goalOptions = Array.isArray(item.goalOptions) ? item.goalOptions : [];
  // The goal target needs a goalId, so it's rendered as a picker rather than a
  // one-click button — split it out from the simple brain/task targets.
  const simpleTargets = promoteTargets.filter(t => t !== 'goal');
  const showGoalPicker = promoteTargets.includes('goal') && goalOptions.length > 0;

  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg border bg-port-card ${borderTone}`}>
      <div className={`mt-0.5 shrink-0 ${config.color}`}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-white">{item.title}</p>
          <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-current/20 ${config.color}`}>
            {item.sourceLabel}
          </span>
        </div>
        {item.summary && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{item.summary}</p>
        )}
        <QueueMetaChips meta={item.meta} />
        {item.timestamp && (
          <p className="text-xs text-gray-600 mt-1 flex items-center gap-1">
            <Clock3 size={12} />
            {timeAgo(item.timestamp)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
        {item.action && onResolve && (
          <button
            onClick={() => onResolve(item)}
            disabled={resolving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-port-success bg-port-success/10 hover:bg-port-success/20 border border-port-success/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={`${item.action} this item in place`}
          >
            <Check size={14} />
            {item.action}
          </button>
        )}
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
              className="px-2 py-1 rounded-md text-xs font-medium text-port-accent bg-port-accent/10 hover:bg-port-accent/20 border border-port-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none"
              title="Promote the latest answer into a goal's progress"
            >
              <option value="">→ Goal…</option>
              {goalOptions.map(g => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </label>
        )}
        <button
          onClick={() => onDrill(item)}
          className="p-1.5 text-gray-500 hover:text-port-accent transition-colors"
          title="Open"
        >
          <ArrowRight size={16} />
        </button>
        <button
          onClick={() => onDismiss(item.id)}
          className="p-1.5 text-gray-500 hover:text-port-warning transition-colors"
          title="Dismiss from queue (this session)"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

function SummaryPill({ icon: Icon, label, value, tone = 'text-white', urgent = false }) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 bg-port-card ${urgent ? 'border-port-warning/40' : 'border-port-border'}`}>
      <Icon size={14} className={urgent ? 'text-port-warning' : tone} />
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm font-bold ${tone}`}>{value}</span>
    </div>
  );
}

function ReviewItem({ item, config, isEditing, onComplete, onDismiss, onDelete, onStartEdit, onSaveEdit, onCancelEdit, compact = false }) {
  const [editTitle, setEditTitle] = useState(item.title);
  const [editDescription, setEditDescription] = useState(item.description || '');
  const isPending = item.status === 'pending';

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
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-port-accent"
              autoFocus
            />
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="Description (optional)"
              rows={2}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-300 focus:outline-none focus:border-port-accent resize-none"
            />
            <div className="flex gap-1">
              <button onClick={() => onSaveEdit(item.id, editTitle.trim(), editDescription.trim())} aria-label="Save" className="p-1 text-port-success hover:text-port-success/80" title="Save">
                <Check size={16} />
              </button>
              <button onClick={onCancelEdit} aria-label="Cancel" className="p-1 text-gray-500 hover:text-white" title="Cancel">
                <X size={16} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`text-sm font-medium ${isPending ? 'text-white' : 'text-gray-400 line-through'}`}>
                  {item.title}
                </p>
                {item.description && (
                  <div className="text-xs text-gray-500 mt-0.5 line-clamp-3">
                    <MarkdownOutput content={item.description} />
                  </div>
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
        <div className="flex items-center gap-1 shrink-0">
          {item.type === 'todo' && (
            <button
              onClick={onStartEdit}
              className="p-1.5 text-gray-500 hover:text-white transition-colors"
              title="Edit"
            >
              <Pencil size={14} />
            </button>
          )}
          <button
            onClick={() => onComplete(item.id)}
            className="p-1.5 text-gray-500 hover:text-port-success transition-colors"
            title={item.type === 'alert' ? 'Accept' : 'Complete'}
          >
            <CheckCircle2 size={16} />
          </button>
          <button
            onClick={() => onDismiss(item.id)}
            className="p-1.5 text-gray-500 hover:text-port-warning transition-colors"
            title={item.type === 'alert' ? 'Reject' : 'Dismiss'}
          >
            <X size={16} />
          </button>
          <button
            onClick={() => onDelete(item.id)}
            className="p-1.5 text-gray-500 hover:text-port-error transition-colors"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
