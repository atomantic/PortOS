import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { Heart, RefreshCw } from 'lucide-react';

import { TABS, getHealthColor, getHealthLabel } from '../components/soul/constants';

import OverviewTab from '../components/soul/tabs/OverviewTab';
import DocumentsTab from '../components/soul/tabs/DocumentsTab';
import TestTab from '../components/soul/tabs/TestTab';
import EnrichTab from '../components/soul/tabs/EnrichTab';
import ExportTab from '../components/soul/tabs/ExportTab';

export default function Soul() {
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
    navigate(`/soul/${tabId}`);
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
      <div className="flex items-center justify-between p-4 border-b border-port-border">
        <div className="flex items-center gap-3">
          <Heart className="w-8 h-8 text-pink-500" />
          <div>
            <h1 className="text-xl font-bold text-white">Soul</h1>
            <p className="text-sm text-gray-500">Digital twin identity scaffold</p>
          </div>
        </div>

        {/* Quick stats */}
        {status && (
          <div className="flex items-center gap-4 text-sm">
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
      <div className="flex border-b border-port-border">
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          const isActive = activeTab === tabItem.id;
          return (
            <button
              key={tabItem.id}
              onClick={() => handleTabChange(tabItem.id)}
              className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? 'text-port-accent border-b-2 border-port-accent bg-port-accent/5'
                  : 'text-gray-400 hover:text-white hover:bg-port-card'
              }`}
              role="tab"
              aria-selected={isActive}
            >
              <Icon size={16} aria-hidden="true" />
              {tabItem.label}
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
