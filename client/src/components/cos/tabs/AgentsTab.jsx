import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { Trash2, Search, X, MessageSquare } from 'lucide-react';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import AgentCard from './AgentCard';
import ResumeAgentModal from './ResumeAgentModal';
import RelaunchAgentModal from './RelaunchAgentModal';
import InfiniteScrollFooter from '../../ui/InfiniteScrollFooter';
import { usePagedCollection } from '../../../hooks/usePagedCollection';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { agentResumeMessage } from '../../../lib/agentResumeOutcome';
import { isAgentFeedbackEligible } from '../../../lib/cosAgentFeedback';
import { formatCount } from '../../../utils/formatters';

// What each `resumeAgent` outcome actually did (server modes, agentManagement.js).
// `already-active` and `superseded` deliberately queue NOTHING — the task is already
// in flight, or a later pause owns it — so they carry no `running` wording, and an
// unmapped mode must NOT fall through to "created a resume task". The server's
// `created` flag decides that (see below); this map only supplies the specific
// wording. `requeued` has both variants because the server force-spawns the resumed
// task when a slot is free — see `agentResumeMessage` for that contract.
const RESUME_MESSAGES = {
  requeued: {
    queued: 'Resumed — the paused task is queued on its preserved worktree',
    running: 'Resumed — the paused task is running again on its preserved worktree',
  },
  'new-task': {
    queued: 'Resumed — a replacement task is queued',
    running: 'Resumed — a replacement task is running',
  },
  'already-active': { queued: 'Its task is already queued or running — nothing new was created' },
  superseded: { queued: 'A later agent now holds this task paused — that pause was left intact' },
};

const needsAgentFeedback = isAgentFeedbackEligible;

