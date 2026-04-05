import { useState, useEffect, useRef } from 'react';
import { RefreshCw, ArrowUpCircle, GitBranch, ExternalLink, Check } from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';

export default function Submodules() {
  const [submodules, setSubmodules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updating, setUpdating] = useState(null);
  const batchUpdating = useRef(false);

  const loadSubmodules = async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    else setRefreshing(true);
    const data = await api.getSubmodules().catch(() => []);
    setSubmodules(data);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => { loadSubmodules(); }, []);

  const handleUpdate = async (subPath) => {
    setUpdating(subPath);
    const result = await api.updateSubmodule(subPath).catch(() => null);
    if (result?.success) {
      toast.success(`Updated ${subPath} to ${result.newCommit}`);
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
    const outdated = submodules.filter(s => s.behind > 0 || s.outOfSync || !s.initialized);
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

  if (loading) {
    return <div className="text-center py-8"><BrailleSpinner text="Loading submodules" /></div>;
  }

  const hasUpdates = submodules.some(s => s.behind > 0 || s.outOfSync || !s.initialized);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <h1 className="text-2xl font-bold text-white">Submodules</h1>
        <div className="flex gap-2">
          {hasUpdates && (
            <button
              onClick={handleUpdateAll}
              disabled={!!updating}
              className="px-3 sm:px-4 py-2 bg-port-success hover:bg-port-success/80 text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm sm:text-base"
            >
              <ArrowUpCircle size={16} />
              <span className="hidden sm:inline">Update All</span>
              <span className="sm:hidden">All</span>
            </button>
          )}
          <button
            onClick={() => loadSubmodules(false)}
            disabled={refreshing}
            className="px-3 sm:px-4 py-2 bg-port-card hover:bg-port-border text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 text-sm sm:text-base border border-port-border"
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
                    {!sub.initialized ? (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/20 text-gray-400 shrink-0">
                        not initialized
                      </span>
                    ) : sub.conflicted ? (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-port-error/20 text-port-error shrink-0">
                        merge conflict
                      </span>
                    ) : sub.outOfSync ? (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-port-warning/20 text-port-warning shrink-0">
                        out of sync
                      </span>
                    ) : sub.behind > 0 ? (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-port-warning/20 text-port-warning shrink-0">
                        {sub.behind} behind
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-port-success/20 text-port-success shrink-0 flex items-center gap-1">
                        <Check size={10} /> up to date
                      </span>
                    )}
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
                  {sub.url && (
                    <a
                      href={sub.url.replace(/\.git$/, '')}
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
                  disabled={!!updating || (!sub.behind && !sub.outOfSync && sub.initialized && !sub.conflicted)}
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
