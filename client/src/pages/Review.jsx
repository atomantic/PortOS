import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ClipboardList,
  Plus,
  Clock3,
  Inbox,
  CalendarDays,
  ListTodo,
  Hourglass,
  Sparkles,
  History as HistoryIcon
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import RuntimeInstallModal from '../components/install/RuntimeInstallModal';
import ActionQueueRow from '../components/review/ActionQueueRow';
import ActionDetailDrawer from '../components/review/ActionDetailDrawer';
import LegacyReviewSection, { ReviewHistoryDisclosure } from '../components/review/LegacyReviewSection';
import TabPills from '../components/ui/TabPills';
import useUrlParams from '../hooks/useUrlParams';
import { formatCount } from '../utils/formatters';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';
import { useActionQueue } from '../hooks/useActionQueue';
import {
  getReviewItems,
  getReviewCounts,
  getReviewBriefing,
  resolveReviewQueueItem,
  triageReviewQueueItem,
  promoteAskReviewQueueItem,
} from '../services/apiReview.js';
import { createThread } from '../services/apiBrainThreads.js';
import { useSocketResource } from '../hooks/useSocketResource';
import { useSingleFlight } from '../hooks/useSingleFlight';

const HARNESS_WARNING_KEY = 'portos-harness-release-warning-days';
const WARNING_DAYS = [0, 1, 3, 7];

const ACTION_VIEWS = [
  { id: 'today', label: 'Today', icon: CalendarDays },
  { id: 'all', label: 'All', icon: ListTodo },
  { id: 'waiting', label: 'Waiting', icon: Hourglass },
  { id: 'someday', label: 'Someday', icon: Sparkles },
  { id: 'snoozed', label: 'Snoozed', icon: Clock3 },
  { id: 'history', label: 'History', icon: HistoryIcon },
];
const ACTION_VIEW_IDS = new Set(ACTION_VIEWS.map(({ id }) => id));

const queueItemKey = (itemOrId) => {
  if (itemOrId && typeof itemOrId === 'object') {
    return JSON.stringify([itemOrId.id || '', itemOrId.occurrence ?? '', itemOrId.revision ?? '']);
  }
  return JSON.stringify([itemOrId || '', '', '']);
};

const REVIEW_ITEM_EVENTS = ['review:item:created', 'review:item:updated', 'review:item:deleted', 'review:items:bulk-updated'];
const REVIEW_HISTORY_PAGE_SIZE = 50;
const EMPTY_ITEMS = [];

