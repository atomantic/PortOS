import { useNavigate, useParams } from 'react-router-dom';
import { Mail, RefreshCw, Settings, MessageSquare } from 'lucide-react';
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
import IMessageTab from '../components/messages/IMessageTab';

// Exported for the nav-manifest tab-coverage guard (server/lib/navManifest.test.js).
// `fullBleed: true` — tab owns internal scroll/height; Messages skips padded overflow wrapper.
export const TABS = [
  { id: 'inbox', label: 'Inbox', icon: Mail },
  { id: 'drafts', label: 'Drafts', icon: Mail },
  { id: 'imessage', label: 'iMessage', icon: MessageSquare, fullBleed: true },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'config', label: 'Config', icon: Settings },
];

const FULL_BLEED_TAB_IDS = new Set(TABS.filter((t) => t.fullBleed).map((t) => t.id));

export default function Messages() {
  const navigate = useNavigate();
  const { chatKey } = useParams();
  const activeTab = useValidTab(TABS, 'inbox');
  const fullBleed = FULL_BLEED_TAB_IDS.has(activeTab);
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

  // Deep-link cleanup: only the imessage tab uses :chatKey. Drop a stale second
  // segment if the user lands on e.g. /messages/inbox/<something>.
  useEffect(() => {
    if (chatKey && activeTab !== 'imessage') {
      navigate(`/messages/${activeTab}`, { replace: true });
    }
  }, [chatKey, activeTab, navigate]);

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
      case 'imessage':
        return <IMessageTab />;
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
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={Mail}
        title="Messages"
        subtitle="Unified email and messaging management"
        actions={<span className="text-sm text-gray-500">{accounts.length} accounts</span>}
      />

      <TabPills tabs={TABS} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Messages sections" />

      <div className={`flex-1 min-h-0 ${fullBleed ? 'overflow-hidden' : 'overflow-auto p-4'}`}>
        {renderTabContent()}
      </div>
    </div>
  );
}
