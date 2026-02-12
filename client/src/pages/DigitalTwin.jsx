import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { Heart, RefreshCw } from 'lucide-react';

import { TABS, getHealthColor, getHealthLabel } from '../components/digital-twin/constants';

import OverviewTab from '../components/digital-twin/tabs/OverviewTab';
import DocumentsTab from '../components/digital-twin/tabs/DocumentsTab';
import TestTab from '../components/digital-twin/tabs/TestTab';
import EnrichTab from '../components/digital-twin/tabs/EnrichTab';
import AccountsTab from '../components/digital-twin/tabs/AccountsTab';
import InterviewTab from '../components/digital-twin/tabs/InterviewTab';
import GenomeTab from '../components/digital-twin/tabs/GenomeTab';
import ImportTab from '../components/digital-twin/tabs/ImportTab';
import ExportTab from '../components/digital-twin/tabs/ExportTab';

export default function DigitalTwin() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'overview';

  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const [statusData, settingsData] = await Promise.all([
      api.getSoulStatus().catch(() => null),
      api.getSoulSettings().catch(() => null)
    ]);
    setStatus(statusData);
    setSettings(settingsData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleTabChange = (tabId) => {
    navigate(`/digital-twin/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'overview':
        return <OverviewTab status={status} settings={settings} onRefresh={fetchData} />;
      case 'documents':
        return <DocumentsTab onRefresh={fetchData} />;
      case 'test':
        return <TestTab onRefresh={fetchData} />;
      case 'enrich':
        return <EnrichTab onRefresh={fetchData} />;
      case 'accounts':
        return <AccountsTab />;
      case 'genome':
        return <GenomeTab />;
      case 'interview':
        return <InterviewTab onRefresh={fetchData} />;
      case 'import':
        return <ImportTab onRefresh={fetchData} />;
      case 'export':
        return <ExportTab onRefresh={fetchData} />;
      default:
        return <OverviewTab status={status} settings={settings} onRefresh={fetchData} />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between p-4 gap-3 border-b border-port-border">
        <div className="flex items-center gap-3">
          <Heart className="w-8 h-8 text-pink-500 flex-shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-white">Digital Twin</h1>
            <p className="text-sm text-gray-500">Identity scaffold for AI interactions</p>
          </div>
        </div>

        {/* Quick stats */}
        {status && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-gray-500">Health:</span>
              <span className={`font-medium ${getHealthColor(status.healthScore)}`}>
                {status.healthScore}% ({getHealthLabel(status.healthScore)})
              </span>
            </div>
            <span className="text-gray-500">
              {status.enabledDocuments}/{status.documentCount} docs
            </span>
            {status.lastTestRun && (
              <span className="text-gray-500">
                Last test: {Math.round(status.lastTestRun.score * 100)}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1 overflow-x-auto border-b border-port-border scrollbar-hide">
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          const isActive = activeTab === tabItem.id;
          return (
            <button
              key={tabItem.id}
              onClick={() => handleTabChange(tabItem.id)}
              className={`flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-medium transition-colors whitespace-nowrap min-h-[44px] border-b-2 -mb-px ${
                isActive
                  ? 'text-port-accent border-port-accent bg-port-accent/5'
                  : 'text-gray-400 border-transparent hover:text-white hover:bg-port-card'
              }`}
              role="tab"
              aria-selected={isActive}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="hidden sm:inline">{tabItem.label}</span>
              <span className="sr-only sm:hidden">{tabItem.label}</span>
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
