import { useEffect, useState, useCallback, useRef } from 'react';
import { GitBranch, Plus, RefreshCw, Trash2, CheckCircle, AlertCircle, Edit3, X } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import { formatDateTime } from '../../utils/formatters';

/**
 * Where reference-watch records its proposals, keyed by the app's RESOLVED work
 * tracker. Mirrors the server-side {trackerInstructions} block so the UID note
 * doesn't lie when an app tracks issues in GitHub/GitLab/JIRA instead of
 * PLAN.md. Falls back to the PLAN.md wording when the tracker is unresolved.
 */
function refWatchDestination(tracker) {
  switch (tracker) {
    case 'github':
      return (<><code>[ref-watch-…]</code> GitHub issues (labeled <code>reference-watch</code>) for <code>/claim --issues</code> to pick up</>);
    case 'gitlab':
      return (<><code>[ref-watch-…]</code> GitLab issues (labeled <code>reference-watch</code>) for <code>/claim --issues</code> to pick up</>);
    case 'jira':
      return (<><code>[ref-watch-…]</code> JIRA tickets for the <code>claim-issue-jira</code> flow to pick up</>);
    default:
      return (<><code>[ref-watch-…]</code> checklist items in <code>PLAN.md</code> for <code>/claim</code> / <code>plan-task</code> to pick up</>);
  }
}

/**
 * Per-app reference-repos manager. Embedded inside the app detail page's
 * "References" tab — the only surface for managing reference repos.
 */