export default function AgentsTab({ agentsLoaded = true, agentsError = null, onRetryAgents, completedRevision = 0, agents, onRefresh, liveOutputs, providers, providersLoaded, apps }) {
  const { agentId } = useParams();
  const [focusedAgent, setFocusedAgent] = useState(null);
  const [focusLoading, setFocusLoading] = useState(false);
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setFocusedAgent(null);
    setFocusLoading(true);
    api.getCosAgent(agentId, { silent: true }).then(agent => { if (!cancelled) setFocusedAgent(agent); })
      .catch(() => {}).finally(() => { if (!cancelled) setFocusLoading(false); });
    return () => { cancelled = true; };
  }, [agentId]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [resumingAgent, setResumingAgent] = useState(null);
  const [relaunchingAgent, setRelaunchingAgent] = useState(null);
  const [durations, setDurations] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [feedbackUpdates, setFeedbackUpdates] = useState({});

  const [pendingFeedbackCount, setPendingFeedbackCount] = useState(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Filter selection is URL-backed so actionable insights can open the exact
  // review queue and the filtered state remains bookmarkable/shareable.
  const feedbackFilter = searchParams.get('feedback') === 'needs-feedback' ? 'needs-feedback' : 'all';
  const setFeedbackFilter = useCallback((filter) => {
    const next = new URLSearchParams(searchParams);
    if (filter === 'needs-feedback') next.set('feedback', filter);
    else next.delete('feedback');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const fetchCompletedPage = useCallback(({ cursor, signal }) => api.getCosCompletedAgents({
    cursor, signal, limit: 25, feedback: feedbackFilter === 'needs-feedback', silent: true,
  }), [feedbackFilter]);
  const history = usePagedCollection(fetchCompletedPage);
  useEffect(() => { if (completedRevision) history.refreshFirst(); }, [completedRevision, history.refreshFirst]);
  const loadedAgents = history.items;
  const refresh = useCallback(() => { history.reload(); onRefresh(); }, [history.reload, onRefresh]);

  // Fetch duration estimates for progress indicators
  useEffect(() => {
    api.getCosLearningDurations().then(setDurations).catch(() => {});
  }, []);

  // The durable reference index is the bounded source of truth for feedback
  // actions. It brings older eligible runs into the filter without walking every
  // historical date bucket; the response uses the same predicate as the server
  // queue and supplies a count even when those cards are not otherwise loaded.
  useEffect(() => {
    let cancelled = false;
    api.getCosPendingAgentFeedback({ countOnly: true, silent: true })
      .then((result) => {
        if (cancelled) return;
        setPendingFeedbackCount(Number.isFinite(result?.count) ? result.count : null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleKill = async (agentId) => {
    const result = await api.killCosAgent(agentId, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success('Agent force killed');
    refresh();
  };

  const handlePause = async (agentId) => {
    const result = await api.pauseCosAgent(agentId, 'Paused from CoS agent list', { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success('Agent paused');
    refresh();
  };

  const handleDelete = useCallback(async (agentId) => {
    const result = await api.deleteCosAgent(agentId, { silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success('Agent removed');
    refresh();
  }, [refresh]);

  // ResumeAgentModal builds a NEW task prompt out of `metadata.taskDescription`,
  // and the listing carries a bounded copy of it (server/lib/cosAgentListProjection.js).
  // Hydrate BEFORE opening, or a long description would be resumed clipped —
  // silently, since the dialog shows exactly what it would send. The await costs
  // nothing for the >90% of runs the listing carried whole (no request is made),
  // and one small `?lines=1` read for the rest; opening on the preview and
  // swapping the text in later would leave a window where Submit ships the
  // clipped copy, which is the failure this exists to prevent.
  const handleResumeClick = useCallback(async (agent) => {
    setResumingAgent(await api.hydrateCosAgentDescription(agent));
  }, []);

  // A stalled RUNNING agent (a CLI parked on a provider usage limit) moves to a
  // different provider/model in one step. The dialog owns the call and the
  // outcome message — see RelaunchAgentModal. No hydration here: relaunch sends
  // provider/model/effort/app and a note, never the description, and the dialog
  // fetches the rest itself if the reader expands it.
  const handleRelaunchClick = useCallback((agent) => setRelaunchingAgent(agent), []);

  const handleFeedbackChange = useCallback((updatedAgent, previousAgent) => {
    if (updatedAgent?.id && updatedAgent.feedback) {
      setFeedbackUpdates(prev => ({ ...prev, [updatedAgent.id]: updatedAgent.feedback }));
    }
    if (needsAgentFeedback(previousAgent) && !needsAgentFeedback(updatedAgent)) {
      setPendingFeedbackCount(count => count == null ? count : Math.max(0, count - 1));
    }
  }, []);

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
    toast.success(agentResumeMessage(result, RESUME_MESSAGES,
      result.created === false ? 'Resumed — nothing new was queued' : `Created ${type === 'internal' ? 'system ' : ''}resume task`));
    setResumingAgent(null);
    refresh();
  };

  const handleClearCompleted = async () => {
    setConfirmingClear(false);
    const result = await api.clearCompletedCosAgents({ silent: true }).catch(err => { toast.error(err.message); return null; });
    if (!result) return;
    toast.success('Cleared completed agents');
    refresh();
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

  const totalCount = history.total ?? allCompleted.length;

  // Search runs over what the listing carries. `metadata.taskDescription` is
  // bounded at AGENT_LIST_DESCRIPTION_CHARS server-side, which leaves over 90% of
  // real records whole — only a pasted-prompt description is clipped, and its
  // opening 2000 characters are what a reader searches for anyway.
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

  const locallyVisibleNeedsFeedback = allCompleted.filter(needsAgentFeedback).length;
  // A completion can arrive through the live agent stream just after the
  // durable-index request resolves. Never let that race hide a newly actionable
  // run; the server count still carries older archived obligations that are not
  // in the currently loaded cards.
  const needsFeedbackCount = pendingFeedbackCount == null
    ? locallyVisibleNeedsFeedback
    : Math.max(pendingFeedbackCount, locallyVisibleNeedsFeedback);

  const selectedAgent = agents.find(agent => agent.id === agentId) || (focusedAgent?.id === agentId ? focusedAgent : null);

  return (
    <div className="space-y-6">
      {agentId && <section aria-label="Selected agent" className="space-y-2">
        <h3 className="text-lg font-semibold">Selected agent</h3>
        {selectedAgent ? <AgentCard key={agentId} agent={selectedAgent}
          initiallyExpanded liveOutput={liveOutputs[agentId]} completed={selectedAgent.status === 'completed'}
          paused={selectedAgent.status === 'paused'} durations={durations} onFeedbackChange={handleFeedbackChange}
          onPause={handlePause} onKill={handleKill} onResume={handleResumeClick} onDelete={handleDelete} onRelaunch={handleRelaunchClick} />
          : <p role="status">{focusLoading ? 'Loading agent…' : 'Agent not found or unavailable.'}</p>}
      </section>}
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
        {agentsError && (
          <div role="alert" className="mb-3 text-sm text-red-400">
            {agentsError} {agentsLoaded && 'Showing the last loaded agents.'}
            <button type="button" onClick={onRetryAgents || onRefresh} className="ml-2 underline">Retry agents</button>
          </div>
        )}
        {!agentsLoaded && !agentsError && <div role="status">Loading active agents…</div>}
        {runningAgents.length === 0 && agentsLoaded && !agentsError && (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No active agents. Start CoS and add tasks to see agents working.
          </div>
        )}
        {runningAgents.length > 0 && (
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
      {(totalCount > 0 || !history.loaded || history.error || history.hasMore || allCompleted.length > 0 || feedbackFilter !== 'all' || pendingFeedbackCount > 0) && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-white">
              Completed Agents
              <span className="text-sm text-gray-500 font-normal ml-2">
                ({formatCount(totalCount)} {history.total == null ? 'loaded' : 'total'})
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
              question="Clear ALL completed agents, including records outside the current filter and unloaded pages? This cannot be undone."
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
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[repeat(auto-fit,minmax(32rem,1fr))]">
            {filteredCompleted.map(agent => (
              <AgentCard key={agent.id} agent={agent} completed onDelete={handleDelete} onResume={handleResumeClick} onFeedbackChange={handleFeedbackChange} />
            ))}
            {filteredCompleted.length === 0 && (feedbackFilter !== 'all' || searchQuery) && (
              <div className="col-span-full bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
                {feedbackFilter === 'needs-feedback' && !searchQuery
                  ? 'All loaded agent runs have feedback.'
                  : `No loaded agents match "${searchQuery}"`}

              </div>
            )}
            <InfiniteScrollFooter hasMore={history.hasMore} loading={history.loading} error={history.error}
              onLoadMore={history.loadMore} autoLoad={!searchQuery} label="Load older agents" />
          </div>
        </div>
      )}

      {/* Relaunch Modal */}
      {relaunchingAgent && (
        <RelaunchAgentModal
          agent={relaunchingAgent}
          providers={providers}
          providersLoaded={providersLoaded}
          apps={apps}
          onDone={refresh}
          onClose={() => setRelaunchingAgent(null)}
        />
      )}

      {/* Resume Modal */}
      {resumingAgent && (
        <ResumeAgentModal
          agent={resumingAgent}
          taskType={resumingAgent.taskId?.startsWith('sys-') || resumingAgent.metadata?.taskType === 'internal' ? 'internal' : 'user'}
          providers={providers}
          providersLoaded={providersLoaded}
          apps={apps}
          onSubmit={handleResumeSubmit}
          onClose={() => setResumingAgent(null)}
        />
      )}
    </div>
  );
}
