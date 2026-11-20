import { useState, useEffect } from 'react';
import { Check, ExternalLink, Save } from 'lucide-react';
import Drawer from '../Drawer';
import GitHubNotificationCard from '../github/GitHubNotificationCard';
import useAsyncAction from '../../hooks/useAsyncAction';
import { localDateKey } from '../../utils/formatters';
import { getThread, updateThread } from '../../services/apiBrainThreads.js';
import { updateReviewItem } from '../../services/apiReview.js';
import {
  AgentFeedbackReview,
  QueueInvestigation,
  QueueTriageControls,
  isInlineResolution,
  safeExternalHttpUrl,
} from './ActionQueueRow';

const threadDraft = (record) => ({
  title: record?.title || '',
  status: record?.status || 'open',
  priority: record?.priority || 'normal',
  nextAction: record?.nextAction || '',
  dueAt: typeof record?.dueAt === 'string' ? localDateKey(new Date(record.dueAt)) : '',
  notes: record?.notes || '',
});

export default function ActionDetailDrawer({
  item,
  onClose,
  onResolve,
  onTriage,
  triagePending = false,
  onSaved,
  onGitHubUpdated,
  onDrill,
}) {
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
      getThread(item.sourceRef, { silent: true })
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
      ? await updateThread(item.sourceRef, {
        title: draft.title.trim(),
        status: draft.status,
        priority: draft.priority,
        nextAction: draft.nextAction.trim(),
        dueAt: draft.dueAt ? new Date(`${draft.dueAt}T00:00:00`).toISOString() : null,
        notes: draft.notes,
      }, { silent: true })
      : await updateReviewItem(item.sourceRef, {
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
    ? item.operations.filter(isInlineResolution)
    : [];
  const localStatus = item.meta?.localStatus || record?.status || item.meta?.status;
  const externalState = item.meta?.externalState;
  const pullRequestUrl = safeExternalHttpUrl(item.meta?.reviewLoopPRUrl);
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
      size={item.source === 'feedback' ? 'lg' : 'md'}
      closeLabel="Close action"
    >
      <div className="space-y-5">
        {item.source === 'github' && item.githubNotification ? (
          <GitHubNotificationCard
            key={item.id}
            notification={item.githubNotification}
            accountLabel={item.githubNotification.accountLabel}
            onUpdated={(_row, updated) => onGitHubUpdated(item, updated)}
          />
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-gray-300">{item.summary || 'No additional context.'}</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {localStatus && <span className="rounded border border-port-accent/30 px-2 py-1 text-port-accent">Commitment: {localStatus}</span>}
              {item.meta?.taskStatus && <span className={`rounded border px-2 py-1 ${item.meta.taskStatus === 'blocked' ? 'border-port-warning/30 text-port-warning' : 'border-port-border text-gray-400'}`}>Task: {item.meta.taskStatus}</span>}
              {item.meta?.blockedCategory && <span className="rounded border border-port-warning/30 px-2 py-1 text-port-warning">Block: {item.meta.blockedCategory}</span>}
              {externalState && <span className="rounded border border-port-border px-2 py-1 text-gray-400">External: {externalState}</span>}
              {item.meta?.externalSource && <span className="rounded border border-port-border px-2 py-1 text-gray-400">Source: {item.meta.externalSource}</span>}
              {item.meta?.appLabel && <span className="rounded border border-port-border px-2 py-1 text-gray-400">App: {item.meta.appLabel}</span>}
            </div>
            {pullRequestUrl && <a href={pullRequestUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1 text-sm text-port-accent hover:underline"><ExternalLink size={14} /> Open pull request</a>}
          </div>
        )}

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
        {item.source === 'health' && (
          <div className="bg-port-card border border-port-border/60 rounded-lg p-3 text-xs text-gray-400 leading-relaxed">
            Mark resolved after correcting the issue. Earlier runs will no longer count toward run-based alerts; new evidence can raise another alert.
          </div>
        )}
        {item.source === 'feedback' && item.available !== false && item.availability !== 'unavailable' && (
          <AgentFeedbackReview key={item.sourceRef} item={item} onSaved={async () => {
            await onSaved?.();
            onClose();
          }} />
        )}
        {item.source !== 'feedback' && (operations.length > 0 || item.drillTo || item.triageOperations?.length > 0) && (
          <footer className="pt-4 border-t border-port-border space-y-3">
            {operations.length > 0 && (
              <section className="flex flex-wrap gap-2">
                {operations.map((operation) => (
                  <button
                    key={operation.id}
                    type="button"
                    onClick={() => resolve(operation.id)}
                    className="inline-flex items-center gap-2 rounded bg-port-success/10 border border-port-success/30 px-3.5 py-2 text-sm font-medium text-port-success hover:bg-port-success/20 transition-colors"
                  >
                    <Check size={14} /> {operation.label}
                  </button>
                ))}
              </section>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
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
                <button
                  type="button"
                  onClick={() => { onClose(); onDrill(item); }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-port-accent hover:text-port-accent/80 hover:underline py-1.5 px-2.5 rounded border border-port-accent/30 hover:bg-port-accent/10 transition-colors"
                >
                  <ExternalLink size={13} /> {item.drillLabel || (item.source === 'health' ? (item.drillTo?.startsWith('/cos/learning') ? 'Open Learning' : 'View details') : 'Open source')}
                </button>
              )}
            </div>
          </footer>
        )}
      </div>
    </Drawer>
  );
}
