import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import AgentCard from './AgentCard';
import ResumeAgentModal from './ResumeAgentModal';

export default function AgentsTab({ agents, onRefresh, liveOutputs, providers, apps }) {
  const [resumingAgent, setResumingAgent] = useState(null);

  const handleTerminate = async (agentId) => {
    await api.terminateCosAgent(agentId).catch(err => toast.error(err.message));
    toast.success('Terminate signal sent');
    onRefresh();
  };

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

  const handleResumeSubmit = async ({ description, context, model, provider, app }) => {
    await api.addCosTask({
      description,
      context,
      model: model || undefined,
      provider: provider || undefined,
      app: app || undefined
    }).catch(err => {
      toast.error(err.message);
      return;
    });
    toast.success('Created resume task');
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
                onTerminate={handleTerminate}
                onKill={handleKill}
                liveOutput={liveOutputs[agent.id]}
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
            >
              <Trash2 size={14} />
              Clear
            </button>
          </div>
          <div className="space-y-2">
            {completedAgents.slice(0, 15).map(agent => (
              <AgentCard key={agent.id} agent={agent} completed onDelete={handleDelete} onResume={handleResumeClick} />
            ))}
            {completedAgents.length > 15 && (
              <div className="text-center text-sm text-gray-500 py-2">
                + {completedAgents.length - 15} more completed agents
              </div>
            )}
          </div>
        </div>
      )}

      {/* Resume Modal */}
      {resumingAgent && (
        <ResumeAgentModal
          agent={resumingAgent}
          providers={providers}
          apps={apps}
          onSubmit={handleResumeSubmit}
          onClose={() => setResumingAgent(null)}
        />
      )}
    </div>
  );
}
