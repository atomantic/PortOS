import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import * as api from '../../../services/api';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import AgentJobProviderFields, { hasRunnableAgentProvider } from '../../cos/AgentJobProviderFields';
import Modal from '../../ui/Modal';

export default function GitRecoveryAction({ appId, appName, disabled }) {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState('');
  const [selection, setSelection] = useState({ providerId: '', model: '', effort: '' });
  const [error, setError] = useState('');
  const [queued, setQueued] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getProviders({ silent: true }).then(data => {
      if (cancelled) return;
      setProviders(data?.providers || []);
      setActiveProviderId(data?.activeProvider || '');
      setError(data?.providers?.length ? '' : 'No agent providers are configured. Add a CLI/TUI provider in AI Providers.');
    }).catch(() => { if (!cancelled) setError('Could not load providers. Close and retry.'); });
    return () => { cancelled = true; };
  }, [open]);
  const runnable = hasRunnableAgentProvider(providers, selection.providerId, activeProviderId);
  const [queue, queueing] = useAsyncAction(async () => {
    if (!runnable || queued || disabled) return;
    await api.addCosTask({
      description: `Preserve pending work and reconcile the application checkout for ${appName}`,
      prompt: `Investigate and resolve pending Git work in this app's configured checkout so it can safely update to the latest origin default branch (normally main).
Work in the actual application checkout, not a fresh worktree that hides its dirty state. Read repository instructions and discover the configured path, origin, default branch, branch protections, worktrees and active agents first. Respect forks: origin is the target, never substitute upstream. Inspect configured companion repositories too; preserve and reconcile their pending work against their own configured origin branch without switching them to the app default branch.
Before changing anything, inspect staged, unstaged, untracked and conflicted files, local commits, stashes, and any in-progress merge/rebase. Do not interfere with active work; if ownership is unclear, preserve it and report a blocker.
Create and verify recoverable local backups of all pending content (including untracked files and the index) and backup refs for local commits before resolving anything. Keep backups outside tracked files and retain them through completion. Never blindly pop/drop stashes, reset --hard, git clean, force push, or discard work based only on filenames.
Fetch origin and compare each change against current remote history. Determine whether it is stale restored work already better resolved remotely or legitimate unfinished work. Preserve the newer implementation while retaining every unique intended change. Finish legitimate work, run appropriate checks, review the diff for secrets and quality, and commit only the relevant files. Push completed work normally; if branch protection requires a PR, create it and satisfy required CI/review gates before merging. Do not bypass protections.
Resolve existing rebase/merge conflicts preserving both sides' intent. Integrate the latest origin default branch only after pending work is safely accounted for. Do not replay stale stash contents over the resolved checkout. Do not change unrelated branches or remove other worktrees.
Finally fetch again and verify the actual app checkout is on the default branch, clean including untracked work, and matches origin's latest default-branch HEAD, with all completed commits published. If blocked, retain backups and report precise remaining work; never claim success from a queued task or a local commit alone. Report preserved/discarded-as-redundant changes with evidence, tests, pushed commits/PR URLs, final Git status and backup locations locally. Do not publish private paths or app data. Do not restart the app; the user can run Update app afterward.`,
      app: appId,
      provider: selection.providerId || activeProviderId,
      model: selection.model || undefined,
      effort: selection.effort || undefined,
      whenDone: 'commit-push',
      useWorktree: false,
      openPR: false,
      autoApprove: true,
      priority: 'high',
    }, { silent: true });
    setQueued(true);
    setOpen(false);
  }, { errorMessage: 'Could not queue Git recovery' });
  return <>
    {queued ? <Link to="/cos/agents" className="text-sm text-port-accent underline">Recovery queued · View agents</Link> :
      <button disabled={disabled} onClick={() => setOpen(true)} className="min-h-[40px] rounded-lg bg-port-accent px-4 py-2 text-sm text-white disabled:opacity-50">Resolve with agent</button>}
    <Modal open={open} onClose={() => !queueing && setOpen(false)} ariaLabelledBy="git-recovery-title" panelClassName="bg-port-card border border-port-border rounded-xl" backdropClassName="bg-black/50">
      <div className="p-4 space-y-4">
        <h3 id="git-recovery-title" className="font-medium">Resolve pending Git work</h3>
        <p className="text-sm text-gray-400">An agent will investigate local changes, preserve recoverable copies, finish and publish legitimate work, and reconcile the checkout with the latest origin default branch. Follow its progress before running Update app.</p>
        <AgentJobProviderFields data={selection} providers={providers} activeProviderId={activeProviderId} onChange={patch => setSelection(prev => ({ ...prev, ...patch }))} />
        {error && <p role="alert">{error}</p>}
        {!error && !providers.length && <p role="status">Loading available agent providers…</p>}
        <div className="flex justify-end gap-3">
          <button disabled={queueing} onClick={() => setOpen(false)}>Cancel</button>
          <button disabled={!runnable || queueing || disabled} onClick={queue} className="min-h-[44px] rounded-lg bg-port-accent px-4 py-2 text-white disabled:opacity-50">{queueing ? 'Queueing…' : 'Start recovery agent'}</button>
        </div>
      </div>
    </Modal>
  </>;
}
