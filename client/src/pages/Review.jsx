import { useState, useEffect, useCallback } from 'react';
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
  BellRing
} from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';
import MarkdownOutput from '../components/cos/MarkdownOutput';
import * as api from '../services/api';
import socket from '../services/socket';

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
  const [items, setItems] = useState([]);
  const [briefing, setBriefing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newTodo, setNewTodo] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [filter, setFilter] = useState('pending');
  const [briefingFullscreen, setBriefingFullscreen] = useState(false);

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

  useEffect(() => {
    fetchItems();
    fetchBriefing();
  }, [fetchItems, fetchBriefing]);

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

  const handleMarkAllRead = async () => {
    const pendingItems = items.filter(i => i.status === 'pending');
    await Promise.all(pendingItems.map(i => api.dismissReviewItem(i.id).catch(() => null)));
  };

  const grouped = items.reduce((acc, item) => {
    if (!acc[item.type]) acc[item.type] = [];
    acc[item.type].push(item);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading review hub" />
      </div>
    );
  }

  const pendingItems = items.filter(i => i.status === 'pending');
  const pendingCount = pendingItems.length;
  const pendingAlerts = pendingItems.filter(i => i.type === 'alert');
  const pendingCos = pendingItems.filter(i => i.type === 'cos');
  const pendingTodos = pendingItems.filter(i => i.type === 'todo');

  const actionableItems = pendingItems
    .filter(isActionableItem)
    .sort((a, b) => {
      const priority = TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
      if (priority !== 0) return priority;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

  const topActionItems = actionableItems.slice(0, 8);
  const remainingActionCount = Math.max(0, actionableItems.length - topActionItems.length);

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="max-w-6xl mx-auto space-y-3">
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
              <button
                onClick={handleMarkAllRead}
                className="px-3 py-2 text-sm bg-port-border/50 hover:bg-port-border rounded-lg text-gray-300 transition-colors"
              >
                Mark All Read
              </button>
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
                  {briefing.source} &middot; {new Date(briefing.generatedAt).toLocaleString()}
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

        {/* Detailed sections */}
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
              <button onClick={() => onSaveEdit(item.id, editTitle.trim(), editDescription.trim())} className="p-1 text-port-success hover:text-port-success/80" title="Save">
                <Check size={16} />
              </button>
              <button onClick={onCancelEdit} className="p-1 text-gray-500 hover:text-white" title="Cancel">
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
              {new Date(item.createdAt).toLocaleString()}
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
