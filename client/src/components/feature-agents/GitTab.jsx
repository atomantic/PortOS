import { GitBranch, ExternalLink } from 'lucide-react';

export default function GitTab({ agent }) {
  const git = agent.git || {};

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-port-card border border-port-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <GitBranch size={16} className="text-port-accent" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Branch Info</h3>
        </div>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between py-2 border-b border-port-border">
            <span className="text-gray-500">Feature Branch</span>
            <span className="text-white font-mono">{git.branchName || 'not set'}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-port-border">
            <span className="text-gray-500">Base Branch</span>
            <span className="text-white font-mono">{git.baseBranch || 'main'}</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-port-border">
            <span className="text-gray-500">Auto Merge Base</span>
            <span className={git.autoMergeBase !== false ? 'text-port-success' : 'text-gray-500'}>
              {git.autoMergeBase !== false ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-port-border">
            <span className="text-gray-500">Auto PR</span>
            <span className={git.autoPR !== false ? 'text-port-success' : 'text-gray-500'}>
              {git.autoPR !== false ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-gray-500">Worktree Path</span>
            <span className="text-gray-400 font-mono text-xs">data/cos/feature-agents/{agent.id}/worktree</span>
          </div>
        </div>
      </div>

      {git.prTemplate && (
        <div className="bg-port-card border border-port-border rounded-xl p-5">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">PR Template</h3>
          <pre className="text-xs text-gray-400 bg-port-bg rounded p-3 overflow-auto whitespace-pre-wrap">{git.prTemplate}</pre>
        </div>
      )}
    </div>
  );
}
