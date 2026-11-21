import { useState } from 'react';
import { Rocket } from 'lucide-react';
import toast from '../../../ui/Toast';
import ConfirmModal from '../../../ui/ConfirmModal';
import { addCosTask, forceCosEvaluate } from '../../../../services/apiAgents.js';
import { buildReleasePrompt } from './releasePrompt';

// Dev-branch commits not yet on the base branch, and the confirm that queues a
// CoS agent to open, review and merge the release PR. Renders nothing until
// the dev branch is ahead.
export default function ReleaseStatusPanel({ appName, repoPath, gitInfo, branchComparison }) {
  const [releasing, setReleasing] = useState(false);
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);

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
    const result = await addCosTask({
      description: prompt,
      context: `Release PR for ${appName}`,
      priority: 'high',
      autoApprove: true
    }).catch(() => null);
    setReleasing(false);
    if (result) {
      toast.success(`Release task queued for ${appName} — check CoS Agents tab`);
      await forceCosEvaluate().catch(() => null);
    }
  };

  if (!branchComparison || !(branchComparison.ahead > 0)) return null;

  return (
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

      <ConfirmModal
        open={showReleaseConfirm}
        onClose={() => setShowReleaseConfirm(false)}
        titleId="git-release-modal-title"
        icon={<Rocket size={18} className="text-port-accent" />}
        title={`Create Release PR for ${appName}`}
        confirmLabel="Start Release"
        onConfirm={handleReleasePR}
      >
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
      </ConfirmModal>
    </div>
  );
}
