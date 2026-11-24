import { useState } from 'react';
import { GitBranch, Plus, Minus, FileText } from 'lucide-react';
import Modal from '../../../ui/Modal';
import { getGitDiff, stageFiles, unstageFiles } from '../../../../services/apiGit.js';

function StatusIcon({ file }) {
  if (file.added) return <Plus size={14} className="text-port-success" />;
  if (file.deleted) return <Minus size={14} className="text-port-error" />;
  return <FileText size={14} className="text-port-warning" />;
}

const ROW_ACTION_CLASS = 'opacity-100 [@media(hover:hover)]:sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 text-xs text-gray-400 hover:text-white';

// Current branch summary, the changed-file list with stage/unstage, and the
// working-tree diff dialog.
export default function GitStatusPanel({ repoPath, gitInfo, loadGitInfo }) {
  const [diffs, setDiffs] = useState([]);
  const [showDiff, setShowDiff] = useState(false);

  const loadDiff = async () => {
    if (!repoPath) return;
    // A failed read toasts and opens nothing: an empty dialog would say there are no changes.
    const results = await Promise.all([getGitDiff(repoPath, true), getGitDiff(repoPath)]).catch(() => null);
    if (!results) return;
    setDiffs(['Staged', 'Not staged'].map((label, i) => ({ label, diff: results[i].diff })).filter(({ diff }) => diff));
    setShowDiff(true);
  };

  // A failure is toasted by the request; the reload shows what the index holds now.
  const handleStage = async (file) => {
    await stageFiles(repoPath, [file.path]).catch(() => null);
    await loadGitInfo();
  };

  const handleUnstage = async (file) => {
    await unstageFiles(repoPath, file.origPath ? [file.path, file.origPath] : [file.path]).catch(() => null);
    await loadGitInfo();
  };

  return (
    <>
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
              <StatusIcon file={file} />
              <span className={`flex-1 font-mono text-xs ${file.staged ? 'text-port-success' : 'text-gray-300'}`}>
                {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
              </span>
              <span className="text-xs text-gray-500">{file.status}</span>
              {file.staged && (
                <button
                  onClick={() => handleUnstage(file)}
                  className={ROW_ACTION_CLASS}
                >
                  Unstage
                </button>
              )}
              {(!file.staged || file.modified) && (
                <button
                  onClick={() => handleStage(file)}
                  className={ROW_ACTION_CLASS}
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

      <Modal
        open={showDiff}
        onClose={() => setShowDiff(false)}
        size="none"
        align="none"
        backdropClassName="bg-black/50"
        panelClassName="bg-port-card border border-port-border rounded-xl w-3/4 overflow-hidden"
        ariaLabelledBy="git-diff-modal-title"
      >
        <div className="flex items-center justify-between p-4 border-b border-port-border">
          <h3 id="git-diff-modal-title" className="font-medium text-white">Git Diff</h3>
          <button onClick={() => setShowDiff(false)} aria-label="Close" className="text-gray-400 hover:text-white min-h-[44px] min-w-[44px] flex items-center justify-center">×</button>
        </div>
        <pre className="p-4 overflow-auto max-h-[70vh] text-sm font-mono">
          {diffs.map(({ label, diff }) => (
            <div key={label}>
              <div className="text-gray-400">{label}</div>
              {diff.split('\n').map((line, i) => {
                let color = 'text-gray-300';
                if (line.startsWith('+') && !line.startsWith('+++')) color = 'text-port-success';
                if (line.startsWith('-') && !line.startsWith('---')) color = 'text-port-error';
                if (line.startsWith('@@')) color = 'text-port-accent';
                return <div key={i} className={color}>{line}</div>;
              })}
            </div>
          ))}
          {diffs.length === 0 && <span className="text-gray-500">No changes to display</span>}
        </pre>
      </Modal>
    </>
  );
}
