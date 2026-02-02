import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import {
  TABS,
  PersonalitiesTab,
  AccountsTab,
  SchedulesTab,
  ActivityTab,
  ConfigTab
} from '../components/agents';

export default function Agents() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'personalities';

  const [stats, setStats] = useState({
    agents: 0,
    accounts: 0,
    schedules: 0
  });
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    const [agents, accounts, scheduleStats] = await Promise.all([
      api.getAgentPersonalities(),
      api.getPlatformAccounts(),
      api.getScheduleStats()
    ]);
    setStats({
      agents: agents.length,
      accounts: accounts.length,
      schedules: scheduleStats.total
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleTabChange = (tabId) => {
    navigate(`/agents/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'personalities':
        return <PersonalitiesTab onRefresh={fetchStats} />;
      case 'accounts':
        return <AccountsTab onRefresh={fetchStats} />;
      case 'schedules':
        return <SchedulesTab onRefresh={fetchStats} />;
      case 'activity':
        return <ActivityTab />;
      case 'config':
        return <ConfigTab />;
      default:
        return <PersonalitiesTab onRefresh={fetchStats} />;
    }
  };

  const getTabBadge = (tabId) => {
    if (loading) return null;
    switch (tabId) {
      case 'personalities':
        return stats.agents > 0 ? stats.agents : null;
      case 'accounts':
        return stats.accounts > 0 ? stats.accounts : null;
      case 'schedules':
        return stats.schedules > 0 ? stats.schedules : null;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-port-border px-6 py-4">
        <h1 className="text-2xl font-bold text-white">Agents</h1>
        <p className="text-sm text-gray-400 mt-1">
          Manage AI agent personalities and their platform automation
        </p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 px-4 py-2 border-b border-port-border bg-port-card/50">
        {TABS.map(tabDef => {
          const badge = getTabBadge(tabDef.id);
          const isActive = activeTab === tabDef.id;

          return (
            <button
              key={tabDef.id}
              onClick={() => handleTabChange(tabDef.id)}
              className={`px-4 py-2 rounded-t flex items-center gap-2 transition-colors ${
                isActive
                  ? 'bg-port-bg text-white border-t border-l border-r border-port-border -mb-px'
                  : 'text-gray-400 hover:text-white hover:bg-port-border/30'
              }`}
            >
              <span>{tabDef.icon}</span>
              <span>{tabDef.label}</span>
              {badge && (
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  isActive ? 'bg-port-accent text-white' : 'bg-port-border text-gray-300'
                }`}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto bg-port-bg">
        {renderTabContent()}
      </div>
    </div>
  );
}
