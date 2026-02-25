import { useState, useEffect, useMemo, useCallback } from 'react';
import { Trash2, Search, X, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import AgentCard from './AgentCard';
import ResumeAgentModal from './ResumeAgentModal';

export default function AgentsTab({ agents, onRefresh, liveOutputs, providers, apps }) {
  const [resumingAgent, setResumingAgent] = useState(null);
  const [durations, setDurations] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Date-based lazy loading for completed agents
  const [dateBuckets, setDateBuckets] = useState([]); // [{ date, count }, ...]
  const [loadedAgents, setLoadedAgents] = useState([]); // agents loaded so far
  const [loadedDates, setLoadedDates] = useState(new Set()); // dates already fetched
  const [loadingMore, setLoadingMore] = useState(false);

  // Fetch duration estimates for progress indicators
  useEffect(() => {
    api.getCosLearningDurations().then(setDurations).catch(() => {});
  }, []);

  // Fetch date buckets on mount and auto-load the most recent date
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await api.getCosAgentDates().catch(() => ({ dates: [] }));
      if (cancelled) return;
      const dates = result.dates || [];
      setDateBuckets(dates);

      // Auto-load the most recent date
      if (dates.length > 0) {
        const firstDate = dates[0].date;
        const agents = await api.getCosAgentsByDate(firstDate).catch(() => []);
        if (cancelled) return;
        setLoadedAgents(agents);
        setLoadedDates(new Set([firstDate]));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLoadMore = useCallback(async () => {
    // Find next unloaded date
    const nextDate = dateBuckets.find(d => !loadedDates.has(d.date));
    if (!nextDate) return;

    setLoadingMore(true);
    const agents = await api.getCosAgentsByDate(nextDate.date).catch(() => []);
    setLoadedAgents(prev => [...prev, ...agents]);
    setLoadedDates(prev => new Set([...prev, nextDate.date]));
    setLoadingMore(false);
  }, [dateBuckets, loadedDates]);

  const handleKill = async (agentId) => {
    await api.killCosAgent(agentId).catch(err => toast.error(err.message));
    toast.success('Agent force killed');
    onRefresh();
  };

  const handleDelete = useCallback(async (agentId) => {
    await api.deleteCosAgent(agentId).catch(err => toast.error(err.message));
    setLoadedAgents(prev => {
      const deleted = prev.find(a => a.id === agentId);
      if (deleted?.completedAt) {
        const dateStr = deleted.completedAt.slice(0, 10);
        setDateBuckets(buckets => buckets.map(d =>
          d.date === dateStr ? { ...d, count: Math.max(0, d.count - 1) } : d
        ).filter(d => d.count > 0));
      }
      return prev.filter(a => a.id !== agentId);
    });
    toast.success('Agent removed');
    onRefresh();
  }, [onRefresh]);

  const handleResumeClick = (agent) => {
    setResumingAgent(agent);
  };

  const handleResumeSubmit = async ({ description, context, model, provider, app, type = 'user' }) => {
    await api.addCosTask({
      description,
      context,
      model: model || undefined,
      provider: provider || undefined,
      app: app || undefined,
      type
    }).catch(err => {
      toast.error(err.message);
      return;
    });
    toast.success(`Created ${type === 'internal' ? 'system ' : ''}resume task`);
    setResumingAgent(null);
    onRefresh();
  };

  const handleClearCompleted = async () => {
    await api.clearCompletedCosAgents().catch(err => toast.error(err.message));
    setLoadedAgents([]);
    setLoadedDates(new Set());
    setDateBuckets([]);
    toast.success('Cleared completed agents');
    onRefresh();
  };

  // Running agents come from props (real-time via parent socket updates)
  const runningAgents = agents.filter(a => a.status === 'running');
  // Completed agents still in state (recently completed, not yet archived)
  const recentCompleted = agents.filter(a => a.status === 'completed');
  // Merge recent completed (from state) with loaded (from disk), deduplicate
  const allCompleted = useMemo(() => {
    const seen = new Set();
    const merged = [];
    // Recent state-based agents first (freshest data)
    for (const a of recentCompleted) {
      if (!seen.has(a.id)) { seen.add(a.id); merged.push(a); }
    }
    // Then disk-loaded agents
    for (const a of loadedAgents) {
      if (!seen.has(a.id)) { seen.add(a.id); merged.push(a); }
    }
    return merged.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  }, [recentCompleted, loadedAgents]);

  const totalCount = useMemo(() => {
    const indexTotal = dateBuckets.reduce((sum, d) => sum + d.count, 0);
    // Add any recent completed agents from state that may not yet be indexed
    const stateOnlyCount = recentCompleted.filter(a =>
      !loadedAgents.some(la => la.id === a.id)
    ).length;
    return indexTotal + stateOnlyCount;
  }, [dateBuckets, recentCompleted, loadedAgents]);

  const filteredCompleted = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return allCompleted;
    return allCompleted.filter(a => {
      const description = (a.metadata?.taskDescription || '').toLowerCase();
      const model = (a.metadata?.model || '').toLowerCase();
      const id = (a.id || '').toLowerCase();
      const error = (a.result?.error || '').toLowerCase();
      return description.includes(q) || model.includes(q) || id.includes(q) || error.includes(q);
    });
  }, [allCompleted, searchQuery]);

  const hasMoreDates = dateBuckets.some(d => !loadedDates.has(d.date));
  const remainingCount = dateBuckets
    .filter(d => !loadedDates.has(d.date))
    .reduce((sum, d) => sum + d.count, 0);

  return (
    <div className="space-y-6">
      {/* Active Agents */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-white">Active Agents</h3>
          {runningAgents.length > 0 && (
            <span className="text-sm text-port-accent animate-pulse">
              {runningAgents.length} running
            </span>
          )}
        </div>
        {runningAgents.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No active agents. Start CoS and add tasks to see agents working.
          </div>
        ) : (
          <div className="space-y-2">
            {runningAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onKill={handleKill}
                liveOutput={liveOutputs[agent.id]}
                durations={durations}
              />
            ))}
          </div>
        )}
      </div>

      {/* Completed Agents */}
      {(totalCount > 0 || recentCompleted.length > 0) && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-white">
              Completed Agents
              <span className="text-sm text-gray-500 font-normal ml-2">
                ({totalCount} total)
              </span>
            </h3>
            <button
              onClick={handleClearCompleted}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-port-error transition-colors"
              aria-label="Clear all completed agents"
            >
              <Trash2 size={14} aria-hidden="true" />
              Clear
            </button>
          </div>
          {/* Search */}
          <div className="flex gap-2 mb-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search loaded agents..."
                className="w-full bg-port-card border border-port-border rounded-lg pl-9 pr-4 py-2 min-h-[40px] text-white text-sm placeholder-gray-500 focus:border-port-accent outline-none"
              />
            </div>
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="px-3 py-2 min-h-[40px] min-w-[40px] flex items-center justify-center bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
                aria-label="Clear search"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>
          {searchQuery && (
            <div className="text-xs text-gray-500 mb-2">
              {filteredCompleted.length} of {allCompleted.length} loaded agents match
            </div>
          )}
          <div className="space-y-2">
            {filteredCompleted.map(agent => (
              <AgentCard key={agent.id} agent={agent} completed onDelete={handleDelete} onResume={handleResumeClick} onFeedbackChange={onRefresh} />
            ))}
            {!searchQuery && hasMoreDates && (
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full py-2 text-sm text-port-accent hover:text-white bg-port-card border border-port-border rounded-lg transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
              >
                {loadingMore ? (
                  'Loading...'
                ) : (
                  <>
                    <ChevronDown size={14} />
                    Load older agents ({remainingCount} remaining)
                  </>
                )}
              </button>
            )}
            {searchQuery && filteredCompleted.length === 0 && (
              <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
                No loaded agents match "{searchQuery}"
                {hasMoreDates && (
                  <div className="mt-2 text-xs">
                    {remainingCount} agents in older dates not yet loaded
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resume Modal */}
      {resumingAgent && (
        <ResumeAgentModal
          agent={resumingAgent}
          taskType={resumingAgent.taskId?.startsWith('sys-') || resumingAgent.metadata?.taskType === 'internal' ? 'internal' : 'user'}
          providers={providers}
          apps={apps}
          onSubmit={handleResumeSubmit}
          onClose={() => setResumingAgent(null)}
        />
      )}
    </div>
  );
}
