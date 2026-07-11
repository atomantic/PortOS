import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Layers, GitBranch, SquareTerminal, ListChecks, Save, RotateCcw,
  Trash2, RefreshCw, FolderGit2, AlertCircle, CheckCircle2, ArrowRight
} from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { timeAgo } from '../utils/formatters';
import {
  listWorkspaceContexts, getWorkspaceContext, saveWorkspaceContext,
  restoreWorkspaceContext, deleteWorkspaceContext
} from '../services/api';

// Light-weight project switcher (#902): pick a project to see and save/restore
// its working context — git branch, in-repo shell sessions, scoped tasks.
// Deep-linkable: /workspace-contexts (list) and /workspace-contexts/:appId.

function StatChip({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-gray-400">
      <Icon size={13} />
      <span>{value} {label}</span>
    </div>
  );
}

function ContextDetail({ appId }) {
  const navigate = useNavigate();
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getWorkspaceContext(appId, { silent: true }).catch(() => null);
    if (!data) {
      toast.error('Could not load workspace context');
      setLoading(false);
      return;
    }
    setCtx(data);
    setLoading(false);
  }, [appId]);

  useEffect(() => { load(); }, [load]);

  const [save, saving] = useAsyncAction(async () => {
    const saved = await saveWorkspaceContext(appId, { silent: true });
    toast.success('Workspace context saved');
    await load();
    return saved;
  }, { errorMessage: 'Failed to save context' });

  const [restore, restoring] = useAsyncAction(async () => {
    const result = await restoreWorkspaceContext(appId, { silent: true });
    const reattach = result?.restorable?.shellSessions?.length || 0;
    const missing = result?.restorable?.missingShellSessionIds?.length || 0;
    toast.success(`Restored: ${reattach} shell session(s) live${missing ? `, ${missing} gone` : ''}`);
    await load();
    return result;
  }, { errorMessage: 'Failed to restore context' });

  const [removeSaved, removing] = useAsyncAction(async () => {
    await deleteWorkspaceContext(appId, { silent: true });
    toast.success('Saved context cleared');
    await load();
  }, { errorMessage: 'Failed to clear context' });

  if (loading) {
    return <div className="text-gray-500 text-sm flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Loading…</div>;
  }
  if (!ctx) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/workspace-contexts')}
            className="text-gray-400 hover:text-white text-sm"
          >
            ← All projects
          </button>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <FolderGit2 size={18} /> {ctx.appName}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-sm disabled:opacity-50"
          >
            <Save size={14} /> Save context
          </button>
          <button
            onClick={restore}
            disabled={restoring || !ctx.saved}
            title={ctx.saved ? 'Reconcile the saved context against what is live now' : 'Nothing saved yet'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-card border border-port-border text-gray-200 hover:bg-port-border text-sm disabled:opacity-40"
          >
            <RotateCcw size={14} /> Restore
          </button>
          {ctx.saved && (
            <button
              onClick={removeSaved}
              disabled={removing}
              aria-label="Delete"
              className="flex items-center gap-1.5 px-2 py-1.5 rounded text-port-error hover:bg-port-error/10 text-sm disabled:opacity-50"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Live context */}
      <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
        <div className="text-xs uppercase tracking-wide text-gray-500">Live now</div>
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <GitBranch size={15} />
          {ctx.isRepo
            ? <span>{ctx.branch || '(detached)'}{ctx.dirty ? <span className="text-port-warning ml-2">{ctx.changedFileCount} uncommitted change(s)</span> : <span className="text-port-success ml-2">clean</span>}</span>
            : <span className="text-gray-500">Not a git repo ({ctx.repoPath || 'no path'})</span>}
        </div>

        <div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
            <SquareTerminal size={13} /> Shell sessions ({ctx.shellSessions.length})
          </div>
          {ctx.shellSessions.length === 0
            ? <div className="text-sm text-gray-600">No live shells rooted in this repo</div>
            : (
              <ul className="space-y-1">
                {ctx.shellSessions.map(s => (
                  <li key={s.sessionId} className="flex items-center justify-between text-sm bg-port-bg rounded px-2 py-1">
                    <span className="text-gray-300 truncate">{s.label || s.kind || 'shell'} <span className="text-gray-600">— {s.cwd}</span></span>
                    <button
                      onClick={() => navigate(`/shell/${s.sessionId}`)}
                      className="text-port-accent hover:underline flex items-center gap-1 shrink-0"
                    >
                      Open <ArrowRight size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </div>

        <div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
            <ListChecks size={13} /> Tasks ({ctx.tasks.length})
          </div>
          {ctx.tasks.length === 0
            ? <div className="text-sm text-gray-600">No tasks scoped to this project</div>
            : (
              <ul className="space-y-1">
                {ctx.tasks.slice(0, 12).map(t => (
                  <li key={t.id} className="flex items-center gap-2 text-sm bg-port-bg rounded px-2 py-1">
                    <span className="text-gray-600 text-xs uppercase shrink-0">{t.status}</span>
                    <span className="text-gray-300 truncate">{t.description}</span>
                  </li>
                ))}
                {ctx.tasks.length > 12 && <li className="text-xs text-gray-600">+{ctx.tasks.length - 12} more</li>}
              </ul>
            )}
        </div>
      </div>

      {/* Saved snapshot */}
      {ctx.saved && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-2">
          <div className="text-xs uppercase tracking-wide text-gray-500">As you left it · saved {timeAgo(ctx.saved.savedAt)}</div>
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <GitBranch size={14} />
            <span>{ctx.saved.branch || '(none)'}</span>
            {ctx.saved.branch && (ctx.saved.branch === ctx.branch
              ? <span className="text-port-success flex items-center gap-1 text-xs"><CheckCircle2 size={12} /> still checked out</span>
              : <span className="text-port-warning flex items-center gap-1 text-xs"><AlertCircle size={12} /> branch changed</span>)}
          </div>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>{ctx.saved.shellSessionIds?.length || 0} shell(s)</span>
            <span>{ctx.saved.taskIds?.length || 0} task(s)</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ContextList() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await listWorkspaceContexts({ silent: true }).catch(() => null);
    if (!data) {
      toast.error('Could not load workspace contexts');
      setLoading(false);
      return;
    }
    setRows(data.contexts || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <div className="text-gray-500 text-sm flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Loading projects…</div>;
  }

  if (rows.length === 0) {
    return <div className="text-gray-500 text-sm">No active projects. Add an app on the Apps page first.</div>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map(row => (
        <button
          key={row.appId}
          onClick={() => navigate(`/workspace-contexts/${row.appId}`)}
          className="text-left bg-port-card border border-port-border rounded-lg p-4 hover:border-port-accent transition-colors"
        >
          <div className="flex items-center gap-2 text-white font-medium mb-2">
            <FolderGit2 size={16} /> {row.appName}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2">
            <StatChip icon={SquareTerminal} label="shell(s)" value={row.shellSessionCount} />
            <StatChip icon={ListChecks} label="task(s)" value={row.taskCount} />
          </div>
          <div className="text-xs text-gray-500">
            {row.savedAt
              ? <span className="flex items-center gap-1"><GitBranch size={11} /> {row.savedBranch || '—'} · saved {timeAgo(row.savedAt)}</span>
              : <span>No saved context</span>}
          </div>
        </button>
      ))}
    </div>
  );
}

export default function WorkspaceContexts() {
  const { appId } = useParams();

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Layers size={20} className="text-port-accent" />
        <h1 className="text-xl font-semibold text-white">Workspace Contexts</h1>
      </div>
      <p className="text-sm text-gray-500">
        Save and restore each project's working context — the active git branch, the
        shell sessions rooted in its repo, and the tasks scoped to it.
      </p>
      {appId ? <ContextDetail appId={appId} /> : <ContextList />}
    </div>
  );
}
