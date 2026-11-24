import { useState, useEffect, useMemo } from 'react';
import {
  ClipboardList,
  AlertTriangle,
  CheckCircle2,
  X,
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
import CollapsibleText from '../ui/CollapsibleText';
import MarkdownOutput from '../cos/MarkdownOutput';
import Modal from '../ui/Modal';
import { formatDateTime, formatCount, formatDateShort } from '../../utils/formatters';
import { markdownToPlainText, dropsMarkupWhenFlattened } from '../../utils/markdownText';
import { normalizeBrainScanReportPath } from '../../services/apiBrain.js';
import {
  completeReviewItem,
  dismissReviewItem,
  deleteReviewItem,
  updateReviewItem,
  bulkUpdateReviewStatus,
} from '../../services/apiReview.js';

const TYPE_CONFIG = {
  alert: { label: 'Alerts', icon: AlertTriangle, color: 'text-port-warning' },
  cos: { label: 'CoS Actions', icon: Crown, color: 'text-port-accent' },
  todo: { label: 'Todos', icon: ClipboardList, color: 'text-port-success' },
  briefing: { label: 'Briefing', icon: FileText, color: 'text-gray-400' }
};

// A briefing generated within a day is news; older ones are history context.
const BRIEFING_FRESH_MS = 24 * 60 * 60 * 1000;

const TYPE_PRIORITY = { alert: 0, cos: 1, todo: 2, briefing: 3 };

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
                    href={normalizeBrainScanReportPath(item.metadata.reportUrl)}
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

// One named disclosure for history: stored counts plus the daily briefing. A
// briefing older than a day is context, not news, so it starts closed.
export function ReviewHistoryDisclosure({ briefing, counts, showBriefing }) {
  const [briefingFullscreen, setBriefingFullscreen] = useState(false);
  // A CoS briefing is dated by calendar day, which has no time to show and starts at local midnight.
  const briefingIsDayOnly = Boolean(showBriefing) && /^\d{4}-\d{2}-\d{2}$/.test(briefing.generatedAt);
  const briefingStart = showBriefing && new Date(briefingIsDayOnly ? `${briefing.generatedAt}T00:00:00` : briefing.generatedAt);
  const briefingIsFresh = Boolean(showBriefing) && Date.now() - briefingStart.getTime() < BRIEFING_FRESH_MS;
  const historySummary = showBriefing
    ? `Daily briefing · ${formatDateShort(briefing.generatedAt)} · history counts`
    : 'Stored review history counts';

  const renderBriefing = (fullscreen) => (
    <section
      className={`bg-port-card border border-port-border rounded-xl p-4 ${fullscreen ? 'h-full overflow-y-auto m-0 rounded-none' : 'mt-2'}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-sm font-semibold text-white flex items-center gap-2">
          <FileText size={16} className="text-gray-400" />
          Daily Briefing
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-400">
            {briefing.source} &middot; {briefingIsDayOnly ? formatDateShort(briefing.generatedAt) : formatDateTime(briefing.generatedAt)}
          </span>
          <button
            onClick={() => setBriefingFullscreen(prev => !prev)}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-500 hover:text-white transition-colors rounded-md hover:bg-white/5"
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
      </div>
      <div className={`text-gray-400 text-sm overflow-y-auto ${fullscreen ? '' : 'max-h-[32rem]'}`}>
        <MarkdownOutput content={briefing.content} />
      </div>
    </section>
  );

  return (
    <details open={briefingIsFresh}>
      <summary className="text-xs text-port-text-muted">{historySummary}</summary>
      <section className="flex flex-wrap gap-2 mt-2">
        <SummaryPill icon={BellRing} label="Pending" value={counts?.total ?? 0} tone="text-white" />
        <SummaryPill icon={AlertTriangle} label="Alerts" value={counts?.alert ?? 0} tone="text-port-warning" urgent={(counts?.alert ?? 0) > 0} />
        <SummaryPill icon={Crown} label="CoS" value={counts?.cos ?? 0} tone="text-port-accent" />
        <SummaryPill icon={ClipboardList} label="Todos" value={counts?.todo ?? 0} tone="text-port-success" />
      </section>
      {/* Stays mounted (hidden) in fullscreen so the Modal can return focus to this toggle. */}
      {showBriefing && <div hidden={briefingFullscreen}>{renderBriefing(false)}</div>}
      {/* Fullscreen is a <Modal>: portaled to <body>, focus-trapped, Esc-layered. */}
      <Modal
        open={showBriefing && briefingFullscreen}
        onClose={() => setBriefingFullscreen(false)}
        usePortal
        size="none"
        align="none"
        backdropClassName="bg-port-bg"
        panelClassName="w-full h-dvh"
        ariaLabel="Daily Briefing"
      >
        {showBriefing && renderBriefing(true)}
      </Modal>
    </details>
  );
}

export default function LegacyReviewSection({
  items,
  counts,
  briefing,
  filter,
  onFilterChange,
  loading,
  error,
  onRetry,
}) {
  const [editingId, setEditingId] = useState(null);

  const handleComplete = async (id) => {
    await completeReviewItem(id).catch(() => null);
  };

  const handleDismiss = async (id) => {
    await dismissReviewItem(id).catch(() => null);
  };

  const handleDelete = async (id) => {
    await deleteReviewItem(id).catch(() => null);
  };

  const handleSaveEdit = async (id, title, description) => {
    await updateReviewItem(id, { title, description }).catch(() => null);
    setEditingId(null);
  };

  const handleMarkAllRead = () => bulkUpdateReviewStatus({ status: 'dismissed' }).catch(() => null);
  const handleCompleteAll = () => bulkUpdateReviewStatus({ status: 'completed' }).catch(() => null);

  // Derived review state. Memoized because the parent page subscribes to
  // review:item:created/updated/deleted socket events and re-renders on each —
  // without memoization every one of these filter/sort passes over `items` reruns
  // on unrelated re-renders (typing, hover state).
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

  const pendingItems = useMemo(() => items.filter(i => i.status === 'pending'), [items]);
  const showBriefing = Boolean(briefing && briefing.source !== 'none');
  const genericCompletableCount = pendingItems.filter(isGenericCompletableItem).length;

  const actionableItems = useMemo(() => pendingItems
    .filter(isActionableItem)
    .sort((a, b) => {
      const priority = TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type];
      if (priority !== 0) return priority;
      return new Date(b.createdAt) - new Date(a.createdAt);
    }), [pendingItems]);

  // Cheap derivations off the memoized `pendingItems`/`actionableItems` — plain
  // consts, not memos: the action list is an O(8) slice with no consumer that
  // needs referential stability, so a hook here would be pure ceremony.
  const topActionItems = actionableItems.slice(0, 8);
  const pendingCount = pendingItems.length;
  const remainingActionCount = Math.max(0, actionableItems.length - topActionItems.length);

  return (
    <>
      <section aria-labelledby="stored-review-items-heading" className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="stored-review-items-heading" className="text-sm font-semibold text-white">Stored review items</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter review items by status"
              value={filter}
              onChange={(e) => onFilterChange(e.target.value)}
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
                    title={`Mark ${genericCompletableCount} general pending item${genericCompletableCount !== 1 ? 's' : ''} as completed`}
                  >
                    Complete all {formatCount(genericCompletableCount)}
                  </button>
                )}
                <button
                  onClick={handleMarkAllRead}
                  className="px-3 py-2 text-sm bg-port-border/50 hover:bg-port-border rounded-lg text-gray-300 transition-colors"
                  title={`Dismiss ${pendingCount} pending item${pendingCount !== 1 ? 's' : ''}`}
                >
                  Dismiss all {formatCount(pendingCount)} pending
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      {topActionItems.length > 0 && (
        <section className="bg-port-card border border-port-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <Eye size={16} className="text-port-warning" />
              Action Queue
            </h2>
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

      {loading && (
        <p role="status" className="text-sm text-port-text-muted">Loading stored review items…</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-port-warning">
          Stored review items are unavailable. <button onClick={onRetry} className="underline">Retry</button>
        </p>
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
              <h2 className={`text-sm font-semibold uppercase tracking-wide ${config.color} flex items-center gap-2`}>
                <TypeIcon size={16} />
                {config.label}
                <span className="text-gray-600">({formatCount(typeItems.length)})</span>
              </h2>
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
      </div>

      {!loading && !error && visibleItems.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <ClipboardList size={48} className="mx-auto mb-3 opacity-30" />
          <p className="text-lg">No review items in this view</p>
          <p className="text-sm mt-1">This hub will fill up as agents surface alerts, actions, and briefing context.</p>
        </div>
      )}

      {/* Rendered below stored items on the all-clear surface so pending work leads. */}
      <ReviewHistoryDisclosure briefing={briefing} counts={counts} showBriefing={showBriefing} />
    </>
  );
}
