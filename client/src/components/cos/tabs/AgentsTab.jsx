import { useState, useEffect, useMemo } from 'react';
import { Trash2, Search, X } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import AgentCard from './AgentCard';
import ResumeAgentModal from './ResumeAgentModal';

export default function AgentsTab({ agents, onRefresh, liveOutputs, providers, apps }) {
  const [resumingAgent, setResumingAgent] = useState(null);
  const [durations, setDurations] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Fetch duration estimates for progress indicators
  useEffect(() => {
    api.getCosLearningDurations().then(setDurations).catch(() => {});
  }, []);

  const handleKill = async (agentId) => {
    await api.killCosAgent(agentId).catch(err => toast.error(err.message));
    toast.success('Agent force killed');
    onRefresh();
  };

  const handleDelete = async (agentId) => {
    await api.deleteCosAgent(agentId).catch(err => toast.error(err.message));
    toast.success('Agent removed');
    onRefresh();
  };

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
    toast.success('Cleared completed agents');
    onRefresh();
  };

  const runningAgents = agents.filter(a => a.status === 'running');
  // Sort completed agents by completion time (most recent first)
  const completedAgents = agents
    .filter(a => a.status === 'completed')
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));

  const filteredCompletedAgents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return completedAgents;
    return completedAgents.filter(a => {
      const description = (a.metadata?.taskDescription || '').toLowerCase();
      const model = (a.metadata?.model || '').toLowerCase();
      const id = (a.id || '').toLowerCase();
      const error = (a.result?.error || '').toLowerCase();
      return description.includes(q) || model.includes(q) || id.includes(q) || error.includes(q);
    });
  }, [completedAgents, searchQuery]);

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
      {completedAgents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-white">
              Completed Agents
              <span className="text-sm text-gray-500 font-normal ml-2">
                ({completedAgents.length} total)
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
                placeholder="Search completed agents..."
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
              {filteredCompletedAgents.length} of {completedAgents.length} agents match
            </div>
          )}
          <div className="space-y-2">
            {(searchQuery ? filteredCompletedAgents : filteredCompletedAgents.slice(0, 15)).map(agent => (
              <AgentCard key={agent.id} agent={agent} completed onDelete={handleDelete} onResume={handleResumeClick} onFeedbackChange={onRefresh} />
            ))}
            {!searchQuery && completedAgents.length > 15 && (
              <div className="text-center text-sm text-gray-500 py-2">
                + {completedAgents.length - 15} more completed agents
              </div>
            )}
            {searchQuery && filteredCompletedAgents.length === 0 && (
              <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
                No completed agents match "{searchQuery}"
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
