import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import * as api from '../services/api';
import {Brain as BrainIcon} from 'lucide-react';
import BrailleSpinner from '../components/BrailleSpinner';

import { TABS } from '../components/brain/constants';
import { timeAgo } from '../utils/formatters';

import InboxTab from '../components/brain/tabs/InboxTab';
import LinksTab from '../components/brain/tabs/LinksTab';
import MemoryTab from '../components/brain/tabs/MemoryTab';
import BrainGraph from '../components/brain/tabs/BrainGraph';
import DigestTab from '../components/brain/tabs/DigestTab';
import FeedsTab from '../components/brain/tabs/FeedsTab';
import TrustTab from '../components/brain/tabs/TrustTab';
import NotesTab from '../components/brain/tabs/NotesTab';
import DailyLogTab from '../components/brain/tabs/DailyLogTab';
import ConfigTab from '../components/brain/tabs/ConfigTab';
import ImportTab from '../components/brain/tabs/ImportTab';

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
      case 'links':
        return <LinksTab onRefresh={fetchData} />;
      case 'memory':
        return <MemoryTab onRefresh={fetchData} />;
      case 'notes':
        return <NotesTab onRefresh={fetchData} />;
      case 'daily-log':
        return <DailyLogTab />;
      case 'graph':
        return <BrainGraph />;
      case 'digest':
        return <DigestTab onRefresh={fetchData} />;
      case 'feeds':
        return <FeedsTab onRefresh={fetchData} />;
      case 'trust':
        return <TrustTab onRefresh={fetchData} />;
      case 'import':
        return <ImportTab />;
      case 'config':
        return <ConfigTab onRefresh={fetchData} />;
      default:
        return <InboxTab onRefresh={fetchData} settings={settings} />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2 sm:p-4 border-b border-port-border">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <BrainIcon className="w-6 h-6 sm:w-8 sm:h-8 text-port-accent shrink-0" />
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-white leading-tight">Brain</h1>
            <p className="hidden sm:block text-sm text-gray-500">Second brain for capturing and organizing thoughts</p>
          </div>
        </div>

        {/* Quick stats — wrap on small screens; only "needs review" stays loud */}
        {summary && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm">
            {summary.needsReview > 0 && (
              <span className="px-2 py-0.5 rounded bg-port-warning/20 text-port-warning">
                {summary.needsReview} needs review
              </span>
            )}
            <span className="text-gray-500">
              {summary.counts?.links || 0} links
            </span>
            <span className="text-gray-500">
              {summary.counts?.projects || 0} projects
            </span>
            <span className="hidden sm:inline text-gray-500">
              {summary.counts?.people || 0} people
            </span>
            {summary.lastDailyDigest && (
              <span className="hidden md:inline text-gray-500">
                Last digest: {timeAgo(summary.lastDailyDigest)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Tab navigation — horizontal scroll on mobile, icon-only below sm */}
      <div className="flex border-b border-port-border overflow-x-auto">
        {TABS.map((tabItem) => {
          const Icon = tabItem.icon;
          const isActive = activeTab === tabItem.id;
          return (
            <button
              key={tabItem.id}
              onClick={() => handleTabChange(tabItem.id)}
              className={`shrink-0 flex items-center gap-2 px-3 sm:px-4 py-2 sm:py-3 text-sm font-medium min-h-[40px] transition-colors ${
                isActive
                  ? 'text-port-accent border-b-2 border-port-accent bg-port-accent/5'
                  : 'text-gray-400 hover:text-white hover:bg-port-card'
              }`}
              role="tab"
              aria-selected={isActive}
              aria-label={tabItem.label}
              title={tabItem.label}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="hidden sm:inline">{tabItem.label}</span>
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
