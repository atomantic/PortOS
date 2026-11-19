import { Suspense, useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarDays, Calendar as CalendarIcon, ClipboardList, Clock, Columns, LayoutGrid, RefreshCw, Settings } from 'lucide-react';
import * as api from '../services/api';
import { useSocketResource } from '../hooks/useSocketResource';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { formatCount } from '../utils/formatters';
import { useValidTab } from '../hooks/useValidTab';
import useUrlParams from '../hooks/useUrlParams';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';
import { buildPageNavTabs } from '../lib/pageNavTabs.js';
import { lazyWithReload } from '../utils/lazyWithReload';

const AgendaTab = lazyWithReload(() => import('../components/calendar/AgendaTab'));
const DayView = lazyWithReload(() => import('../components/calendar/DayView'));
const WeekView = lazyWithReload(() => import('../components/calendar/WeekView'));
const MonthView = lazyWithReload(() => import('../components/calendar/MonthView'));
const ConfigTab = lazyWithReload(() => import('../components/calendar/ConfigTab'));
const ReviewTab = lazyWithReload(() => import('../components/calendar/ReviewTab'));
const CalendarLifetimeTab = lazyWithReload(() => import('../components/meatspace/tabs/CalendarTab'));
const SyncTab = lazyWithReload(() => import('../components/calendar/SyncTab'));

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

const CALENDAR_EVENTS = ['calendar:changed'];

const fetchAccountList = async () => {
  const data = await api.getCalendarAccounts({ silent: true });
  if (!Array.isArray(data)) throw new Error('Invalid calendar accounts response');
  return data;
};

export const TABS = buildPageNavTabs(getPageNavTabs('calendar'), TAB_PRESENTATION, 'Calendar');

export default function Calendar() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'agenda');
  const [searchParams] = useUrlParams();
  // This persistent boundary owns read failures; avoid a second toast layer.
  const { data: accounts, loading, error, refetch: fetchAccounts, updateData: updateAccounts } = useSocketResource(fetchAccountList, { events: CALENDAR_EVENTS });
  const accountsError = error != null;
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    await fetchAccounts();
    setRetrying(false);
  };
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
        return <ConfigTab accounts={accounts} setAccounts={updateAccounts} />;
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
              : `${formatCount(accounts.length)} ${accounts.length === 1 ? 'account' : 'accounts'}${accountsReady ? '' : ' (last loaded)'}`}
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
              onClick={retry}
              disabled={retrying}
              className="mt-3 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 disabled:opacity-50"
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          </div>
        )}
        {activeTab === 'lifetime' || accountsReady ? (
          <Suspense fallback={<PageSkeleton header="none" label="Loading calendar view" cards={3} sidebar={false} />}>
            {renderTabContent()}
          </Suspense>
        ) : (
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
