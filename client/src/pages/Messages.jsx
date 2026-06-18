import { useNavigate } from 'react-router-dom';
import { Mail, RefreshCw, Settings } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { useValidTab } from '../hooks/useValidTab';

import InboxTab from '../components/messages/InboxTab';
import ConfigTab from '../components/messages/ConfigTab';
import DraftsTab from '../components/messages/DraftsTab';
import SyncTab from '../components/messages/SyncTab';

// Exported for the nav-manifest tab-coverage guard (server/lib/navManifest.test.js).
export const TABS = [
  { id: 'inbox', label: 'Inbox', icon: Mail },
  { id: 'drafts', label: 'Drafts', icon: Mail },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'config', label: 'Config', icon: Settings }
];

export default function Messages() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'inbox');
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    const data = await api.getMessageAccounts().catch(() => []);
    setAccounts(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  const handleTabChange = (tabId) => {
    navigate(`/messages/${tabId}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'inbox':
        return <InboxTab accounts={accounts} />;
      case 'config':
        return <ConfigTab accounts={accounts} setAccounts={setAccounts} />;
      case 'drafts':
        return <DraftsTab accounts={accounts} />;
      case 'sync':
        return <SyncTab accounts={accounts} onRefresh={fetchAccounts} />;
      default:
        return <InboxTab accounts={accounts} />;
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
      <PageHeader
        icon={Mail}
        title="Messages"
        subtitle="Unified email and messaging management"
        actions={<span className="text-sm text-gray-500">{accounts.length} accounts</span>}
      />

      <TabPills tabs={TABS} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Messages sections" />

      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
