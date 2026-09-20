// Brain > Threads — the bullet journal's open loops (#7664).
//
// A *thread* is one tracked topic or commitment: a status, a next action, and
// refs to the PortOS records and external items that belong to it. It is NOT a
// message thread (messages/ owns that sense of the word).
//
// Everything selectable lives in the URL (client/src/AGENTS.md): the filters
// (`?status=`, `?tag=`, `?q=`), the open record (`?thread=<id>`) and the
// drawer's section (`?threadTab=`), so the dashboard widget, unified search and
// a shared link all land on the same drawer. Full-bleed: this tab owns its own
// scroll region like the Daily Log.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, Link2, ListTodo, Pin, Plus, Search, Trash2, X } from 'lucide-react';
import useUrlParams from '../../../hooks/useUrlParams';
import useDrawerTab from '../../../hooks/useDrawerTab';
import useAsyncAction from '../../../hooks/useAsyncAction';
import * as api from '../../../services/api';
import Drawer from '../../Drawer';
import Pill from '../../ui/Pill';
import TabPills from '../../ui/TabPills';
import { FormField } from '../../ui/FormField';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import toast from '../../ui/Toast';
import ThreadRefChip from '../ThreadRefChip';
import ThreadSourceClosedAction from '../ThreadSourceClosedAction';
import { THREAD_REF_KIND_IDS, threadRefLabel } from '../../../lib/threadRefKinds.js';
import {
  THREAD_STATUSES, THREAD_PRIORITIES, THREAD_ACTIVE_STATUSES,
  isTerminalThreadStatus, isThreadOverdue, threadNextLine, compareThreads,
} from '../../../lib/brainThreads.js';
import { tagsToArray, tagsToInput } from '../../../lib/tribe.js';
import { formatCount, formatDateShort, localDateKey } from '../../../utils/formatters';

// `?status=` views. `all` is the working set — every non-terminal thread,
// grouped — and the only view that groups; a single status is one flat list.
const STATUS_LABELS = { open: 'Open', waiting: 'Waiting', someday: 'Someday', done: 'Done', archived: 'Archived' };
const STATUS_VIEWS = [
  { id: 'all', label: 'Open loops' },
  ...THREAD_STATUSES.map((id) => ({ id, label: STATUS_LABELS[id] })),
];
const STATUS_IDS = STATUS_VIEWS.map((v) => v.id);
const WORKING_SET = THREAD_ACTIVE_STATUSES.join(',');

const PRIORITY_TONE = { urgent: 'error', high: 'warning', low: 'note' };
const SEARCH_DEBOUNCE_MS = 300;

const DRAWER_TABS = [
  { id: 'details', label: 'Details', icon: Info },
  { id: 'links', label: 'Links', icon: Link2 },
  { id: 'notes', label: 'Notes', icon: ListTodo },
];
const DRAWER_TAB_IDS = DRAWER_TABS.map((t) => t.id);

// Working-set grouping, in reading order. Pinned and overdue are pulled out of
// their status so the list answers "what needs me first?" before "what is
// there?". A pinned overdue thread counts as pinned (it is already at the top).
const GROUPS = [
  { id: 'pinned', label: 'Pinned', pick: (t) => t.pinned },
  { id: 'overdue', label: 'Overdue', pick: (t) => isThreadOverdue(t) },
  ...THREAD_ACTIVE_STATUSES.map((status) => ({ id: status, label: STATUS_LABELS[status], pick: (t) => t.status === status })),
];

// Each thread lands in the FIRST group whose predicate matches.
function groupThreads(threads) {
  const items = Object.fromEntries(GROUPS.map((g) => [g.id, []]));
  for (const thread of threads) items[GROUPS.find((g) => g.pick(thread))?.id]?.push(thread);
  return GROUPS.map((g) => ({ ...g, items: items[g.id] })).filter((g) => g.items.length > 0);
}

