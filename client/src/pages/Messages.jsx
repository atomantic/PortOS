import { useParams, useNavigate } from 'react-router-dom';
import { Mail, RefreshCw } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';

import InboxTab from '../components/messages/InboxTab';
import AccountsTab from '../components/messages/AccountsTab';
import DraftsTab from '../components/messages/DraftsTab';
import SyncTab from '../components/messages/SyncTab';

const TABS = [
  { id: 'inbox', label: 'Inbox', icon: Mail },
  { id: 'accounts', label: 'Accounts', icon: Mail },
  { id: 'drafts', label: 'Drafts', icon: Mail },
  { id: 'sync', label: 'Sync', icon: RefreshCw }
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
      case 'accounts':
        return <AccountsTab accounts={accounts} onRefresh={fetchAccounts} />;
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
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
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

      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
