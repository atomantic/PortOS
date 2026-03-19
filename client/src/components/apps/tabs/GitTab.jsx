import { useState, useEffect, useCallback } from 'react';
import { GitBranch, Plus, Minus, FileText, RefreshCw, Download, Rocket, Upload, ArrowUpDown, Check, Trash2, GitMerge, Globe } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';

function buildReleasePrompt({ repoPath, appName, comparison, baseBranch, devBranch, hasChangelog }) {
  const commitList = comparison.commits
    .map(c => `- ${c.hash} ${c.message}`)
    .join('\n');

  const changelogStep = hasChangelog ? `
2. **Changelog management**:
   - Read version from package.json to determine the minor version series (e.g., 0.12.x)
   - Check if \`.changelog/v{major}.{minor}.x.md\` exists
   - If not, create it using the structure from an existing changelog file as template
   - Update it with entries for the commits being released, categorized by type (Features, Fixes, Improvements)
   - Keep the version as literal "x" — the release workflow substitutes the actual version
   - Commit the changelog: \`git add .changelog/ && git commit -m "docs: update changelog for release"\`
   - Push: \`git pull --rebase --autostash && git push\`
` : '';

  const prStep = hasChangelog ? 3 : 2;
  const reviewStep = prStep + 1;
  const feedbackStep = reviewStep + 1;
  const reRequestStep = feedbackStep + 1;
  const iterateStep = reRequestStep + 1;
  const ciStep = iterateStep + 1;
  const mergeStep = ciStep + 1;

  return `You are performing a release workflow for ${appName}. The repo is at: ${repoPath}

## Commits to release (${comparison.ahead} commits ahead of ${baseBranch}):
${commitList}

## Steps

1. **Ensure clean state**:
   - Check for uncommitted changes. If any, stage, commit with a descriptive message, then run \`git pull --rebase --autostash && git push\`
   - If no uncommitted changes, still run \`git pull --rebase --autostash && git push\` to ensure we're up to date
${changelogStep}
${prStep}. **Create PR**:
   - Check for existing PR: \`gh pr list --base ${baseBranch} --head ${devBranch} --state open\`
   - If no existing PR, create one: \`gh pr create --base ${baseBranch} --head ${devBranch} --title "Release vX.Y.Z" --body "Release notes..."\`
   - Include a summary of changes in the PR body

${reviewStep}. **Wait for Copilot review**:
   - Poll \`gh pr view --json reviews\` every 30 seconds
   - Timeout after 2 minutes if no review appears

${feedbackStep}. **Address review feedback** (if any):
   - Fetch unresolved threads via GraphQL:
     \`\`\`
     gh api graphql -f query='query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 10) { nodes { body path line author { login } } } } } } } }'
     \`\`\`
   - Make requested changes, commit, push (\`git pull --rebase --autostash && git push\`)
   - Resolve addressed threads via GraphQL mutation

${reRequestStep}. **Re-request review**:
   - Get repo info: \`gh repo view --json owner,name\`
   - Get PR number from \`gh pr view --json number\`
   - Try API: \`gh api repos/{owner}/{repo}/pulls/{pr}/requested_reviewers -f '{"reviewers":["copilot-pull-request-reviewer"]}' --method POST\`
   - If that fails, use browser MCP to navigate to the PR page and click the re-request review button (the sync icon button with \`name="re_request_reviewer_id"\`)

${iterateStep}. **Iterate**: Repeat steps ${reviewStep}-${reRequestStep} up to 3 times max

${ciStep}. **Verify CI**: Run \`gh pr checks\` and fix any failures

${mergeStep}. **Merge**: Once approved and CI passes, merge with \`gh pr merge --merge\`

## Important rules:
- Always \`git pull --rebase --autostash\` before pushing
- No co-author info in commits${hasChangelog ? '\n- Keep changelog version as literal "x" (the release workflow substitutes the actual version number)' : ''}
- Max 3 review iterations to prevent infinite loops
- Report clearly if something fails
- Parse repo owner/name from \`gh repo view --json owner,name\``;
}