// Form draft ⇄ record. `dueAt` is stored as an ISO timestamp and edited as a
// LOCAL calendar date (`localDateKey` ⇄ local midnight, so the form round-trips
// east of UTC); tags are edited as one comma-separated line.
const toDraft = (thread) => ({
  title: thread.title ?? '',
  status: thread.status ?? 'open',
  priority: thread.priority ?? 'normal',
  pinned: Boolean(thread.pinned),
  nextAction: thread.nextAction ?? '',
  waitingOn: thread.waitingOn ?? '',
  dueAt: typeof thread.dueAt === 'string' ? localDateKey(new Date(thread.dueAt)) : '',
  tags: tagsToInput(thread.tags),
  notes: thread.notes ?? '',
});

const draftToPatch = (draft) => ({
  title: draft.title.trim(),
  status: draft.status,
  priority: draft.priority,
  pinned: draft.pinned,
  nextAction: draft.nextAction,
  waitingOn: draft.waitingOn,
  // Explicit null clears a stored date (absent would preserve it).
  dueAt: draft.dueAt ? new Date(`${draft.dueAt}T00:00:00`).toISOString() : null,
  tags: tagsToArray(draft.tags),
  notes: draft.notes,
});

const loadRecord = (id) => api.getThread(id, { silent: true });

const inputClass = 'w-full bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent';

function ThreadRow({ thread, onOpen, onDone, onTag }) {
  const nextLine = threadNextLine(thread);
  const refCount = Array.isArray(thread.refs) ? thread.refs.length : 0;
  return (
    <li className="flex items-start gap-2 px-3 py-2 rounded-lg border border-port-border bg-port-card hover:border-port-accent/50">
      {!isTerminalThreadStatus(thread.status) && (
        <button
          type="button"
          onClick={() => onDone(thread)}
          className="mt-0.5 shrink-0 w-5 h-5 rounded border border-port-border text-transparent hover:text-port-success hover:border-port-success flex items-center justify-center"
          aria-label={`Mark "${thread.title}" done`}
          title="Mark done"
        >
          <Check size={12} />
        </button>
      )}
      <button type="button" onClick={() => onOpen(thread)} className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2 min-w-0">
          {thread.pinned && <Pin size={12} className="shrink-0 text-port-accent" aria-label="Pinned" />}
          <span className="truncate text-sm text-white">{thread.title}</span>
          {thread.priority && thread.priority !== 'normal' && (
            <Pill tone={PRIORITY_TONE[thread.priority] || 'muted'} size="xs">{thread.priority}</Pill>
          )}
          {thread.externalState === 'closed' && <Pill tone="warning" size="xs">source closed</Pill>}
        </div>
        {nextLine && <div className="text-xs text-gray-400 truncate">{nextLine}</div>}
      </button>
      <div className="shrink-0 flex flex-wrap items-center justify-end gap-1 max-w-[40%]">
        {thread.dueAt && (
          <Pill tone={isThreadOverdue(thread) ? 'error' : 'muted'} size="xs">{formatDateShort(thread.dueAt)}</Pill>
        )}
        {refCount > 0 && <Pill tone="muted" size="xs" icon={Link2}>{formatCount(refCount)}</Pill>}
        {(thread.tags || []).slice(0, 3).map((tag) => (
          <button key={tag} type="button" onClick={() => onTag(tag)} className="text-xs text-gray-500 hover:text-port-accent">#{tag}</button>
        ))}
      </div>
    </li>
  );
}

