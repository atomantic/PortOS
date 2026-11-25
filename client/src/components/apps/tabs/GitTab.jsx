import { useState, useRef } from 'react';
import BrailleSpinner from '../../BrailleSpinner';
import { createCommit } from '../../../services/apiGit.js';
import RepositorySourcePanel from './RepositorySourcePanel';
import useGitRepoData from './git/useGitRepoData';
import useBranchActions from './git/useBranchActions';
import GitActionsBar from './git/GitActionsBar';
import ReleaseStatusPanel from './git/ReleaseStatusPanel';
import GitStatusPanel from './git/GitStatusPanel';
import CommitComposer from './git/CommitComposer';
import GitHistoryPanel from './git/GitHistoryPanel';
import LocalBranchesPanel from './git/LocalBranchesPanel';
import RemoteBranchesPanel from './git/RemoteBranchesPanel';

// A managed app's Git tab. This component owns only what outlives the panels:
// the repo reads (a reload swaps every panel below the header for a spinner),
// branch-row state, and the cross-panel busy flags that gate Rebase & push.
// Each panel under `./git/` owns the state only it uses.
export default function GitTab({ appId, appName, repoPath }) {
  const repo = useGitRepoData(repoPath);
  const { gitInfo, loading, branches, loadGitData, loadGitInfo, loadRemoteBranches } = repo;
  const branchActions = useBranchActions({
    appId,
    appName,
    repoPath,
    setBranches: repo.setBranches,
    setRemoteBranches: repo.setRemoteBranches,
    loadGitInfo,
  });
  const [rebasingAndPushing, setRebasingAndPushing] = useState(false);
  const [committing, setCommitting] = useState(false);
  // The unsent commit message, kept in a ref so typing re-renders only the
  // composer while the draft still survives the composer's remounts.
  const commitDraftRef = useRef('');

  const handleCommit = async (message, clearDraft) => {
    setCommitting(true);
    // Keep the typed message when the commit fails (hook, identity, lock) so
    // it can be retried without retyping.
    const committed = await createCommit(repoPath, message).then(() => true, () => false);
    if (committed) clearDraft();
    setCommitting(false);
    await loadGitInfo();
  };

  if (!repoPath) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500">
        No repository path configured for this app
      </div>
    );
  }

  return (
    <fieldset disabled={rebasingAndPushing} className="min-w-0 space-y-6">
      <RepositorySourcePanel
        appId={appId}
        appName={appName}
        refreshKey={repo.sourceRefreshKey}
        hasLocalChanges={Boolean(gitInfo?.status?.files?.length)}
        onUpdated={() => loadGitData({ includeRemote: true })}
      />

      <GitActionsBar
        appId={appId}
        appName={appName}
        repoPath={repoPath}
        gitInfo={gitInfo}
        branches={branches}
        otherWorkBusy={loading || committing || branchActions.busy}
        rebasingAndPushing={rebasingAndPushing}
        setRebasingAndPushing={setRebasingAndPushing}
        loadGitData={loadGitData}
        loadGitInfo={loadGitInfo}
        bumpSourceRefresh={repo.bumpSourceRefresh}
      />

      {loading ? (
        <div className="text-center py-8"><BrailleSpinner text="Loading git info" /></div>
      ) : gitInfo && gitInfo.isRepo ? (
        <div className="space-y-6">
          <ReleaseStatusPanel
            appName={appName}
            repoPath={repoPath}
            gitInfo={gitInfo}
            branchComparison={repo.branchComparison}
          />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <GitStatusPanel repoPath={repoPath} gitInfo={gitInfo} loadGitInfo={loadGitInfo} />
              {gitInfo.status?.staged > 0 && (
                <CommitComposer draftRef={commitDraftRef} committing={committing} onCommit={handleCommit} />
              )}
            </div>

            <div className="space-y-4">
              <GitHistoryPanel commits={gitInfo.recentCommits} />
              <LocalBranchesPanel
                appId={appId}
                branches={branches}
                branchesError={repo.branchesError}
                loading={loading}
                onRetry={() => loadGitData({ includeRemote: false })}
                actions={branchActions}
              />
            </div>
          </div>

          <RemoteBranchesPanel
            remoteBranches={repo.remoteBranches}
            remoteBranchesError={repo.remoteBranchesError}
            loadingRemote={repo.loadingRemote}
            onRefresh={() => loadRemoteBranches({ force: true })}
            localWorktreeMergedCount={branches.filter(b => b.merged && b.worktree).length}
            actions={branchActions}
          />
        </div>
      ) : (
        <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500">
          {gitInfo ? 'Not a git repository' : 'Unable to load git status'}
        </div>
      )}
    </fieldset>
  );
}