export default function ReferenceReposPanel({ appId, appName }) {
  const [refs, setRefs] = useState([]);
  // Two distinct loading states:
  //   - `initialLoading` is true only on the very first fetch (mount); the
  //     panel renders a placeholder while it's true. Stays false after
  //     that, even on subsequent refreshes.
  //   - `refreshing` is true during post-mutation re-fetches. The panel
  //     keeps the list visible during refresh so per-row state (an
  //     unsaved notes draft, an expanded commit list <details>) doesn't
  //     get unmounted and lost every time the user clicks Check or
  //     Mark-reviewed.
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  // Per-ref UI state — keyed by ref id. Holds the in-progress check snapshot
  // (commit list) so the user can see what's queued before marking-as-reviewed.
  const [snapshots, setSnapshots] = useState({});
  // Track concurrent in-flight checks per-ref. Using a Set so two adjacent
  // rows can both spin without one row's completion clearing the other's
  // spinner. RefRow reads checking via `checkingIds.has(ref.id)`.
  const [checkingIds, setCheckingIds] = useState(() => new Set());
  const [editingNotesId, setEditingNotesId] = useState(null);
  // Resolved work tracker so the description tells the truth about WHERE
  // reference-watch records proposals — PLAN.md vs the app's issue tracker.
  // Read-only; null until loaded (falls back to the generic PLAN.md wording).
  const [workTracker, setWorkTracker] = useState(null);

  // Track an explicit fetch error separately from `refs` so a transient
  // failure doesn't blank the list — stale-but-valid is far better UX
  // than "no refs configured" appearing when the server hiccups.
  const [fetchError, setFetchError] = useState(null);
  const fetch = useCallback(async () => {
    setRefreshing(true);
    const res = await api.listReferenceRepos(appId).catch((e) => ({ __error: e?.message || 'Failed to load references' }));
    if (res && res.__error) {
      setFetchError(res.__error);
    } else {
      setFetchError(null);
      setRefs(res?.referenceRepos || []);
    }
    setRefreshing(false);
    setInitialLoading(false);
  }, [appId]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    let cancelled = false;
    api.getAppWorkTracker(appId)
      .then((info) => { if (!cancelled) setWorkTracker(info?.resolved || null); })
      .catch(() => { if (!cancelled) setWorkTracker(null); });
    return () => { cancelled = true; };
  }, [appId]);

  const handleAdd = async (form) => {
    const created = await api.addReferenceRepo(appId, form).catch((e) => { toast.error(e.message || 'Add failed'); return null; });
    if (!created) return;
    toast.success(`Added "${created.name}"`);
    setShowAdd(false);
    fetch();
  };

  // Two-click delete per CLAUDE.md "no window.confirm". First click arms the
  // row, second click within 4s actually deletes.
  const pendingDeleteRef = useRef({ id: null, expiresAt: 0 });
  const handleDelete = async (ref) => {
    const pending = pendingDeleteRef.current;
    if (pending.id !== ref.id || Date.now() > pending.expiresAt) {
      pendingDeleteRef.current = { id: ref.id, expiresAt: Date.now() + 4000 };
      toast(`Click delete again to remove "${ref.name}"`, { icon: '⚠️' });
      return;
    }
    pendingDeleteRef.current = { id: null, expiresAt: 0 };
    // Only mutate local state on success — otherwise the row vanishes from
    // the UI while the server still has the ref, leaving the user confused
    // about why "delete failed" appeared next to a now-empty list.
    const ok = await api.deleteReferenceRepo(appId, ref.id)
      .then(() => true)
      .catch((e) => { toast.error(e.message || 'Delete failed'); return false; });
    if (!ok) return;
    setRefs((prev) => prev.filter((r) => r.id !== ref.id));
    setSnapshots((prev) => { const n = { ...prev }; delete n[ref.id]; return n; });
  };

  const handleCheck = async (ref) => {
    // Add this ref's id to the in-flight set so its spinner stays on
    // while it runs, even if a different ref's check completes first.
    setCheckingIds((prev) => { const n = new Set(prev); n.add(ref.id); return n; });
    const snap = await api.checkReferenceRepo(appId, ref.id).catch((e) => {
      toast.error(e.message || 'Check failed');
      return null;
    });
    setCheckingIds((prev) => { const n = new Set(prev); n.delete(ref.id); return n; });
    if (!snap) {
      // Clear any stale snapshot — the user just saw a check failure, so
      // leaving a previous commit list expandable would mislead them into
      // thinking the listed commits are still the most recent unreviewed
      // ones (they may not be; the failed check might've been triggered
      // by upstream HEAD moving).
      setSnapshots((prev) => { const n = { ...prev }; delete n[ref.id]; return n; });
      fetch();
      return;
    }
    setSnapshots((prev) => ({ ...prev, [ref.id]: snap }));
    const commitMsg = `${ref.name}: ${snap.commitCount} new commit${snap.commitCount === 1 ? '' : 's'}`;
    if (snap.analysis?.queued) {
      toast.success(`${commitMsg} — analysis task queued`);
    } else if (snap.analysis?.reason === 'duplicate') {
      toast.success(`${commitMsg} — analysis already queued`);
    } else if (snap.analysis?.reason === 'analysis-trigger-failed') {
      // Single combined toast — the prior two-toast pattern (success then
      // error) made the failure easy to miss when both fired together.
      toast.error(`${commitMsg} — but failed to queue analysis task`);
    } else {
      toast.success(commitMsg);
    }
    fetch();
  };

  const handleMarkReviewed = async (ref) => {
    const snap = snapshots[ref.id];
    const sha = snap?.head;
    if (!sha) {
      toast.error('Run "Check now" first to fetch the latest head SHA.');
      return;
    }
    // Only show the success toast / clear the snapshot on a successful
    // PATCH. Otherwise the UI claims the ref was reviewed while the server
    // still has the old lastReviewedSha — which gets confusing fast since
    // the next "Check" rediscovers the same commits.
    const ok = await api.markReferenceRepoReviewed(appId, ref.id, sha)
      .then(() => true)
      .catch((e) => { toast.error(e.message || 'Mark reviewed failed'); return false; });
    if (!ok) return;
    toast.success(`Marked ${ref.name} reviewed up to ${sha.slice(0, 8)}`);
    setSnapshots((prev) => { const n = { ...prev }; delete n[ref.id]; return n; });
    fetch();
  };

  const handleSaveNotes = async (ref, nextNotes) => {
    // Keep the editor open on a failed PATCH — losing the user's draft on
    // a transient network blip is the worst possible outcome here. They
    // can re-click Save, or click Cancel to discard.
    const ok = await api.updateReferenceRepo(appId, ref.id, { notes: nextNotes })
      .then(() => true)
      .catch((e) => { toast.error(e.message || 'Update failed'); return false; });
    if (!ok) return;
    setEditingNotesId(null);
    fetch();
  };

  if (initialLoading) {
    return <div className="text-gray-400 text-sm">Loading references…</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <GitBranch size={14} /> Reference Repos
            {refreshing && <RefreshCw size={11} className="animate-spin text-gray-500" />}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Upstream repos {appName} watches for clean-room reimplementation. The <code className="text-port-accent">reference-watch</code> task fetches each weekly, runs a security screen, and — for adoption-worthy commits — records slug-tagged <code>[ref-watch-…]</code> proposals in {refWatchDestination(workTracker)}. No source-code edits, no separate review file.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded text-xs inline-flex items-center gap-1 shrink-0"
        >
          <Plus size={14} /> Add reference
        </button>
      </div>

      {showAdd && (
        <AddRefForm onSubmit={handleAdd} onCancel={() => setShowAdd(false)} />
      )}

      {fetchError && (
        <div className="bg-port-error/10 border border-port-error/40 text-port-error text-xs rounded p-2 inline-flex items-center gap-2">
          <AlertCircle size={12} /> Failed to refresh references: {fetchError}. Showing last known data.
        </div>
      )}

      {refs.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-4 text-center text-gray-500 text-sm">
          No reference repos configured.
        </div>
      ) : (
        <div className="space-y-2">
          {refs.map((ref) => (
            <RefRow
              key={ref.id}
              reference={ref}
              snapshot={snapshots[ref.id]}
              checking={checkingIds.has(ref.id)}
              editingNotes={editingNotesId === ref.id}
              onCheck={() => handleCheck(ref)}
              onMarkReviewed={() => handleMarkReviewed(ref)}
              onDelete={() => handleDelete(ref)}
              onEditNotes={() => setEditingNotesId(ref.id)}
              onCancelNotes={() => setEditingNotesId(null)}
              onSaveNotes={(notes) => handleSaveNotes(ref, notes)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, lastError }) {
  if (status === 'error') {
    return (
      <span className="px-1.5 py-0.5 bg-port-error/20 text-port-error text-[10px] rounded inline-flex items-center gap-1" title={lastError || 'Last check failed'}>
        <AlertCircle size={10} /> error
      </span>
    );
  }
  if (status === 'needs-clone') {
    return <span className="px-1.5 py-0.5 bg-gray-500/20 text-gray-400 text-[10px] rounded">unscanned</span>;
  }
  return (
    <span className="px-1.5 py-0.5 bg-port-success/20 text-port-success text-[10px] rounded inline-flex items-center gap-1">
      <CheckCircle size={10} /> ok
    </span>
  );
}

function RefRow({ reference, snapshot, checking, editingNotes, onCheck, onMarkReviewed, onDelete, onEditNotes, onCancelNotes, onSaveNotes }) {
  // Seed the draft when the user enters edit mode. Don't depend on
  // `reference.notes` — a parent re-fetch produces a new ref object every
  // poll and would clobber whatever the user is mid-typing.
  const [notesDraft, setNotesDraft] = useState(reference.notes || '');
  useEffect(() => {
    if (editingNotes) setNotesDraft(reference.notes || '');
  }, [editingNotes]);

  const lastReviewedShort = reference.lastReviewedSha ? reference.lastReviewedSha.slice(0, 8) : null;
  const lastCheckedAgo = reference.lastCheckedAt ? formatDateTime(reference.lastCheckedAt) : 'never';
  const commitCount = snapshot?.commitCount;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-white truncate">{reference.name}</span>
            <StatusBadge status={reference.status} lastError={reference.lastError} />
            {commitCount > 0 && (
              <span className="px-1.5 py-0.5 bg-port-warning/20 text-port-warning text-[10px] rounded">
                {commitCount} new
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate mt-0.5" title={reference.repoUrl}>
            {reference.repoUrl} <span className="text-gray-600">·</span> {reference.branch || 'main'}
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">
            Last reviewed: <span className="font-mono">{lastReviewedShort || '—'}</span>
            <span className="mx-1">·</span>
            Last checked: {lastCheckedAgo}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onCheck}
            disabled={checking}
            className="px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded text-xs inline-flex items-center gap-1 disabled:opacity-50"
            title="Fetch upstream and list new commits"
          >
            <RefreshCw size={12} className={checking ? 'animate-spin' : ''} /> Check
          </button>
          {snapshot?.head && snapshot.head !== reference.lastReviewedSha && (
            <button
              onClick={onMarkReviewed}
              className="px-2 py-1 bg-port-success/20 text-port-success hover:bg-port-success/30 rounded text-xs"
              title={`Pin lastReviewedSha = ${snapshot.head.slice(0, 8)}`}
            >
              Mark reviewed
            </button>
          )}
          <button
            onClick={onEditNotes}
            className="px-2 py-1 text-gray-400 hover:text-white rounded"
            title="Edit notes"
          >
            <Edit3 size={12} />
          </button>
          <button
            onClick={onDelete}
            className="px-2 py-1 text-gray-400 hover:text-port-error rounded"
            title="Remove this reference"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {editingNotes ? (
        <div className="space-y-1">
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            rows={4}
            placeholder="What features rely on this repo? The watch agent reads this to know which commits matter."
            className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-xs text-white focus:border-port-accent focus:outline-hidden"
          />
          <div className="flex gap-1">
            <button
              onClick={() => onSaveNotes(notesDraft.trim())}
              className="px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded text-xs"
            >
              Save
            </button>
            <button
              onClick={onCancelNotes}
              className="px-2 py-1 text-gray-400 hover:text-white rounded text-xs inline-flex items-center gap-1"
            >
              <X size={12} /> Cancel
            </button>
          </div>
        </div>
      ) : reference.notes ? (
        <div className="text-xs text-gray-400 whitespace-pre-wrap border-l-2 border-port-border pl-2">
          {reference.notes}
        </div>
      ) : null}

      {snapshot?.commits?.length > 0 && (
        <details className="text-xs text-gray-300">
          <summary className="cursor-pointer text-gray-400 hover:text-white">
            View {snapshot.commits.length} new commit{snapshot.commits.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 ml-2 space-y-0.5 font-mono text-[11px]">
            {snapshot.commits.map((c) => (
              <li key={c.sha} className="truncate">
                <span className="text-port-accent">{c.sha.slice(0, 8)}</span>
                <span className="mx-1 text-gray-500">·</span>
                <span className="text-gray-200">{c.subject}</span>
                <span className="mx-1 text-gray-600">—</span>
                <span className="text-gray-500">{c.author}, {c.date.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AddRefForm({ onSubmit, onCancel }) {
  const [form, setForm] = useState({ name: '', repoUrl: '', branch: 'main', notes: '' });
  const submit = (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.repoUrl.trim()) return;
    onSubmit({
      name: form.name.trim(),
      repoUrl: form.repoUrl.trim(),
      branch: form.branch.trim() || undefined,
      notes: form.notes.trim() || undefined,
    });
  };
  return (
    <form onSubmit={submit} className="bg-port-card border border-port-accent/40 rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          autoFocus
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="Display name (e.g. phosphene)"
          className="px-2 py-1 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
        />
        <input
          value={form.branch}
          onChange={(e) => setForm((f) => ({ ...f, branch: e.target.value }))}
          placeholder="Branch (default: main)"
          className="px-2 py-1 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
        />
      </div>
      <input
        value={form.repoUrl}
        onChange={(e) => setForm((f) => ({ ...f, repoUrl: e.target.value }))}
        placeholder="Repo URL (https://github.com/owner/repo.git) or local path"
        className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
      />
      <textarea
        value={form.notes}
        onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
        rows={3}
        placeholder="Notes — what features in our app use this repo? (Helps the watch agent prioritize.)"
        className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
      />
      <div className="flex gap-2">
        <button type="submit" className="px-3 py-1.5 bg-port-accent text-white rounded text-xs">Add</button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-gray-400 hover:text-white text-xs">Cancel</button>
      </div>
    </form>
  );
}
