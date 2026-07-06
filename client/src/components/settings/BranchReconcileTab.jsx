import { useEffect, useState } from 'react';
import { Save, Loader2, GitPullRequest, RefreshCw } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import {
  getSettings,
  updateSettings,
  getBranchReconcileStatus,
  runBranchReconcile,
} from '../../services/api';

// Actions follow an opt-out model: absent/undefined means ON. Only an explicit
// `false` disables. Mirrors the server's `actionOn` helper.
const on = (v) => v !== false;

const ACTIONS = [
  { key: 'cleanupMerged', label: 'Clean up merged/orphaned branches + worktrees', help: 'Deterministic — no agent. Removes a local branch whose work is already merged, plus its lingering worktree.' },
  { key: 'openPr', label: 'Open a PR for a finished branch without one', help: 'Agent verifies the work is complete, then runs /do:pr.' },
  { key: 'resolveConflicts', label: 'Resolve conflicts on open PRs', help: 'Agent rebases onto the default branch and resolves conflicts.' },
  { key: 'autoMerge', label: 'Auto-merge PRs that are fully green', help: 'Merges only when MERGEABLE + CI green + latest Copilot review has 0 comments.' },
];

// Settings → Branch Reconcile. Opt-in daily automation that finishes THIS
// machine's unfinished local branches/PRs (cleanup merged, open PRs, resolve
// conflicts, merge) without touching federated peers' branches. OFF by default.
export function BranchReconcileTab() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [cron, setCron] = useState('0 3 * * *');
  const [actions, setActions] = useState({ cleanupMerged: true, openPr: true, resolveConflicts: true, autoMerge: true });

  const [savedEnabled, setSavedEnabled] = useState(false);
  const [savedCron, setSavedCron] = useState('0 3 * * *');
  const [savedActions, setSavedActions] = useState({ cleanupMerged: true, openPr: true, resolveConflicts: true, autoMerge: true });

  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(null);

  useEffect(() => {
    Promise.all([
      getSettings({ silent: true }).catch(() => ({})),
      getBranchReconcileStatus({ silent: true }).catch(() => null),
    ]).then(([settings, status]) => {
      const c = settings?.branchReconcile || {};
      const en = c.enabled === true;
      const cr = typeof c.cron === 'string' && c.cron ? c.cron : '0 3 * * *';
      const acts = {
        cleanupMerged: on(c.actions?.cleanupMerged),
        openPr: on(c.actions?.openPr),
        resolveConflicts: on(c.actions?.resolveConflicts),
        autoMerge: on(c.actions?.autoMerge),
      };
      setEnabled(en); setCron(cr); setActions(acts);
      setSavedEnabled(en); setSavedCron(cr); setSavedActions(acts);
      setLastRun(status?.lastRun || null);
    }).finally(() => setLoading(false));
  }, []);

  const actionsDirty = ACTIONS.some((a) => actions[a.key] !== savedActions[a.key]);
  const dirty = enabled !== savedEnabled || cron.trim() !== savedCron || actionsDirty;

  const handleSave = async () => {
    const cr = cron.trim() || '0 3 * * *';
    setSaving(true);
    const merged = await updateSettings({ branchReconcile: { enabled, cron: cr, actions } }).catch(() => null);
    setSaving(false);
    if (!merged) return;
    setCron(cr);
    setSavedEnabled(enabled); setSavedCron(cr); setSavedActions(actions);
    toast.success('Saved — schedule applies on next server restart');
  };

  // Run Now gates on the SAVED enabled state (not the in-memory toggle) and is
  // disabled while the form is dirty or a save/run is in flight — so the user
  // can't trigger a run against a config they haven't persisted.
  const handleRunNow = async () => {
    setRunning(true);
    const summary = await runBranchReconcile({ silent: true }).catch(() => null);
    setRunning(false);
    if (!summary) { toast.error('Reconcile run failed'); return; }
    setLastRun(summary);
    // The server catches run failures and returns a 200 `{ error }` summary
    // (the run happens outside the request lifecycle), so a resolved promise is
    // NOT proof of success — check the failure fields before toasting success.
    if (summary.error) toast.error(`Reconcile failed: ${summary.error}`);
    else if (summary.skipped === 'disabled') toast.error('Reconciler is disabled — enable and save first');
    else toast.success(`Reconcile: cleaned ${summary.cleaned?.length ?? 0}, coordinator ${summary.queued ? 'queued' : 'not queued'}`);
  };

  if (loading) return <BrailleSpinner />;

  return (
    <div className="space-y-6">
      <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-2">
          <GitPullRequest size={16} className="text-port-accent" />
          <h3 className="text-lg font-semibold text-white">Branch &amp; PR Reconciler</h3>
        </div>
        <p className="text-sm text-gray-400 mb-4">
          Daily automation that finishes <strong>this machine&apos;s</strong> unfinished git work: cleans up branches
          whose PRs already merged, and dispatches an agent to open PRs, resolve conflicts, and merge in-flight ones.
          Only local branches are touched — branches created on federated peers are never affected. OFF by default.
        </p>

        <div className="space-y-4">
          <label htmlFor="br-enabled" className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              id="br-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 accent-port-accent"
            />
            Enable the daily reconciler
          </label>

          <div>
            <label htmlFor="br-cron" className="block text-xs uppercase tracking-wider text-gray-500 mb-1">
              Cron schedule
            </label>
            <input
              id="br-cron"
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 3 * * *"
              className="w-48 px-3 py-2 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
            />
            <p className="text-xs text-gray-500 mt-1">Default <code className="text-gray-400">0 3 * * *</code> = daily at 3am.</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs uppercase tracking-wider text-gray-500 mb-1">Actions</legend>
            {ACTIONS.map((a) => (
              <label key={a.key} htmlFor={`br-action-${a.key}`} className="flex items-start gap-2 text-sm text-gray-200 cursor-pointer">
                <input
                  id={`br-action-${a.key}`}
                  type="checkbox"
                  checked={actions[a.key]}
                  onChange={(e) => setActions((prev) => ({ ...prev, [a.key]: e.target.checked }))}
                  className="w-4 h-4 mt-0.5 accent-port-accent"
                />
                <span>
                  {a.label}
                  <span className="block text-xs text-gray-500">{a.help}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleRunNow}
              disabled={!savedEnabled || dirty || saving || running}
              title={!savedEnabled ? 'Enable and save first' : dirty ? 'Save your changes first' : 'Run a reconcile pass now'}
              className="inline-flex items-center justify-center gap-2 min-h-[40px] px-4 py-2 bg-port-bg border border-port-border hover:border-port-accent text-gray-200 rounded-lg text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Run now
            </button>
          </div>
        </div>
      </div>

      {lastRun && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-white mb-2">Last run</h3>
          {lastRun.skipped === 'disabled' ? (
            <p className="text-sm text-gray-400">Skipped — reconciler disabled.</p>
          ) : lastRun.error ? (
            <p className="text-sm text-port-error">{lastRun.error}</p>
          ) : (
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
              <div><dt className="text-gray-500 text-xs uppercase">When</dt><dd className="text-gray-200">{lastRun.at ? new Date(lastRun.at).toLocaleString() : '—'}</dd></div>
              <div><dt className="text-gray-500 text-xs uppercase">Cleaned</dt><dd className="text-gray-200">{lastRun.cleaned?.length ?? 0}</dd></div>
              <div><dt className="text-gray-500 text-xs uppercase">Coordinator queued</dt><dd className="text-gray-200">{lastRun.queued ? 'yes' : 'no'}</dd></div>
              <div><dt className="text-gray-500 text-xs uppercase">Actionable</dt><dd className="text-gray-200">{lastRun.actionable?.join(', ') || '—'}</dd></div>
              <div><dt className="text-gray-500 text-xs uppercase">WIP (left)</dt><dd className="text-gray-200">{lastRun.wip?.join(', ') || '—'}</dd></div>
            </dl>
          )}
          {/* The coordinator is queued but only RUNS when CoS auto-run is in Execute mode.
              Warn honestly so the queued state isn't mistaken for "an agent is running". */}
          {lastRun.queued && lastRun.coordinatorWillRun === false && (
            <p className="text-xs text-port-warning mt-3">
              Coordinator queued but CoS auto-run is <code>{lastRun.cosAutonomy || 'not execute'}</code> — it will spawn once you set CoS auto-run to <strong>Execute</strong>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default BranchReconcileTab;
