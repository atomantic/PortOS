import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import * as api from '../../services/api';
import { AGENT_DETAIL_TABS } from './constants';
import OverviewTab from './tabs/OverviewTab';
import ToolsTab from './tabs/ToolsTab';
import PublishedTab from './tabs/PublishedTab';
import SchedulesTab from './tabs/SchedulesTab';
import ActivityTab from './tabs/ActivityTab';

export default function AgentDetail() {
  const { agentId, tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'overview';

  const [agent, setAgent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const fetchAgent = useCallback(async () => {
    const data = await api.getAgentPersonality(agentId).catch(() => null);
    if (!data) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setAgent(data);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchAgent();
  }, [fetchAgent]);

  // Redirect bare /agents/:id to /agents/:id/overview
  useEffect(() => {
    if (!tab && agentId) {
      navigate(`/agents/${agentId}/overview`, { replace: true });
    }
  }, [tab, agentId, navigate]);

  const handleToggle = async () => {
    await api.toggleAgentPersonality(agent.id, !agent.enabled);
    fetchAgent();
  };

  if (loading) {
    return <div className="p-6 text-gray-400">Loading agent...</div>;
  }

  if (notFound) {
    return (
      <div className="p-6 text-center">
        <p className="text-lg text-gray-400 mb-4">Agent not found</p>
        <Link to="/agents" className="text-port-accent hover:text-port-accent/80">
          Back to Agents
        </Link>
      </div>
    );
  }

  const renderTab = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab agentId={agentId} agent={agent} onAgentUpdate={fetchAgent} />;
      case 'tools':
        return <ToolsTab agentId={agentId} />;
      case 'published':
        return <PublishedTab agentId={agentId} />;
      case 'schedules':
        return <SchedulesTab agentId={agentId} />;
      case 'activity':
        return <ActivityTab agentId={agentId} />;
      default:
        return <OverviewTab agentId={agentId} agent={agent} onAgentUpdate={fetchAgent} />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-port-border px-6 py-4">
        <div className="flex items-center gap-4">
          <Link
            to="/agents"
            className="p-1.5 text-gray-400 hover:text-white transition-colors rounded hover:bg-port-border/50"
          >
            <ArrowLeft size={20} />
          </Link>
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0"
            style={{ backgroundColor: agent.avatar?.color || '#3b82f6' }}
          >
            {agent.avatar?.emoji || '🤖'}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-white truncate">{agent.name}</h1>
            {agent.description && (
              <p className="text-sm text-gray-400 truncate">{agent.description}</p>
            )}
          </div>
          <button
            onClick={handleToggle}
            className={`px-3 py-1.5 text-sm rounded ${
              agent.enabled
                ? 'bg-port-success/20 text-port-success hover:bg-port-success/30'
                : 'bg-port-border text-gray-400 hover:bg-port-border/80'
            }`}
          >
            {agent.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </div>
      </div>

      {/* Sub-tab Navigation */}
      <div className="flex gap-1 px-4 py-2 border-b border-port-border bg-port-card/50">
        {AGENT_DETAIL_TABS.map(tabDef => {
          const isActive = activeTab === tabDef.id;
          return (
            <button
              key={tabDef.id}
              onClick={() => navigate(`/agents/${agentId}/${tabDef.id}`)}
              className={`px-4 py-2 rounded-t flex items-center gap-2 transition-colors ${
                isActive
                  ? 'bg-port-bg text-white border-t border-l border-r border-port-border -mb-px'
                  : 'text-gray-400 hover:text-white hover:bg-port-border/30'
              }`}
            >
              <span>{tabDef.icon}</span>
              <span>{tabDef.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto bg-port-bg">
        {renderTab()}
      </div>
    </div>
  );
}
