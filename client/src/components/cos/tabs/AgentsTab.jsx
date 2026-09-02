import { useState, useEffect, useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { Trash2, Search, X, ChevronDown, MessageSquare } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import AgentCard from './AgentCard';
import ResumeAgentModal from './ResumeAgentModal';
import RelaunchAgentModal from './RelaunchAgentModal';
import BrailleSpinner from '../../BrailleSpinner';
import InlineConfirmRow from '../../ui/InlineConfirmRow';

// What each `resumeAgent` outcome actually did (server modes, agentManagement.js).
// `already-active` and `superseded` deliberately queue NOTHING — the task is already
// in flight, or a later pause owns it — so an unmapped mode must NOT fall through to
// "created a resume task". The server's `created` flag decides that (see below); this
// map only supplies the specific wording.
const RESUME_MESSAGES = {
  requeued: 'Resumed — the paused task is queued on its preserved worktree',
  'already-active': 'Its task is already queued or running — nothing new was created',
  superseded: 'A later agent now holds this task paused — that pause was left intact',
};

// Only agents from a manually-filled task form ask for a rating — scheduled/
// autopilot runs (taskType 'internal') are already auto-evaluated by
// task-learning's success/failure tracking. See cosAgentFeedback.js.
const needsAgentFeedback = (agent) => {
  const isSystemAgent = agent.taskId?.startsWith('sys-') || agent.id?.startsWith('sys-');
  const isManualUserAgent = agent.metadata?.taskType === 'user';
  return !isSystemAgent && isManualUserAgent && !agent.feedback?.rating;
};

export default function AgentsTab({ agents, onRefresh, liveOutputs, providers, apps }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [resumingAgent, setResumingAgent] = useState(null);
  const [relaunchingAgent, setRelaunchingAgent] = useState(null);
  const [durations, setDurations] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [feedbackUpdates, setFeedbackUpdates] = useState({});
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Date-based lazy loading for completed agents
  const [dateBuckets, setDateBuckets] = useState([]); // [{ date, count }, ...]
  const [loadedAgents, setLoadedAgents] = useState([]); // agents loaded so far
  const [loadedDates, setLoadedDates] = useState(new Set()); // dates already fetched
  const [loadingMore, setLoadingMore] = useState(false);

  // Filter selection is URL-backed so actionable insights can open the exact
  // review queue and the filtered state remains bookmarkable/shareable.
  const feedbackFilter = searchParams.get('feedback') === 'needs-feedback' ? 'needs-feedback' : 'all';
  const setFeedbackFilter = useCallback((filter) => {
    const next = new URLSearchParams(searchParams);
    if (filter === 'needs-feedback') next.set('feedback', filter);
    else next.delete('feedback');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

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
    const result = await api.killCosAgent(agentId, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success('Agent force killed');
    onRefresh();
  };

  const handlePause = async (agentId) => {
    const result = await api.pauseCosAgent(agentId, 'Paused from CoS agent list', { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success('Agent paused');
    onRefresh();
  };

  const handleDelete = useCallback(async (agentId) => {
    const result = await api.deleteCosAgent(agentId, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
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

  // A stalled RUNNING agent (a CLI parked on a provider usage limit) moves to a
  // different provider/model in one step. The dialog owns the call and the
  // outcome message — see RelaunchAgentModal.
  const handleRelaunchClick = useCallback((agent) => setRelaunchingAgent(agent), []);

  const handleFeedbackChange = useCallback((updatedAgent) => {
    if (updatedAgent?.id && updatedAgent.feedback) {
      setFeedbackUpdates(prev => ({ ...prev, [updatedAgent.id]: updatedAgent.feedback }));
      setLoadedAgents(prev => prev.map(agent =>
        agent.id === updatedAgent.id ? { ...agent, feedback: updatedAgent.feedback } : agent
      ));
    }
    onRefresh();
  }, [onRefresh]);

  // A PAUSED agent resumes IN PLACE (see `resumeAgent` in agentManagement.js):
  // the server requeues that agent's own task on the worktree its run left behind.
  // A COMPLETED agent's task is long settled, so it still gets a fresh one.
  const handleResumeSubmit = async ({ description, context, model, provider, effort, app, type = 'user', screenshots }) => {
    const payload = {
      description,
      context,
      model: model || undefined,
      provider: provider || undefined,
      effort: effort || undefined,
      app: app || undefined,
      screenshots
    };
    const result = await (resumingAgent?.status === 'paused'
      ? api.resumeCosAgent(resumingAgent.id, payload, { silent: true })
      : api.addCosTask({ ...payload, type }, { silent: true })
    );
    // Errors propagate to the modal, which owns the failure toast and re-enables
    // its submit button — swallowing them here closed the dialog on failure and
    // left the user believing the resume was queued.
    // A resume that created nothing (`created: false`) never claims it did, even for
    // a mode this build has no wording for — the completed-agent branch above has no
    // `created` field at all and did queue a task, so it keeps the default.
    toast.success(RESUME_MESSAGES[result.mode]
      || (result.created === false ? 'Resumed — nothing new was queued' : `Created ${type === 'internal' ? 'system ' : ''}resume task`));
    setResumingAgent(null);
    onRefresh();
  };

  const handleClearCompleted = async () => {
    setConfirmingClear(false);
    const result = await api.clearCompletedCosAgents({ silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    setLoadedAgents([]);
    setLoadedDates(new Set());
    setDateBuckets([]);
    toast.success('Cleared completed agents');
    onRefresh();
  };

  // Running agents come from props (real-time via parent socket updates)
  const runningAgents = agents.filter(a => a.status === 'running');
  const pausedAgents = agents.filter(a => a.status === 'paused');
  // Completed agents still in state (recently completed, not yet archived)
  const recentCompleted = agents.filter(a => a.status === 'completed');
  // Merge recent completed (from state) with loaded (from disk), deduplicate
  const allCompleted = useMemo(() => {
    const seen = new Set();
    const merged = [];
    const addAgent = (agent) => {
      if (seen.has(agent.id)) return;
      seen.add(agent.id);
      const feedback = feedbackUpdates[agent.id];
      merged.push(feedback ? { ...agent, feedback } : agent);
    };
    // Recent state-based agents first (freshest data)
    for (const agent of recentCompleted) addAgent(agent);
    // Then disk-loaded agents
    for (const agent of loadedAgents) addAgent(agent);
    return merged.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  }, [recentCompleted, loadedAgents, feedbackUpdates]);

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
    return allCompleted.filter(a => {
      if (feedbackFilter === 'needs-feedback' && !needsAgentFeedback(a)) return false;
      if (!q) return true;
      const description = (a.metadata?.taskDescription || '').toLowerCase();
      const model = (a.metadata?.model || '').toLowerCase();
      const id = (a.id || '').toLowerCase();
      const error = (a.result?.error || '').toLowerCase();
      return description.includes(q) || model.includes(q) || id.includes(q) || error.includes(q);
    });
  }, [allCompleted, feedbackFilter, searchQuery]);

  const needsFeedbackCount = useMemo(
    () => allCompleted.filter(needsAgentFeedback).length,
    [allCompleted]
  );

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
                onPause={handlePause}
                onKill={handleKill}
                onRelaunch={handleRelaunchClick}
                liveOutput={liveOutputs[agent.id]}
                durations={durations}
              />
            ))}
          </div>
        )}
      </div>

      {/* Paused Agents */}
      {pausedAgents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-white">Paused Agents</h3>
            <span className="text-sm text-yellow-400">{pausedAgents.length} paused</span>
          </div>
          <div className="space-y-2">
            {pausedAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                paused
                onDelete={handleDelete}
                onResume={handleResumeClick}
                onFeedbackChange={handleFeedbackChange}
              />
            ))}
          </div>
        </div>
      )}

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
              onClick={() => setConfirmingClear(true)}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-port-error transition-colors"
              aria-label="Clear all completed agents"
            >
              <Trash2 size={14} aria-hidden="true" />
              Clear
            </button>
          </div>
          {confirmingClear && (
            <InlineConfirmRow
              className="mb-3"
              question={totalCount > 0
                ? `Clear ALL completed agents? This removes ${totalCount} agent record${totalCount === 1 ? '' : 's'} and cannot be undone.`
                : 'Clear ALL completed agents? This cannot be undone.'}
              confirmText="Clear all"
              confirmTitle="Confirm clear all completed agents"
              cancelTitle="Cancel clear"
              onConfirm={handleClearCompleted}
              onCancel={() => setConfirmingClear(false)}
            />
          )}
          <div className="flex items-center gap-2 mb-3" aria-label="Completed agent filters">
            <button
              type="button"
              onClick={() => setFeedbackFilter('all')}
              aria-pressed={feedbackFilter === 'all'}
              className={`px-3 py-1.5 min-h-[36px] rounded-lg text-xs transition-colors ${
                feedbackFilter === 'all'
                  ? 'bg-port-accent text-white'
                  : 'bg-port-card border border-port-border text-gray-400 hover:text-white'
              }`}
            >
              All loaded
            </button>
            <button
              type="button"
              onClick={() => setFeedbackFilter('needs-feedback')}
              disabled={needsFeedbackCount === 0 && feedbackFilter !== 'needs-feedback'}
              aria-label={`Needs feedback: ${needsFeedbackCount}`}
              aria-pressed={feedbackFilter === 'needs-feedback'}
              className={`flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-lg text-xs transition-colors disabled:opacity-50 ${
                feedbackFilter === 'needs-feedback'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-port-card border border-port-border text-gray-400 hover:text-white'
              }`}
            >
              <MessageSquare size={14} aria-hidden="true" />
              Needs feedback
              <span className="font-mono">{needsFeedbackCount}</span>
            </button>
            <span className="hidden sm:inline text-xs text-gray-600 ml-auto">
              Review completed work after its notification expires.
            </span>
          </div>
          {/* Search */}
          <div className="flex gap-2 mb-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" aria-hidden="true" />
              <input
                type="text"
                aria-label="Search completed agents"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search loaded agents..."
                className="w-full bg-port-card border border-port-border rounded-lg pl-9 pr-4 py-2 min-h-[40px] text-white text-sm placeholder-gray-500 focus:border-port-accent outline-hidden"
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
          {(searchQuery || feedbackFilter !== 'all') && (
            <div className="text-xs text-gray-500 mb-2">
              {filteredCompleted.length} of {allCompleted.length} loaded agents shown
            </div>
          )}
          <div className="space-y-2">
            {filteredCompleted.map(agent => (
              <AgentCard key={agent.id} agent={agent} completed onDelete={handleDelete} onResume={handleResumeClick} onFeedbackChange={handleFeedbackChange} />
            ))}
            {filteredCompleted.length === 0 && (feedbackFilter !== 'all' || searchQuery) && (
              <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
                {feedbackFilter === 'needs-feedback' && !searchQuery
                  ? 'All loaded agent runs have feedback.'
                  : `No loaded agents match "${searchQuery}"`}
                {hasMoreDates && (
                  <div className="mt-2 text-xs">
                    {remainingCount} agents in older dates not yet loaded
                  </div>
                )}
              </div>
            )}
            {!searchQuery && hasMoreDates && (
              <button
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="w-full py-2 text-sm text-port-accent hover:text-white bg-port-card border border-port-border rounded-lg transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
              >
                {loadingMore ? (
                  <BrailleSpinner text="Loading" />
                ) : (
                  <>
                    <ChevronDown size={14} />
                    Load older agents ({remainingCount} remaining)
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Relaunch Modal */}
      {relaunchingAgent && (
        <RelaunchAgentModal
          agent={relaunchingAgent}
          providers={providers}
          apps={apps}
          onDone={onRefresh}
          onClose={() => setRelaunchingAgent(null)}
        />
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
