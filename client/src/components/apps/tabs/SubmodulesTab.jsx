import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, ArrowUpCircle, GitBranch, ExternalLink, Check, GitCommit } from 'lucide-react';
import toast from '../../ui/Toast';
import Pill from '../../ui/Pill';
import ToggleSwitch from '../../ToggleSwitch';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';
import { parseRepoUrl, repoBrowseUrl } from '../../../lib/repoUrl';

/** Whether a submodule's pointer differs from what its remote default branch has. */
const needsUpdate = (sub) => sub.behind > 0 || sub.outOfSync || !sub.initialized || sub.conflicted;

/**
 * Browsable URL for a submodule's remote. `.gitmodules` commonly declares the
 * scp-style SSH form (`git@github.com:owner/repo`), which is not a link a
 * browser can follow — normalize it rather than href-ing it raw. Host-generic:
 * a gitlab.com submodule earns the same link.
 */
function repoHref(url) {
  const parsed = parseRepoUrl(url || '');
  if (parsed) return repoBrowseUrl(parsed);
  return /^https?:\/\//i.test(url || '') ? url.replace(/\.git$/, '') : null;
}

/** The status badge a submodule's pointer state earns. `Pill` has no error tone. */
function StatusPill({ sub }) {
  if (!sub.initialized) return <Pill className="shrink-0">not initialized</Pill>;
  if (sub.conflicted) {
    return (
      <Pill tone="bare" className="shrink-0 text-port-error bg-port-error/10 border-port-error/20">
        merge conflict
      </Pill>
    );
  }
  if (sub.outOfSync) return <Pill tone="warning" className="shrink-0">out of sync</Pill>;
  if (sub.behind > 0) return <Pill tone="warning" className="shrink-0">{sub.behind} behind</Pill>;
  return <Pill tone="success" icon={Check} className="shrink-0">up to date</Pill>;
}

/**
 * Git submodules for one managed app's repo. Lists each submodule's pointer vs
 * its remote default branch, updates it, and (when "Commit after update" is on)
 * has the server commit the pointer bump on the repo's default branch.
 */
export default function SubmodulesTab({ repoPath }) {
  const [submodules, setSubmodules] = useState([]);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(null);
  const [commitAfterUpdate, setCommitAfterUpdate] = useState(true);
  const batchUpdating = useRef(false);

  const loadSubmodules = useCallback(async (showSpinner = true) => {
    if (!repoPath) return;
    if (showSpinner) setLoading(true);
    else setRefreshing(true);
    // One call carries both the list and the branch a commit would land on, so
    // the toggle names the same branch the server's commit guard checks.
    const data = await api.getSubmodules(repoPath, { silent: true }).catch(() => null);
    setSubmodules(data?.submodules || []);
    if (data?.defaultBranch) setDefaultBranch(data.defaultBranch);
    setLoading(false);
    setRefreshing(false);
  }, [repoPath]);

  useEffect(() => { loadSubmodules(); }, [loadSubmodules]);

  const handleUpdate = async (subPath) => {
    setUpdating(subPath);
    const result = await api
      .updateSubmodule(subPath, { repoPath, commit: commitAfterUpdate, silent: true })
      .catch(() => null);
    if (result?.success) {
      // The note comes from the server's own outcome, not from the toggle — the
      // toggle can be flipped mid-batch, and only the server knows what it did.
      toast.success(`Updated ${subPath} to ${result.newCommit}${result.commitNote ? ` — ${result.commitNote}` : ''}`);
      setSubmodules(prev => prev.map(s =>
        s.path === subPath
          ? { ...s, currentCommit: result.newCommit, behind: 0, outOfSync: false, initialized: true, conflicted: false }
          : s
      ));
    } else {
      toast.error(`Failed to update ${subPath}`);
    }
    if (!batchUpdating.current) setUpdating(null);
  };

  const handleUpdateAll = async () => {
    const outdated = submodules.filter(needsUpdate);
    if (outdated.length === 0) {
      toast.success('All submodules are up to date');
      return;
    }
    batchUpdating.current = true;
    for (const sub of outdated) {
      await handleUpdate(sub.path);
    }
    batchUpdating.current = false;
    setUpdating(null);
  };

  if (!repoPath) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-gray-400">
        This app has no repo path configured.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <BrailleSpinner text="Loading submodules" />
      </div>
    );
  }

  const hasUpdates = submodules.some(needsUpdate);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <ToggleSwitch
            size="sm"
            enabled={commitAfterUpdate}
            onChange={() => setCommitAfterUpdate(v => !v)}
            ariaLabel={`Commit submodule updates on ${defaultBranch}`}
          />
          <GitCommit size={14} className="text-port-accent shrink-0" />
          <span>
            Commit the pointer bump on <span className="font-mono text-gray-400">{defaultBranch}</span> after updating
          </span>
        </div>
        <div className="flex gap-2">
          {hasUpdates && (
            <button
              onClick={handleUpdateAll}
              disabled={!!updating}
              className="px-3 sm:px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm min-h-[40px]"
            >
              <ArrowUpCircle size={16} />
              <span className="hidden sm:inline">Update All</span>
              <span className="sm:hidden">All</span>
            </button>
          )}
          <button
            onClick={() => loadSubmodules(false)}
            disabled={refreshing}
            className="px-3 sm:px-4 py-2 bg-port-card hover:bg-port-border text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm border border-port-border min-h-[40px]"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {submodules.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center text-gray-400">
          No git submodules found in this repository.
        </div>
      ) : (
        <div className="grid gap-4">
          {submodules.map(sub => (
            <div key={sub.path} className="bg-port-card border border-port-border rounded-lg p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <GitBranch size={16} className="text-port-accent shrink-0" />
                    <h3 className="text-lg font-semibold text-white truncate">{sub.name}</h3>
                    <StatusPill sub={sub} />
                  </div>
                  <p className="text-sm text-gray-400 font-mono truncate">{sub.path}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
                    <span>Current: <span className="font-mono text-gray-400">{sub.currentCommit}</span></span>
                    {sub.latestCommit && (
                      <span>Latest: <span className="font-mono text-gray-400">{sub.latestCommit}</span></span>
                    )}
                  </div>
                  {sub.latestMessage && (
                    <p className="text-sm text-gray-400 mt-1 truncate">{sub.latestMessage}</p>
                  )}
                  {repoHref(sub.url) && (
                    <a
                      href={repoHref(sub.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline mt-1"
                    >
                      <ExternalLink size={10} /> Repository
                    </a>
                  )}
                </div>
                <button
                  onClick={() => handleUpdate(sub.path)}
                  disabled={!!updating || !needsUpdate(sub)}
                  className="px-3 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm shrink-0 min-h-[40px]"
                >
                  {updating === sub.path ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <ArrowUpCircle size={14} />
                  )}
                  {updating === sub.path ? 'Updating...' : 'Update'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