export default function Review() {
  const navigate = useNavigate();
  const { actionId } = useParams();
  const [searchParams, updateParams] = useUrlParams();
  const requestedActionView = searchParams.get('view');
  const actionView = ACTION_VIEW_IDS.has(requestedActionView) ? requestedActionView : 'today';
  const [briefing, setBriefing] = useState(null);
  const [newTodo, setNewTodo] = useState('');
  const [filter, setFilter] = useState('pending');
  const [offset, setOffset] = useState(0);

  // Cross-domain live queue (M42 P5). Source payloads remain live projections;
  // presentation decisions are durable server-side markers keyed by the row's
  // canonical action identity, occurrence, and revision.
  const { data: queue, error: queueError, loading: queueLoading, refetch: fetchQueue } = useActionQueue(actionView);
  const [dismissedQueueIds, setDismissedQueueIds] = useState(() => new Set());
  // Rows with an inline accept/promote in flight — disables the button so a
  // double-tap can't double-resolve while the request is pending.
  const [resolvingQueueIds, setResolvingQueueIds] = useState(() => new Set());
  const [pendingHarnessUpdate, setPendingHarnessUpdate] = useState(null);
  const [harnessWarningDays, setHarnessWarningDays] = useState(() => {
    const stored = Number(safeReadStorage(HARNESS_WARNING_KEY));
    return WARNING_DAYS.includes(stored) ? stored : 0;
  });
  const saveHarnessWarningDays = (days) => {
    if (!WARNING_DAYS.includes(days)) return;
    setHarnessWarningDays(days);
    safeWriteStorage(HARNESS_WARNING_KEY, String(days));
  };

  const queueItems = useMemo(
    () => (queue?.items || []).filter(i => !dismissedQueueIds.has(queueItemKey(i))),
    [queue, dismissedQueueIds]);
  const queueSourceErrors = useMemo(
    () => Object.entries(queue?.sources || {}).filter(([, s]) => s.error),
    [queue]);
  const queueSourceIncomplete = useMemo(
    () => Object.entries(queue?.sources || {}).filter(([, s]) => s.incomplete),
    [queue]);
  const selectedAction = useMemo(
    () => (queue?.items || []).find((item) => item.id === actionId) || null,
    [queue, actionId]);
  // Keep old stored Review records rendered only as a compatibility fallback
  // while the live Actions projection is empty. Once a canonical row exists,
  // rendering the old lists as well would show the same obligation twice.
  const showLegacyReviewSurface = queue && !queueError && queueItems.length === 0 && queueSourceErrors.length === 0 && !queue.partial;

  const paged = filter !== 'pending';
  const history = useSocketResource(
    ({ signal }) => getReviewItems({
      ...(filter === 'all' ? {} : { status: filter }),
      limit: REVIEW_HISTORY_PAGE_SIZE,
      offset,
    }, { silent: true, signal }),
    { events: REVIEW_ITEM_EVENTS, resourceKey: `${filter}:${offset}`, enabled: Boolean(showLegacyReviewSurface && paged) }
  );
  // The All list is paged, but triage and bulk actions still cover every pending row.
  const pending = useSocketResource(
    ({ signal }) => getReviewItems({ status: 'pending' }, { silent: true, signal }),
    { events: REVIEW_ITEM_EVENTS, enabled: Boolean(showLegacyReviewSurface && (!paged || filter === 'all')) }
  );
  const list = paged ? history : pending;
  const page = paged ? history.data : null;
  const items = (paged ? page?.items : pending.data) ?? EMPTY_ITEMS;
  const pendingItems = (!paged || filter === 'all' ? pending.data : null) ?? EMPTY_ITEMS;
  const { data: counts } = useSocketResource(() => getReviewCounts({ silent: true }), { events: REVIEW_ITEM_EVENTS });

  useEffect(() => {
    getReviewBriefing().catch(() => null).then(setBriefing);
  }, []);

  const handleCreateTodo = useSingleFlight(async (e) => {
    e.preventDefault();
    if (!newTodo.trim()) return;
    // Failure toasts via the shared request wrapper; keep the typed text so it can be retried.
    const thread = await createThread({ title: newTodo.trim() }).catch(() => null);
    if (!thread) return;
    setNewTodo('');
    await fetchQueue();
    if (thread.id) {
      const threadView = actionView === 'all' || actionView === 'today' ? actionView : 'today';
      navigate(`/review/${encodeURIComponent(`threads:${thread.id}`)}?view=${threadView}`);
    }
  }, () => newTodo.trim());

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

  const handleGitHubUpdated = (item, notification) => {
    const handled = notification.state !== 'open' || !notification.unread || notification.readOnGithub;
    if (handled) handleQueueDismiss(item);
    if ((notification.mutedInPortOS || handled) && actionId === item.id) {
      navigate(`/review?view=${actionView}`, { replace: true });
    }
    void fetchQueue();
  };

  const handleQueueResolve = async (item, operation, input = {}) => {
    if (resolvingQueueIds.has(item.id)) return;
    setResolvingQueueIds(prev => new Set(prev).add(item.id));
    // The helper toasts on failure (default), so don't add a custom catch toast.
    const ok = await resolveReviewQueueItem(
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
    const ok = await triageReviewQueueItem(item.id, { operation, ...input })
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
    const ok = await promoteAskReviewQueueItem(item.id, target, goalId ? { goalId } : {}).then(() => true).catch(() => false);
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

  const loadedPendingCount = useMemo(() => pendingItems.filter(item => item.status === 'pending').length, [pendingItems]);
  const pendingCount = counts?.total ?? loadedPendingCount;

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={ClipboardList}
        iconColor="text-white"
        title="Actions"
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
        <div role="tabpanel" id={`actions-view-${actionView}`} aria-labelledby={`tab-${actionView}`} className="space-y-3">
          {/* Triage summary */}
          <section className="flex flex-wrap gap-2">
            {queue && showLegacyReviewSurface && (
              <span className="text-sm text-port-text">
                <span className="font-medium text-port-success">Nothing needs you today</span>
                {' · '}0 required
                {pendingCount > 0 && <> · {formatCount(pendingCount)} stored item{pendingCount !== 1 ? 's' : ''} still pending</>}
              </span>
            )}
            {queue && !showLegacyReviewSurface && <span className="text-sm text-port-text">{queue.partial || queueError ? 'At least ' : ''}{formatCount(queueItems.filter(item => item.required === true).length)} required</span>}
            {queueLoading && !queue && <span role="status">Loading actions…</span>}
            {queueError && <span role="alert">Actions unavailable{queue ? ' — showing last known actions' : ''}. <button onClick={fetchQueue}>Retry</button></span>}
          </section>
          {!showLegacyReviewSurface && <ReviewHistoryDisclosure briefing={briefing} counts={counts} showBriefing={false} />}

          {/* Canonical Actions queue — live-pulled from Brain commitments, manual
              todos, Ask, CoS, GitHub, Messages, Health, and Backups. Shown whenever there
              are items OR a source failed to load (so the degraded-source notice
              isn't hidden behind an otherwise-empty queue). */}
          {(queueItems.length > 0 || queueSourceErrors.length > 0 || queue?.partial) && (
            <section className="@container/page bg-port-card border border-port-border rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Inbox size={16} className="text-port-accent" />
                  Actions
                </h2>
                {queueItems.length > 0 && (
                  <span className="text-xs rounded-full px-2 py-0.5 bg-port-accent/10 text-port-accent border border-port-accent/20">
                    {formatCount(queueItems.length)} across domains
                  </span>
                )}
              </div>
              {queueItems.length > 0 && (
                <div className="space-y-2">
                  {queueItems.map(item => (
                    <ActionQueueRow
                      key={item.id}
                      item={item}
                      onSelect={handleQueueSelect}
                      onDrill={handleQueueDrill}
                      onResolve={handleQueueResolve}
                      onPromoteAsk={handleQueuePromoteAsk}
                      onTriage={handleQueueTriage}
                      onFeedbackSaved={fetchQueue}
                      onGitHubUpdated={handleGitHubUpdated}
                      onHarnessUpdate={setPendingHarnessUpdate}
                      harnessUpdatePending={Boolean(pendingHarnessUpdate)}
                      harnessWarningDays={harnessWarningDays}
                      onHarnessWarningDays={saveHarnessWarningDays}
                      actionLink={`/review/${encodeURIComponent(item.id)}?view=${actionView}`}
                      detailOpen={item.id === actionId}
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
              {queueSourceIncomplete.length > 0 && (
                <p role="status" className="text-xs text-gray-500">
                  Some checks for {queueSourceIncomplete.map(([, s]) => s.label).join(', ')} are unverified; automatic checks will retry.
                </p>
              )}
              {queue?.partial && (queueSourceIncomplete.length === 0 || Object.values(queue.sources || {}).some(source => source.truncation)) && (
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
          {showLegacyReviewSurface && (
            <LegacyReviewSection
              items={items}
              counts={counts}
              briefing={briefing}
              filter={filter}
              onFilterChange={(status) => {
                setFilter(status);
                setOffset(0);
              }}
              pendingItems={pendingItems}
              page={page}
              onPageChange={setOffset}
              loading={list.loading}
              error={list.error}
              onRetry={list.refetch}
              pendingError={filter === 'all' ? pending.error : null}
              onRetryPending={pending.refetch}
            />
          )}
        </div>
      </div>
      <ActionDetailDrawer
        item={selectedAction}
        onClose={() => navigate(`/review?view=${actionView}`, { replace: true })}
        onResolve={handleQueueResolve}
        onTriage={handleQueueTriage}
        triagePending={Boolean(actionId && resolvingQueueIds.has(actionId))}
        onSaved={fetchQueue}
        onGitHubUpdated={handleGitHubUpdated}
        onDrill={handleQueueDrill}
      />
      <RuntimeInstallModal
        open={Boolean(pendingHarnessUpdate)}
        runtime={pendingHarnessUpdate?.id}
        label={pendingHarnessUpdate?.label}
        title={`Updating ${pendingHarnessUpdate?.label || 'harness'}`}
        description="Running the harness updater."
        doneText="The updater finished."
        installUrlBase="/api/harnesses/review-update"
        params={pendingHarnessUpdate ? {
          expectedVersion: pendingHarnessUpdate.installedVersion,
          candidateVersion: pendingHarnessUpdate.candidateVersion,
          ticket: pendingHarnessUpdate.ticket,
        } : undefined}
        streamMethod="POST"
        onClose={() => setPendingHarnessUpdate(null)}
        onComplete={() => { void fetchQueue(); }}
      />
    </div>
  );
}