export default function GitTab({ appId: _appId, appName, repoPath }) {
  const [gitInfo, setGitInfo] = useState(null);
  const [diff, setDiff] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [loading, setLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [branchComparison, setBranchComparison] = useState(null);
  const [updating, setUpdating] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);
  const [branches, setBranches] = useState([]);
  const [checkingOut, setCheckingOut] = useState(null);
  const [pushing, setPushing] = useState(null);
  const [syncing, setSyncing] = useState(null);
  const [pushingAll, setPushingAll] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState([]);
  const [_defaultBranch, setDefaultBranch] = useState('main');
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  const loadGitInfo = useCallback(async () => {
    if (!repoPath) return;
    setLoading(true);
    const [info, branchesResult] = await Promise.all([
      api.getGitInfo(repoPath).catch(() => null),
      api.getBranches(repoPath).catch(() => ({ branches: [] }))
    ]);
    let comparison = null;
    if (info?.baseBranch && info?.devBranch) {
      comparison = await api.getBranchComparison(repoPath, info.baseBranch, info.devBranch).catch(() => null);
    }
    setGitInfo(info);
    setBranches(branchesResult.branches || []);
    setBranchComparison(comparison);
    setLoading(false);
  }, [repoPath]);

  const loadRemoteBranches = useCallback(async () => {
    if (!repoPath) return;
    setLoadingRemote(true);
    const result = await api.getRemoteBranches(repoPath).catch(() => null);
    if (result) {
      setRemoteBranches(result.branches || []);
      setDefaultBranch(result.defaultBranch || 'main');
    }
    setLoadingRemote(false);
  }, [repoPath]);

  useEffect(() => {
    loadGitInfo();
    loadRemoteBranches();
  }, [loadGitInfo, loadRemoteBranches]);

  const loadDiff = async () => {
    if (!repoPath) return;
    const result = await api.getGitDiff(repoPath).catch(() => ({ diff: '' }));
    setDiff(result.diff || '');
    setShowDiff(true);
  };

  const handleStage = async (file) => {
    await api.stageFiles(repoPath, [file]);
    await loadGitInfo();
  };

  const handleUnstage = async (file) => {
    await api.unstageFiles(repoPath, [file]);
    await loadGitInfo();
  };

  const handleCommit = async () => {
    if (!commitMessage.trim()) return;
    setCommitting(true);
    await api.createCommit(repoPath, commitMessage).catch(() => null);
    setCommitMessage('');
    setCommitting(false);
    await loadGitInfo();
  };

  const handleUpdateBranches = async () => {
    if (!repoPath) return;
    setUpdating(true);
    const result = await api.updateBranches(repoPath).catch(() => null);
    setUpdating(false);
    if (result) {
      const parts = [];
      for (const [key, val] of Object.entries(result)) {
        if (key !== 'stashed' && key !== 'stashRestored' && key !== 'currentBranch' && val) {
          parts.push(`${key}: ${val}`);
        }
      }
      if (result.stashed) parts.push(result.stashRestored ? 'stash restored' : 'stash conflict');
      toast.success(`Branches updated — ${parts.join(', ')}`);
    }
    await loadGitInfo();
  };

  const handleReleasePR = async () => {
    if (!branchComparison || branchComparison.ahead === 0) return;
    setShowReleaseConfirm(false);
    setReleasing(true);
    const prompt = buildReleasePrompt({
      repoPath,
      appName,
      comparison: branchComparison,
      baseBranch: gitInfo?.baseBranch || 'main',
      devBranch: gitInfo?.devBranch || 'dev',
      hasChangelog: gitInfo?.hasChangelog || false
    });
    const result = await api.addCosTask({
      description: prompt,
      context: `Release PR for ${appName}`,
      priority: 'high',
      autoApprove: true
    }).catch(() => null);
    setReleasing(false);
    if (result) {
      toast.success(`Release task queued for ${appName} — check CoS Agents tab`);
      await api.forceCosEvaluate().catch(() => null);
    }
  };

  const handleCheckout = async (branchName) => {
    if (!repoPath || checkingOut) return;
    setCheckingOut(branchName);
    const result = await api.checkoutBranch(repoPath, branchName).catch(() => null);
    setCheckingOut(null);
    if (result?.success) {
      toast.success(`Switched to ${branchName}`);
      await loadGitInfo();
    }
  };

  const handlePush = async (branchName) => {
    if (!repoPath || pushing) return;
    setPushing(branchName);
    const result = await api.pushBranch(repoPath, branchName).catch(() => null);
    setPushing(null);
    if (result?.success) {
      toast.success(`Pushed ${branchName}`);
      await loadGitInfo();
    }
  };

  const handleSync = async (branchName) => {
    if (!repoPath || syncing) return;
    setSyncing(branchName);
    const result = await api.syncBranch(repoPath, branchName).catch(() => null);
    setSyncing(null);
    if (result?.success) {
      toast.success(`Synced ${branchName}`);
      await loadGitInfo();
    } else if (result?.error) {
      toast.error(`Sync failed: ${result.error}`);
    }
  };

  const handlePushAll = async () => {
    if (!repoPath || pushingAll) return;
    setPushingAll(true);
    const result = await api.pushAllBranches(repoPath).catch(() => null);
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

  const handleDeleteBranch = async (branchName, { local, remote }) => {
    if (!repoPath || deleting) return;
    setDeleting(branchName);
    setDeleteConfirm(null);
    const result = await api.deleteBranch(repoPath, branchName, { local, remote }).catch((err) => {
      toast.error(`Delete failed: ${err.message}`);
      return null;
    });
    setDeleting(null);
    if (result) {
      const results = result.results || {};
      const parts = Object.entries(results).map(([k, v]) => `${k}: ${v}`);
      toast.success(`Branch ${branchName} — ${parts.join(', ')}`);
      const localDeleted = local && results.local === 'deleted';
      const remoteDeleted = remote && results.remote === 'deleted';
      if (localDeleted) {
        setBranches(prev => prev.filter(b => b.name !== branchName));
      }
      if (remoteDeleted) {
        setRemoteBranches(prev => prev.filter(b => b.name !== branchName));
      }
      if (localDeleted && !remoteDeleted) {
        setRemoteBranches(prev => prev.map(b =>
          b.name === branchName ? { ...b, hasLocal: false } : b
        ));
      }
      if (remoteDeleted && !localDeleted) {
        setBranches(prev => prev.map(b =>
          b.name === branchName
            ? { ...b, tracking: null, ahead: 0, behind: 0, hasRemote: false }
            : b
        ));
      }
    }
  };

  const getStatusIcon = (file) => {
    if (file.added) return <Plus size={14} className="text-port-success" />;
    if (file.deleted) return <Minus size={14} className="text-port-error" />;
    return <FileText size={14} className="text-port-warning" />;
  };

  if (!repoPath) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500">
        No repository path configured for this app
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Git Status</h2>
        <div className="flex items-center gap-2">
          {branches.some(b => b.tracking && b.ahead > 0) && (
            <button
              onClick={handlePushAll}
              disabled={pushingAll}
              className="flex items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-success disabled:opacity-50"
            >
              <Upload size={16} className={pushingAll ? 'animate-bounce' : ''} />
              {pushingAll ? 'Pushing...' : 'Push'}
            </button>
          )}
          <button
            onClick={handleUpdateBranches}
            disabled={updating}
            className="flex items-center gap-1.5 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-gray-300 hover:text-white hover:border-port-accent disabled:opacity-50"
          >
            <Download size={16} className={updating ? 'animate-bounce' : ''} />
            {updating ? 'Updating...' : 'Update'}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-8"><BrailleSpinner text="Loading git info" /></div>
      ) : gitInfo && gitInfo.isRepo ? (
        <div className="space-y-6">
          {/* Branch Comparison / Release Status */}
          {branchComparison && branchComparison.ahead > 0 && (
            <div className="bg-port-card border border-port-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <h3 className="text-sm font-medium text-gray-400">Release Status</h3>
                  <span className="text-xs font-medium text-port-accent px-2 py-0.5 bg-port-accent/20 rounded">
                    {branchComparison.ahead} ahead of {gitInfo?.baseBranch || 'main'}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-400">
                  <span className="text-port-success">+{branchComparison.stats.insertions}</span>
                  <span className="text-port-error">-{branchComparison.stats.deletions}</span>
                  <span>{branchComparison.stats.files} files</span>
                </div>
              </div>

              <div className="space-y-1.5 max-h-48 overflow-auto mb-4">
                {branchComparison.commits.map((commit, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <code className="text-xs text-port-accent shrink-0">{commit.hash}</code>
                    <span className="text-gray-300 truncate">{commit.message}</span>
                  </div>
                ))}
              </div>

              {gitInfo.devBranch && gitInfo.branch === gitInfo.devBranch && (
                <button
                  onClick={() => setShowReleaseConfirm(true)}
                  disabled={releasing}
                  className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm disabled:opacity-50"
                >
                  <Rocket size={16} />
                  {releasing ? 'Creating Release Task...' : 'Create Release PR'}
                </button>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Status Panel */}
            <div className="space-y-4">
              {/* Branch Info */}
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <GitBranch size={18} className="text-port-accent" />
                  <span className="font-medium text-white">{gitInfo.branch}</span>
                  {gitInfo.status?.clean && (
                    <span className="text-xs text-port-success px-2 py-0.5 bg-port-success/20 rounded">Clean</span>
                  )}
                </div>
                <div className="flex gap-4 text-sm">
                  <div className="text-gray-400">
                    <span className="text-port-success">+{gitInfo.diffStats?.insertions || 0}</span>
                    <span className="mx-1">/</span>
                    <span className="text-port-error">-{gitInfo.diffStats?.deletions || 0}</span>
                  </div>
                  <div className="text-gray-500">
                    {gitInfo.diffStats?.files || 0} files changed
                  </div>
                </div>
              </div>

              {/* Changed Files */}
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-400">Changed Files</h3>
                  <button
                    onClick={loadDiff}
                    className="text-xs text-port-accent hover:underline"
                  >
                    View Diff
                  </button>
                </div>
                <div className="space-y-1 max-h-64 overflow-auto">
                  {gitInfo.status?.files?.map((file, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm py-1 group">
                      {getStatusIcon(file)}
                      <span className={`flex-1 font-mono text-xs ${file.staged ? 'text-port-success' : 'text-gray-300'}`}>
                        {file.path}
                      </span>
                      <span className="text-xs text-gray-500">{file.status}</span>
                      {file.staged ? (
                        <button
                          onClick={() => handleUnstage(file.path)}
                          className="opacity-0 group-hover:opacity-100 text-xs text-gray-400 hover:text-white"
                        >
                          Unstage
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStage(file.path)}
                          className="opacity-0 group-hover:opacity-100 text-xs text-gray-400 hover:text-white"
                        >
                          Stage
                        </button>
                      )}
                    </div>
                  ))}
                  {(!gitInfo.status?.files || gitInfo.status.files.length === 0) && (
                    <div className="text-gray-500 text-sm">No changes</div>
                  )}
                </div>
              </div>

              {/* Quick Commit */}
              {gitInfo.status?.staged > 0 && (
                <div className="bg-port-card border border-port-border rounded-xl p-4">
                  <h3 className="text-sm font-medium text-gray-400 mb-2">Quick Commit</h3>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      placeholder="Commit message..."
                      className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                    />
                    <button
                      onClick={handleCommit}
                      disabled={committing || !commitMessage.trim()}
                      className="px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg text-sm disabled:opacity-50"
                    >
                      Commit
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Recent Commits */}
            <div className="space-y-4">
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Commits</h3>
                <div className="space-y-2">
                  {gitInfo.recentCommits?.map((commit, i) => (
                    <div key={i} className="py-2 border-b border-port-border last:border-0">
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-port-accent">{commit.hash}</code>
                        <span className="text-sm text-white truncate">{commit.message}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {commit.author} • {new Date(commit.date).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                  {(!gitInfo.recentCommits || gitInfo.recentCommits.length === 0) && (
                    <div className="text-gray-500 text-sm">No commits</div>
                  )}
                </div>
              </div>

              {/* Local Branches */}
              <div className="bg-port-card border border-port-border rounded-xl p-4">
                <h3 className="text-sm font-medium text-gray-400 mb-3">Local Branches</h3>
                <div className="space-y-2 max-h-64 overflow-auto">
                  {branches.map((branch) => (
                    <div
                      key={branch.name}
                      className={`flex items-center justify-between py-2 px-2 rounded-lg ${branch.current ? 'bg-port-accent/10 border border-port-accent/30' : 'hover:bg-port-bg'}`}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {branch.current ? (
                          <Check size={14} className="text-port-accent shrink-0" />
                        ) : (
                          <GitBranch size={14} className="text-gray-500 shrink-0" />
                        )}
                        <span className={`text-sm truncate ${branch.current ? 'text-port-accent font-medium' : 'text-gray-300'}`}>
                          {branch.name}
                        </span>
                        {branch.tracking && (
                          <span className="text-xs text-gray-500 shrink-0">
                            {branch.ahead > 0 && <span className="text-port-success">+{branch.ahead}</span>}
                            {branch.ahead > 0 && branch.behind > 0 && ' / '}
                            {branch.behind > 0 && <span className="text-port-warning">-{branch.behind}</span>}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!branch.current && (
                          <button
                            onClick={() => handleCheckout(branch.name)}
                            disabled={checkingOut === branch.name}
                            className="p-1.5 text-gray-400 hover:text-white hover:bg-port-bg rounded disabled:opacity-50"
                            title="Checkout"
                          >
                            {checkingOut === branch.name ? (
                              <RefreshCw size={14} className="animate-spin" />
                            ) : (
                              <Check size={14} />
                            )}
                          </button>
                        )}
                        {branch.tracking && branch.ahead > 0 && (
                          <button
                            onClick={() => handlePush(branch.name)}
                            disabled={pushing === branch.name}
                            className="p-1.5 text-gray-400 hover:text-port-success hover:bg-port-bg rounded disabled:opacity-50"
                            title="Push"
                          >
                            {pushing === branch.name ? (
                              <RefreshCw size={14} className="animate-spin" />
                            ) : (
                              <Upload size={14} />
                            )}
                          </button>
                        )}
                        {branch.tracking && (
                          <button
                            onClick={() => handleSync(branch.name)}
                            disabled={syncing === branch.name}
                            className="p-1.5 text-gray-400 hover:text-port-accent hover:bg-port-bg rounded disabled:opacity-50"
                            title="Sync (pull & push)"
                          >
                            {syncing === branch.name ? (
                              <RefreshCw size={14} className="animate-spin" />
                            ) : (
                              <ArrowUpDown size={14} />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {branches.length === 0 && (
                    <div className="text-gray-500 text-sm">No branches found</div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Remote Branches */}
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Globe size={16} className="text-gray-400" />
                <h3 className="text-sm font-medium text-gray-400">Remote Branches</h3>
                {remoteBranches.length > 0 && (
                  <span className="text-xs text-gray-500">({remoteBranches.length})</span>
                )}
              </div>
              <button
                onClick={loadRemoteBranches}
                disabled={loadingRemote}
                className="text-xs text-port-accent hover:underline disabled:opacity-50"
              >
                {loadingRemote ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            {loadingRemote && remoteBranches.length === 0 ? (
              <div className="text-center py-4"><BrailleSpinner text="Loading remote branches" /></div>
            ) : (
              <div className="space-y-1.5 max-h-80 overflow-auto">
                {remoteBranches.map((rb) => (
                  <div
                    key={rb.fullRef}
                    className={`flex items-center justify-between py-2 px-2 rounded-lg hover:bg-port-bg ${rb.isDefault ? 'bg-port-accent/5' : ''}`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <GitBranch size={14} className={rb.isDefault ? 'text-port-accent shrink-0' : 'text-gray-500 shrink-0'} />
                      <span className={`text-sm truncate ${rb.isDefault ? 'text-port-accent font-medium' : 'text-gray-300'}`}>
                        {rb.name}
                      </span>
                      {rb.merged && !rb.isDefault && (
                        <span className="flex items-center gap-1 text-xs text-port-success px-1.5 py-0.5 bg-port-success/10 rounded shrink-0">
                          <GitMerge size={10} />
                          merged
                        </span>
                      )}
                      {rb.hasLocal && (
                        <span className="text-xs text-gray-500 shrink-0">local</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {rb.lastCommitDate && (
                        <span className="text-xs text-gray-500">
                          {new Date(rb.lastCommitDate).toLocaleDateString()}
                        </span>
                      )}
                      {!rb.isDefault && (
                        <>
                          {deleteConfirm === rb.name ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleDeleteBranch(rb.name, { local: rb.hasLocal, remote: true })}
                                disabled={deleting === rb.name}
                                className="px-2 py-1 text-xs bg-port-error/20 text-port-error rounded hover:bg-port-error/30 disabled:opacity-50"
                              >
                                {deleting === rb.name ? 'Deleting...' : rb.hasLocal ? 'Delete both' : 'Delete remote'}
                              </button>
                              {rb.hasLocal && (
                                <button
                                  onClick={() => handleDeleteBranch(rb.name, { local: false, remote: true })}
                                  disabled={deleting === rb.name}
                                  className="px-2 py-1 text-xs bg-port-warning/20 text-port-warning rounded hover:bg-port-warning/30 disabled:opacity-50"
                                >
                                  Remote only
                                </button>
                              )}
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-2 py-1 text-xs text-gray-400 hover:text-white"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirm(rb.name)}
                              className="p-1.5 text-gray-500 hover:text-port-error hover:bg-port-bg rounded"
                              title="Delete branch"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
                {remoteBranches.length === 0 && !loadingRemote && (
                  <div className="text-gray-500 text-sm">No remote branches found</div>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500">
          {gitInfo ? 'Not a git repository' : 'Unable to load git status'}
        </div>
      )}

      {/* Diff Modal */}
      {showDiff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDiff(false)}>
          <div className="bg-port-card border border-port-border rounded-xl w-3/4 max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-port-border">
              <h3 className="font-medium text-white">Git Diff</h3>
              <button onClick={() => setShowDiff(false)} className="text-gray-400 hover:text-white">×</button>
            </div>
            <pre className="p-4 overflow-auto max-h-[70vh] text-sm font-mono">
              {diff.split('\n').map((line, i) => {
                let color = 'text-gray-300';
                if (line.startsWith('+') && !line.startsWith('+++')) color = 'text-port-success';
                if (line.startsWith('-') && !line.startsWith('---')) color = 'text-port-error';
                if (line.startsWith('@@')) color = 'text-port-accent';
                return <div key={i} className={color}>{line}</div>;
              })}
              {!diff && <span className="text-gray-500">No changes to display</span>}
            </pre>
          </div>
        </div>
      )}

      {/* Release Confirmation Dialog */}
      {showReleaseConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowReleaseConfirm(false)}>
          <div className="bg-port-card border border-port-border rounded-xl w-full max-w-lg overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-port-border">
              <h3 className="font-medium text-white flex items-center gap-2">
                <Rocket size={18} className="text-port-accent" />
                Create Release PR for {appName}
              </h3>
              <button onClick={() => setShowReleaseConfirm(false)} className="text-gray-400 hover:text-white">×</button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm text-gray-300">
                This will create a CoS agent task to automate the full release workflow:
              </p>
              <ul className="text-sm text-gray-400 space-y-1.5 ml-4 list-disc">
                <li>Push local commits to origin/{gitInfo?.devBranch || 'dev'}</li>
                {gitInfo?.hasChangelog && <li>Check and update the changelog</li>}
                <li>Create PR from {gitInfo?.devBranch || 'dev'} to {gitInfo?.baseBranch || 'main'}</li>
                <li>Wait for Copilot review and address feedback</li>
                <li>Merge when approved and CI passes</li>
              </ul>
              <p className="text-xs text-gray-500">
                {branchComparison?.ahead || 0} commits will be included in this release.
              </p>
            </div>
            <div className="flex justify-end gap-3 p-4 border-t border-port-border">
              <button
                onClick={() => setShowReleaseConfirm(false)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleReleasePR}
                className="flex items-center gap-2 px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm"
              >
                <Rocket size={16} />
                Start Release
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
