import { useParams, useNavigate } from 'react-router-dom';
import { Mail, RefreshCw, Settings } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import TabPills from '../components/ui/TabPills';

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
  const { tab } = useParams();
  const navigate = useNavigate();
  const VALID_TABS = TABS.map(t => t.id);
  const activeTab = VALID_TABS.includes(tab) ? tab : 'inbox';
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
      <div className="flex items-center justify-between p-4 border-b border-port-border">
        <div className="flex items-center gap-3">
          <Mail className="w-8 h-8 text-port-accent" />
          <div>
            <h1 className="text-xl font-bold text-white">Messages</h1>
            <p className="text-sm text-gray-500">Unified email and messaging management</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-500">{accounts.length} accounts</span>
        </div>
      </div>

      <TabPills tabs={TABS} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Messages sections" />

      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
