import { useNavigate } from 'react-router';
import { CalendarDays, Calendar as CalendarIcon, ClipboardList, Clock, Columns, LayoutGrid, RefreshCw, Settings } from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { formatCount } from '../utils/formatters';
import { useValidTab } from '../hooks/useValidTab';
import useUrlParams from '../hooks/useUrlParams';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';

import AgendaTab from '../components/calendar/AgendaTab';
import DayView from '../components/calendar/DayView';
import WeekView from '../components/calendar/WeekView';
import MonthView from '../components/calendar/MonthView';
import ConfigTab from '../components/calendar/ConfigTab';
import ReviewTab from '../components/calendar/ReviewTab';
import CalendarLifetimeTab from '../components/meatspace/tabs/CalendarTab';
import SyncTab from '../components/calendar/SyncTab';

// Icon (and any other presentation-only detail) per tab id. The manifest
// (`tabGroup: 'calendar'`) owns id/label/order — this page owns only how each
// tab looks. Throws at import time if the manifest and this map drift, so a
// new manifest tab can't ship silently unreachable from this page's tab bar.
const TAB_PRESENTATION = {
  agenda: { icon: CalendarDays },
  day: { icon: CalendarIcon },
  week: { icon: Columns },
  month: { icon: LayoutGrid },
  lifetime: { icon: Clock },
  review: { icon: ClipboardList },
  sync: { icon: RefreshCw },
  config: { icon: Settings },
};

export const TABS = buildPageNavTabs(getPageNavTabs('calendar'), TAB_PRESENTATION, 'Calendar');

export default function Calendar() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'agenda');
  const [searchParams] = useUrlParams();
  const [accounts, setAccounts] = useState(null);
  const [loading, setLoading] = useState(true);

  const [accountsError, setAccountsError] = useState(false);
  const requestGeneration = useRef(0);

  const fetchAccounts = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    // This persistent boundary owns read failures; avoid a second toast layer.
    await api.getCalendarAccounts({ silent: true }).then(data => {
      if (!Array.isArray(data)) throw new Error('Invalid calendar accounts response');
      if (generation !== requestGeneration.current) return;
      setAccounts(data);
      setAccountsError(false);
    }).catch(() => {
      if (generation === requestGeneration.current) setAccountsError(true);
    }).finally(() => {
      if (generation === requestGeneration.current) setLoading(false);
    });
  }, []);

  useEffect(() => {
    fetchAccounts();
    return () => { requestGeneration.current += 1; };
  }, [fetchAccounts]);

  const accountsReady = accounts !== null && !accountsError;

  const handleTabChange = (tabId) => {
    const query = searchParams.toString();
    navigate(`/calendar/${tabId}${query ? `?${query}` : ''}`);
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'agenda':
        return <AgendaTab accounts={accounts} />;
      case 'day':
        return <DayView accounts={accounts} />;
      case 'week':
        return <WeekView accounts={accounts} />;
      case 'month':
        return <MonthView accounts={accounts} />;
      case 'lifetime':
        return <CalendarLifetimeTab />;
      case 'review':
        return <ReviewTab accounts={accounts} />;
      case 'config':
        return <ConfigTab accounts={accounts} setAccounts={setAccounts} />;
      case 'sync':
        return <SyncTab accounts={accounts} onRefresh={fetchAccounts} />;
      default:
        return <AgendaTab accounts={accounts} />;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={CalendarDays}
        title="Calendar"
        subtitle="Unified calendar and event management"
        actions={
          <span className="text-sm text-gray-500">
            {accounts === null
              ? (loading ? 'Loading accounts…' : 'Accounts unavailable')
              : `${formatCount(accounts.length)} accounts${accountsReady ? '' : ' (last loaded)'}`}
          </span>
        }
      />

      <TabPills tabs={TABS} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Calendar sections" />

      <div className="flex-1 overflow-auto p-4">
        {accountsError && (
          <div role="alert" className="mb-4 p-4 bg-port-error/10 border border-port-error/30 rounded-lg">
            <p className="font-medium text-port-error">Calendar accounts unavailable</p>
            <p className="mt-1 text-sm text-gray-400">
              {accounts === null
                ? 'Could not load calendar accounts. Retry to view your calendars and configuration.'
                : 'Could not refresh calendar accounts. The last loaded snapshot is stale; sync and configuration actions are paused until Retry succeeds.'}
            </p>
            <button
              onClick={fetchAccounts}
              disabled={loading}
              className="mt-3 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 disabled:opacity-50"
            >
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}
        {activeTab === 'lifetime' || accountsReady ? renderTabContent() : (
          <>
            {loading && <PageSkeleton header="none" label="Loading calendar accounts" cards={3} sidebar={false} />}
            {accounts !== null && (
              <section aria-label="Last loaded calendar accounts" className="space-y-2">
                <h2 className="text-sm font-medium text-gray-400">Last loaded calendar accounts (read-only)</h2>
                <ul className="space-y-2">
                  {accounts.map(account => (
                    <li key={account.id} className="p-3 bg-port-card border border-port-border rounded-lg break-words">
                      {account.name}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
