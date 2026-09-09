import { useNavigate, useParams } from 'react-router';
import { Mail, RefreshCw, Settings, MessageSquare, MessageCircle, Users } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { useValidTab } from '../hooks/useValidTab';
import { useInstanceFeatures } from '../hooks/useInstanceFeatures.js';
import { filterNavByFeatures } from '../lib/navFeatures.js';

import InboxTab from '../components/messages/InboxTab';
import ConfigTab from '../components/messages/ConfigTab';
import DraftsTab from '../components/messages/DraftsTab';
import SyncTab from '../components/messages/SyncTab';
import IMessageTab from '../components/messages/IMessageTab';
import SignalTab from '../components/messages/SignalTab';
import BeeperTab from '../components/messages/BeeperTab';
import ContactsTab from '../components/messages/ContactsTab';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';

// Presentation per tab id. The manifest (`tabGroup: 'messages'`) owns
// id/label/order — this page owns how each tab looks and behaves.
// `fullBleed: true` — tab owns internal scroll/height; Messages skips padded overflow wrapper.
// `needsAccounts: true` — tab renders the account list, so it waits for that fetch.
// `recordParam: true` — tab uses the shared `/messages/:tab/:chatKey` second
// segment to carry ITS open record in the URL (iMessage a chat key, Beeper a
// conversation id). Declared here rather than as a hardcoded tab name below, so
// a third tab that deep-links a record does not have to be remembered twice.
// `feature` is NOT declared here: it rides through from the manifest entry via
// `getPageNavTabs`, so the pill and the sidebar gate on one field.
// Throws at import time if the manifest and this map drift.
const TAB_PRESENTATION = {
  inbox: { icon: Mail, needsAccounts: true },
  drafts: { icon: Mail, needsAccounts: true },
  imessage: { icon: MessageSquare, fullBleed: true, recordParam: true },
  signal: { icon: MessageSquare },
  beeper: { icon: MessageCircle, fullBleed: true, recordParam: true },
  contacts: { icon: Users },
  sync: { icon: RefreshCw, needsAccounts: true },
  config: { icon: Settings, needsAccounts: true },
};

export const TABS = buildPageNavTabs(getPageNavTabs('messages'), TAB_PRESENTATION, 'Messages');

const FULL_BLEED_TAB_IDS = new Set(TABS.filter((t) => t.fullBleed).map((t) => t.id));
const RECORD_PARAM_TAB_IDS = new Set(TABS.filter((t) => t.recordParam).map((t) => t.id));

// iMessage and Contacts read no account data, so gating them on the accounts
// fetch would only serialize their own requests behind an unrelated one and
// flash a skeleton for nothing. Derived from TABS so a new tab declares its
// own need rather than having to be remembered in a second list.
const ACCOUNT_TAB_IDS = new Set(TABS.filter((t) => t.needsAccounts).map((t) => t.id));

export default function Messages() {
  const navigate = useNavigate();
  const { chatKey } = useParams();
  const activeTab = useValidTab(TABS, 'inbox');
  const fullBleed = FULL_BLEED_TAB_IDS.has(activeTab);
  // Gate the Beeper pill on the instance feature the same way the sidebar does
  // (#30): the route stays live for a direct link/bookmark/voice nav, but the
  // tab strip itself must not offer a way to navigate to a disabled feature.
  const { isFeatureEnabled } = useInstanceFeatures();
  const visibleTabs = filterNavByFeatures(TABS, isFeatureEnabled);
  // `null` = the account list never loaded (request failed) — deliberately distinct
  // from `[]`, which means "loaded, and there genuinely are no accounts". The inbox
  // empty state branches on that difference to avoid telling a user to add an
  // account they already have (#3281).
  const [accounts, setAccounts] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    const data = await api.getMessageAccounts().catch(() => null);
    setAccounts(Array.isArray(data) ? data : null);
    setLoading(false);
  }, []);

  // Tabs that only iterate accounts want a plain array; the load-failed sentinel
  // is forwarded to the inbox alone, which is the one surface that acts on it.
  const accountList = accounts || [];

  // ConfigTab mutates the list with functional updaters — normalize the sentinel
  // so `prev` is always an array there.
  const updateAccounts = useCallback((updater) => {
    setAccounts(prev => (typeof updater === 'function' ? updater(prev || []) : updater));
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Deep-link cleanup: only the tabs that declare `recordParam` use the shared
  // :chatKey segment. Drop a stale second segment if the user lands on e.g.
  // /messages/inbox/<something>.
  useEffect(() => {
    if (chatKey && !RECORD_PARAM_TAB_IDS.has(activeTab)) {
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
        return <ConfigTab accounts={accountList} setAccounts={updateAccounts} />;
      case 'drafts':
        return <DraftsTab accounts={accountList} />;
      case 'sync':
        return <SyncTab accounts={accountList} onRefresh={fetchAccounts} />;
      case 'imessage':
        return <IMessageTab />;
      case 'signal':
        return <SignalTab />;
      case 'beeper':
        return <BeeperTab />;
      case 'contacts':
        return <ContactsTab />;
      default:
        return <InboxTab accounts={accounts} />;
    }
  };

  if (loading && ACCOUNT_TAB_IDS.has(activeTab)) {
    return (
      <PageSkeleton
        header="bar"
        label="Loading messages"
        fullHeight
        // Full-bleed tabs (iMessage) render edge to edge — no body padding.
        padded={!fullBleed}
        bodyClassName="p-4"
        titleWidthClass="w-36"
        showSubtitle
        tabs={visibleTabs.length}
        cards={3}
        sidebar={false}
      />
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <PageHeader
        icon={Mail}
        title="Messages"
        subtitle="Unified email and messaging management"
        // #35 real-browser pass: this counts the email-style provider accounts
        // (Gmail/Outlook/Teams — `api.getMessageAccounts()`) that Inbox/Drafts/
        // Sync/Config act on. It is unrelated to Beeper's own account roster
        // (`beeper_accounts`, shown inside its own settings drawer) or to any
        // other bridge tab's accounts, so it read "0 accounts" while the Beeper
        // mirror held nine — correct for what it measures, misleading shown on
        // a tab it says nothing about. Scope it to the tabs that actually use
        // this fetch, same `ACCOUNT_TAB_IDS` gate the loading skeleton already
        // keys off, rather than teaching it a second "accounts" meaning.
        actions={loading || !ACCOUNT_TAB_IDS.has(activeTab) ? null : (
          <span className="text-sm text-gray-500">
            {accounts === null ? 'Accounts unavailable' : `${accounts.length} accounts`}
          </span>
        )}
      />

      <TabPills tabs={visibleTabs} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Messages sections" />

      <div className={`flex-1 min-h-0 ${fullBleed ? 'overflow-hidden' : 'overflow-auto p-4'}`}>
        {renderTabContent()}
      </div>
    </div>
  );
}
