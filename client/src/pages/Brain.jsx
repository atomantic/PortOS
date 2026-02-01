import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import { Brain as BrainIcon, RefreshCw } from 'lucide-react';

import {
  TABS,
  formatRelativeTime
} from '../components/brain/constants';

import InboxTab from '../components/brain/tabs/InboxTab';
import MemoryTab from '../components/brain/tabs/MemoryTab';
import DigestTab from '../components/brain/tabs/DigestTab';
import TrustTab from '../components/brain/tabs/TrustTab';
import ConfigTab from '../components/brain/tabs/ConfigTab';

export default function Brain() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'inbox';

  const [summary, setSummary] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const [summaryData, settingsData] = await Promise.all([
      api.getBrainSummary().catch(() => null),
      api.getBrainSettings().catch(() => null)
    ]);
    setSummary(summaryData);
    setSettings(settingsData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleTabChange = (tabId) => {
    navigate(`/brain/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'inbox':
        return <InboxTab onRefresh={fetchData} settings={settings} />;
      case 'memory':
        return <MemoryTab onRefresh={fetchData} />;
      case 'digest':
        return <DigestTab onRefresh={fetchData} />;
      case 'trust':
        return <TrustTab onRefresh={fetchData} />;
      case 'config':
        return <ConfigTab onRefresh={fetchData} />;
      default:
        return <InboxTab onRefresh={fetchData} settings={settings} />;
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
          <BrainIcon className="w-8 h-8 text-port-accent" />
          <div>
            <h1 className="text-xl font-bold text-white">Brain</h1>
            <p className="text-sm text-gray-500">Second brain for capturing and organizing thoughts</p>
          </div>
        </div>

        {/* Quick stats */}
        {summary && (
          <div className="flex items-center gap-4 text-sm">
            {summary.needsReview > 0 && (
              <span className="px-2 py-1 rounded bg-port-warning/20 text-port-warning">
                {summary.needsReview} needs review
              </span>
            )}
            <span className="text-gray-500">
              {summary.counts?.projects || 0} projects
            </span>
            <span className="text-gray-500">
              {summary.counts?.people || 0} people
            </span>
            {summary.lastDailyDigest && (
              <span className="text-gray-500">
                Last digest: {formatRelativeTime(summary.lastDailyDigest)}
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
