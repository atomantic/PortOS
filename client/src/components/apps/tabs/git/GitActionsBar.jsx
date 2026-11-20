import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Download, Rocket, Upload, ArrowUpDown, RotateCcw, Terminal, Loader2 } from 'lucide-react';
import toast from '../../../ui/Toast';
import ConfirmModal from '../../../ui/ConfirmModal';
import {
  updateBranches,
  pushAllBranches,
  rebaseAndPushDefaultBranch,
  resetToDefaultBranch,
} from '../../../../services/apiGit.js';
import { createSlashdoTask, forceCosEvaluate } from '../../../../services/apiAgents.js';

// The "Git Status" header: repo-wide actions (rebase & push, push all, PR agent,
// fetch, terminal, reset to origin) and the reset confirmation. It renders
// outside the loading spinner, so its own in-flight flags live here.
// `rebasingAndPushing` is the parent's because it disables the whole tab.
export default function GitActionsBar({
  appId,
  appName,
  repoPath,
  gitInfo,
  branches,
  otherWorkBusy,
  rebasingAndPushing,
  setRebasingAndPushing,
  loadGitData,
  loadGitInfo,
  bumpSourceRefresh,
}) {
  const navigate = useNavigate();
  const [updating, setUpdating] = useState(false);
  const [pushingAll, setPushingAll] = useState(false);
  const [openingPullRequest, setOpeningPullRequest] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  const handleUpdateBranches = async () => {
    if (!repoPath) return;
    setUpdating(true);
    const result = await updateBranches(repoPath).catch(() => null);
    setUpdating(false);
    if (result) {
      const parts = [];
      for (const [key, val] of Object.entries(result)) {
        if (key !== 'currentBranch' && val) {
          parts.push(`${key}: ${val}`);
        }
      }
      toast.success(`Branches updated — ${parts.join(', ')}`);
    }
    await loadGitData({ includeRemote: true });
    bumpSourceRefresh();
  };

  const handleOpenTerminal = () => {
    if (!repoPath) return;
    navigate(`/shell?cwd=${encodeURIComponent(repoPath)}`);
  };

  const handlePushAll = async () => {
    if (!repoPath || pushingAll) return;
    setPushingAll(true);
    const result = await pushAllBranches(repoPath).catch(() => null);
    setPushingAll(false);
    if (result?.success) {
      toast.success(`Pushed ${result.pushed} branch${result.pushed === 1 ? '' : 'es'}`);
    } else if (result) {
      const failedNames = Object.entries(result.results || {})
        .filter(([, v]) => !v.success)
        .map(([name]) => name);
      toast.error(`Push failed for: ${failedNames.join(', ')}`);
    }
    await loadGitInfo();
  };

  const handleRebaseAndPush = async () => {
    if (!repoPath || rebasingAndPushing) return;
    setRebasingAndPushing(true);
    const result = await rebaseAndPushDefaultBranch(repoPath, { silent: true }).catch(error => {
      toast.error(error.message || 'Rebase & push failed');
      return null;
    });
    if (result?.success) toast.success(`Rebased and pushed ${result.branch}`);
    else if (result?.error) toast.error(result.error);
    await loadGitInfo();
    setRebasingAndPushing(false);
  };

  const handleOpenPullRequest = async () => {
    if (!appId || !repoPath || openingPullRequest) return;
    setOpeningPullRequest(true);
    const result = await createSlashdoTask('push', appId, {
      prCompletion: 'review-then-merge',
      overrideContext: `Work on the managed app repository at ${repoPath}. Reconcile all current work before delivery: include uncommitted changes, local commits not merged into the default branch, and commits not yet pushed. Preserve the app's existing intent, create or update a pull request against the default branch, then run the configured review process and merge it when review and CI are green. Do not discard work or push directly to the protected default branch.`,
    }, { silent: true }).catch((err) => {
      toast.error(`Could not queue pull request agent: ${err.message}`);
      return null;
    });
    setOpeningPullRequest(false);
    if (result) {
      toast.success(`Pull request agent queued for ${appName} — check CoS Agents`);
      await forceCosEvaluate().catch(() => null);
    }
  };

  // Destructive: throws away tracked edits and local commits on the default
  // branch. The pre-reset sha comes back in the result and is surfaced in the
  // toast, so a mistake is still recoverable with `git reset --hard <sha>`.
  const handleResetToDefault = async () => {
    if (!repoPath || resetting) return;
    setResetting(true);
    setResetConfirm(false);
    const result = await resetToDefaultBranch(repoPath, { silent: true }).catch((err) => {
      toast.error(`Reset failed: ${err.message}`);
      return null;
    });
    setResetting(false);
    if (result?.success) {
      // The server's counts, not the pre-click snapshot the dialog previewed.
      const from = result.previousBranch && result.previousBranch !== result.branch
        ? ` from ${result.previousBranch}`
        : '';
      toast.success(`Reset to origin/${result.branch}${from} — discarded ${result.discardedFiles} file change${result.discardedFiles === 1 ? '' : 's'}`);
      if (result.clearedOperations?.length) {
        toast(`Also cleared an in-progress ${result.clearedOperations.join(' and ')}`, { icon: '🧹' });
      }
      if (result.previousHead) {
        toast(`Previous state was ${result.previousHead.slice(0, 7)} — git reset --hard ${result.previousHead.slice(0, 7)} to undo`, { icon: '↩️' });
      }
      if (!result.fetched) {
        toast('Could not reach origin — reset to the last fetched state', { icon: '⚠️' });
      }
      await loadGitData({ includeRemote: true });
    }
  };

  // Untracked files are the ones a reset KEEPS, so they must not be counted in
  // what it says it will discard — the dialog claims both things two rows apart.
  const dirtyCount = gitInfo?.status?.files?.filter(f => f.status !== 'untracked').length || 0;

  return (
    <>
      {/* Wraps rather than overflows: three actions no longer fit one phone row. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">Git Status</h2>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleRebaseAndPush}
            disabled={rebasingAndPushing || otherWorkBusy || updating || pushingAll || resetting
              || !gitInfo?.status?.clean || gitInfo?.branch !== gitInfo?.baseBranch || !(gitInfo?.originComparison?.ahead > 0)}
            title="Rebase local default-branch commits onto origin, then push; requires a clean checkout ahead of origin"
            className="flex min-h-[40px] items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50"
          >
            {rebasingAndPushing ? <Loader2 size={16} className="animate-spin" /> : <ArrowUpDown size={16} />}
            {rebasingAndPushing ? 'Rebasing & pushing...' : 'Rebase & push'}
          </button>
          {branches.some(b => b.tracking && b.ahead > 0) && (
            <button
              onClick={handlePushAll}
              disabled={pushingAll}
              className="flex items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-success disabled:opacity-50"
            >
              {pushingAll ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
              {pushingAll ? 'Pushing...' : 'Push'}
            </button>
          )}
          <button
            onClick={handleOpenPullRequest}
            disabled={openingPullRequest || !gitInfo?.isRepo}
            title="Have an agent commit, push, review, and merge the current repository work through a pull request"
            className="flex items-center gap-1.5 px-3 py-2 bg-port-accent/20 border border-port-accent/40 rounded-lg text-sm text-port-accent hover:bg-port-accent/30 disabled:opacity-50"
          >
            {openingPullRequest ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />}
            {openingPullRequest ? 'Queuing PR agent...' : 'Open PR with agent'}
          </button>
          <button
            onClick={handleUpdateBranches}
            disabled={updating}
            className="flex items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50"
          >
            {updating ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
            {updating ? 'Fetching...' : 'Fetch branches'}
          </button>
          <button
            onClick={handleOpenTerminal}
            disabled={!repoPath}
            title="Open shell terminal in this app directory"
            className="flex items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50"
          >
            <Terminal size={16} />
            Open terminal
          </button>
          <button
            onClick={() => {
              setResetConfirm(true);
              // The dialog names how many files it is about to destroy, so it
              // reads fresh state rather than whatever the last poll left.
              loadGitInfo();
            }}
            disabled={resetting}
            title="Discard local changes and match origin's default branch"
            className="flex items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-error disabled:opacity-50"
          >
            <RotateCcw size={16} className={resetting ? 'animate-spin' : ''} />
            {resetting ? 'Resetting...' : 'Reset to origin'}
          </button>
        </div>
      </div>

      {/* Destructive, so it spells out what goes and what survives rather than
          asking "are you sure?". */}
      <ConfirmModal
        open={resetConfirm}
        onClose={() => setResetConfirm(false)}
        titleId="git-reset-modal-title"
        icon={<RotateCcw size={18} className="text-port-error" />}
        title={`Reset ${appName} to origin/${gitInfo?.baseBranch || 'main'}`}
        tone="error"
        confirmLabel={resetting ? 'Resetting...' : 'Discard and reset'}
        onConfirm={handleResetToDefault}
        busy={resetting}
      >
        <p className="text-sm text-gray-300">
          Fetches origin, switches to the default branch, and hard-resets it to the remote.
        </p>
        <ul className="text-sm text-gray-400 space-y-1.5 ml-4 list-disc">
          <li>Discards {dirtyCount} uncommitted file change{dirtyCount === 1 ? '' : 's'}</li>
          <li>Discards any local commits on {gitInfo?.baseBranch || 'main'} that origin does not have</li>
          <li>Keeps untracked files and every other local branch</li>
        </ul>
        <p className="text-xs text-gray-500">
          The commit you are on now is reported after the reset, so <code>git reset --hard &lt;sha&gt;</code> can undo this.
        </p>
      </ConfirmModal>
    </>
  );
}