export default function ThreadsTab() {
  const [searchParams, updateParams] = useUrlParams();
  const statusParam = searchParams.get('status');
  const statusView = STATUS_IDS.includes(statusParam) ? statusParam : 'all';
  const tag = searchParams.get('tag') || '';
  const q = searchParams.get('q') || '';
  const selectedId = searchParams.get('thread');
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [drawerTab, setDrawerTab] = useDrawerTab('threadTab', 'details', DRAWER_TAB_IDS);

  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newTitle, setNewTitle] = useState('');
  const [record, setRecord] = useState(null);
  const [draft, setDraft] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [completingSource, setCompletingSource] = useState(false);
  const [newRef, setNewRef] = useState({ kind: 'url', id: '', label: '' });

  // Two-stage search (the Catalog page's pattern): `searchInput` is what the
  // user is typing; `q` (the URL) drives the fetch and only moves after a
  // pause, so a keystroke never costs a directory walk on the server.
  const [searchInput, setSearchInput] = useState(q);
  useEffect(() => { setSearchInput(q); }, [q]);
  useEffect(() => {
    if (searchInput === q) return undefined;
    const timer = setTimeout(() => updateParams({ q: searchInput }, { replace: true }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput, q, updateParams]);

  // The list — one request for exactly the statuses the view shows.
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.listThreads({ q, tag, status: statusView === 'all' ? WORKING_SET : statusView })
      .then((res) => { if (active) setThreads(Array.isArray(res?.threads) ? res.threads : []); })
      .catch(() => { if (active) setThreads([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [q, tag, statusView]);

  // Open record — keyed to the URL so a deep link and a row click share the path.
  useEffect(() => {
    if (!selectedId) {
      setRecord(null);
      setDraft(null);
      setConfirmDelete(false);
      return undefined;
    }
    let active = true;
    loadRecord(selectedId)
      .then((full) => {
        if (!active) return;
        setRecord(full);
        setDraft(toDraft(full));
      })
      .catch(() => {
        if (!active) return;
        toast.error('Thread not found');
        updateParams({ thread: null, threadTab: null }, { replace: true });
      });
    return () => { active = false; };
  }, [selectedId, updateParams]);

  const groups = useMemo(
    () => (statusView === 'all'
      ? groupThreads(threads)
      : [{ id: statusView, label: STATUS_LABELS[statusView], items: threads }]),
    [threads, statusView],
  );

  const openThread = (thread) => updateParams({ thread: thread.id });
  const closeDrawer = () => updateParams({ thread: null, threadTab: null }, { replace: true });
  const setView = (id) => updateParams({ status: id === 'all' ? null : id }, { replace: true });
  const setTag = (next) => updateParams({ tag: next === tag ? null : next }, { replace: true });

  // Swap an updated record into the list where the server's order would put
  // it, or drop it when it no longer belongs to the current view.
  const replaceRow = (thread) => setThreads((prev) => {
    const visible = statusView === 'all' ? !isTerminalThreadStatus(thread.status) : thread.status === statusView;
    const without = prev.filter((t) => t.id !== thread.id);
    return visible ? [thread, ...without].sort(compareThreads) : without;
  });
  const adoptRecord = (full) => {
    setRecord(full);
    replaceRow(full);
  };

  const completeFromSource = (updated) => {
    replaceRow(updated);
    // The user can navigate while a save is pending. Never replace another
    // drawer's record, or discard edits typed while the request was in flight.
    if (selectedIdRef.current !== updated.id) return;
    setRecord((prev) => ({ ...prev, ...updated }));
    setDraft((prev) => ({ ...prev, status: updated.status }));
  };

  const [create, creating] = useAsyncAction(async () => {
    const title = newTitle.trim();
    if (!title) return null;
    const thread = await api.createThread({ title }, { silent: true });
    setNewTitle('');
    replaceRow(thread);
    updateParams({ thread: thread.id });
    return thread;
  }, { errorMessage: 'Failed to create thread' });

  const [markDone] = useAsyncAction(async (thread) => {
    const updated = await api.updateThread(thread.id, { status: 'done' }, { silent: true });
    replaceRow(updated);
    toast.success(`Done: ${updated.title}`);
    return updated;
  }, { errorMessage: 'Failed to update thread' });

  const [save, saving] = useAsyncAction(async () => {
    if (!record || !draft) return null;
    if (!draft.title.trim()) {
      toast.error('A thread needs a title');
      setDrawerTab('details');
      return null;
    }
    const updated = await api.updateThread(record.id, draftToPatch(draft), { silent: true });
    // A PUT answers with the bare record; keep the hydrated refs we already hold.
    const full = { ...record, ...updated };
    adoptRecord(full);
    setDraft(toDraft(full));
    toast.success('Thread saved');
    return updated;
  }, { errorMessage: 'Failed to save thread' });

  const [remove, removing] = useAsyncAction(async () => {
    await api.deleteThread(record.id, { silent: true });
    setThreads((prev) => prev.filter((t) => t.id !== record.id));
    closeDrawer();
    toast.success('Thread deleted');
    return true;
  }, { errorMessage: 'Failed to delete thread' });

  // Both ref writes answer with the detail shape (hydrated `resolvedRefs`), so
  // the open record is swapped in place — no second read.
  const [addRef, addingRef] = useAsyncAction(async () => {
    const id = newRef.id.trim();
    if (!id) return null;
    const ref = { kind: newRef.kind, id, ...(newRef.label.trim() ? { label: newRef.label.trim() } : {}) };
    adoptRecord(await api.addThreadRef(record.id, ref, { silent: true }));
    setNewRef({ kind: newRef.kind, id: '', label: '' });
    return true;
  }, { errorMessage: 'Failed to add link' });

  const [removeRef] = useAsyncAction(async (item) => {
    adoptRecord(await api.removeThreadRef(record.id, item.kind, item.id, { silent: true }));
    return true;
  }, { errorMessage: 'Failed to remove link' });

  const patchDraft = (patch) => setDraft((prev) => ({ ...prev, ...patch }));
  const baseline = useMemo(() => (record ? toDraft(record) : null), [record]);
  const dirty = useMemo(
    () => Boolean(baseline && draft && Object.keys(baseline).some((k) => baseline[k] !== draft[k])),
    [baseline, draft],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 pt-4 pb-2 space-y-3 border-b border-port-border">
        <form
          className="flex gap-2"
          onSubmit={(e) => { e.preventDefault(); create(); }}
        >
          <label htmlFor="brain-threads-new" className="sr-only">New thread</label>
          <input
            id="brain-threads-new"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Track a new open loop…"
            className={inputClass}
          />
          <button
            type="submit"
            disabled={creating || !newTitle.trim()}
            className="shrink-0 inline-flex items-center gap-1 px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
          >
            <Plus size={14} /> Add
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <TabPills
            tabs={STATUS_VIEWS}
            activeTab={statusView}
            onChange={setView}
            variant="pills"
            size="sm"
            ariaLabel="Thread status"
            controlsIdPrefix="brain-threads"
          />
          <div className="relative flex-1 min-w-[10rem]">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
            <label htmlFor="brain-threads-q" className="sr-only">Search threads</label>
            <input
              id="brain-threads-q"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search"
              className={`${inputClass} pl-7 py-1.5`}
            />
          </div>
          {tag && (
            <button type="button" onClick={() => setTag(tag)} className="inline-flex items-center gap-1 text-xs text-port-accent">
              #{tag} <X size={12} aria-label={`Clear tag ${tag}`} />
            </button>
          )}
        </div>
      </div>

      <div id={`brain-threads-${statusView}`} role="tabpanel" aria-labelledby={`tab-${statusView}`} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        {loading && threads.length === 0 && <p className="text-sm text-gray-500">Loading threads…</p>}
        {!loading && threads.length === 0 && (
          <p className="text-sm text-gray-500">
            {q || tag ? 'No threads match.' : 'Nothing tracked yet — add the first open loop above.'}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            <h3 className="text-xs uppercase tracking-wide text-gray-500 mb-2">
              {group.label} <span className="text-gray-600">{formatCount(group.items.length)}</span>
            </h3>
            <ul className="space-y-1.5">
              {group.items.map((thread) => (
                <ThreadRow key={thread.id} thread={thread} onOpen={openThread} onDone={markDone} onTag={setTag} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <Drawer
        open={Boolean(selectedId)}
        onClose={closeDrawer}
        title="Thread"
        subtitle={record?.title}
        size="lg"
        tabs={DRAWER_TABS}
        activeTab={drawerTab}
        onTabChange={setDrawerTab}
        closeLabel="Close thread"
        closeOnEsc={!dirty}
        closeOnBackdrop={!dirty}
      >
        {record && draft && (
          <fieldset disabled={completingSource} className="space-y-4 min-w-0">
            <div className="flex items-center justify-end gap-2">
              {dirty && <span className="text-xs text-port-warning">Unsaved changes</span>}
              <button
                type="button"
                onClick={save}
                disabled={saving || !dirty}
                className="px-3 py-1.5 rounded bg-port-accent text-white text-sm disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>

            {drawerTab === 'details' && (
              <div className="space-y-3">
                <FormField label="Title">
                  <input value={draft.title} onChange={(e) => patchDraft({ title: e.target.value })} className={inputClass} maxLength={200} />
                </FormField>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <FormField label="Status">
                    <select value={draft.status} onChange={(e) => patchDraft({ status: e.target.value })} className={inputClass}>
                      {THREAD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Priority">
                    <select value={draft.priority} onChange={(e) => patchDraft({ priority: e.target.value })} className={inputClass}>
                      {THREAD_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Due">
                    <input type="date" value={draft.dueAt} onChange={(e) => patchDraft({ dueAt: e.target.value })} className={inputClass} />
                  </FormField>
                </div>
                <FormField label="Next action" hint="The one concrete next step.">
                  <input value={draft.nextAction} onChange={(e) => patchDraft({ nextAction: e.target.value })} className={inputClass} maxLength={500} />
                </FormField>
                <FormField label="Waiting on">
                  <input value={draft.waitingOn} onChange={(e) => patchDraft({ waitingOn: e.target.value })} className={inputClass} maxLength={200} />
                </FormField>
                <FormField label="Tags" hint="Comma-separated.">
                  <input value={draft.tags} onChange={(e) => patchDraft({ tags: e.target.value })} className={inputClass} />
                </FormField>
                <label className="inline-flex items-center gap-2 text-sm text-gray-300">
                  <input type="checkbox" checked={draft.pinned} onChange={(e) => patchDraft({ pinned: e.target.checked })} />
                  Pinned
                </label>
                <ThreadSourceClosedAction
                  key={record.id}
                  thread={record}
                  onCompleted={completeFromSource}
                  onPendingChange={setCompletingSource}
                  disabled={dirty || saving || removing}
                />
                <div className="pt-2 border-t border-port-border">
                  {confirmDelete ? (
                    <InlineConfirmRow
                      question="Delete this thread?"
                      onConfirm={remove}
                      onCancel={() => setConfirmDelete(false)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      disabled={removing}
                      className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-port-error"
                    >
                      <Trash2 size={12} /> Delete thread
                    </button>
                  )}
                </div>
              </div>
            )}

            {drawerTab === 'links' && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {(record.resolvedRefs || []).length === 0 && <p className="text-sm text-gray-500">No links yet.</p>}
                  {(record.resolvedRefs || []).map((item) => (
                    <ThreadRefChip key={`${item.kind}:${item.id}`} {...item} onRemove={() => removeRef(item)} />
                  ))}
                </div>
                <form
                  className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr_1fr_auto] items-end"
                  onSubmit={(e) => { e.preventDefault(); addRef(); }}
                >
                  <FormField label="Kind" compact>
                    <select value={newRef.kind} onChange={(e) => setNewRef((p) => ({ ...p, kind: e.target.value }))} className={inputClass}>
                      {THREAD_REF_KIND_IDS.map((kind) => <option key={kind} value={kind}>{threadRefLabel(kind)}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Id or URL" compact>
                    <input value={newRef.id} onChange={(e) => setNewRef((p) => ({ ...p, id: e.target.value }))} className={inputClass} />
                  </FormField>
                  <FormField label="Label" compact>
                    <input value={newRef.label} onChange={(e) => setNewRef((p) => ({ ...p, label: e.target.value }))} className={inputClass} maxLength={300} />
                  </FormField>
                  <button type="submit" disabled={addingRef || !newRef.id.trim()} className="px-3 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50">
                    Add link
                  </button>
                </form>
              </div>
            )}

            {drawerTab === 'notes' && (
              <FormField label="Notes" hint="Markdown.">
                <textarea
                  value={draft.notes}
                  onChange={(e) => patchDraft({ notes: e.target.value })}
                  className={`${inputClass} min-h-[16rem] font-mono`}
                  maxLength={20000}
                />
              </FormField>
            )}
          </fieldset>
        )}
      </Drawer>
    </div>
  );
}
