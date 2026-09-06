import { useNavigate } from 'react-router';
import { CalendarDays, Calendar as CalendarIcon, ClipboardList, Clock, Columns, LayoutGrid, RefreshCw, Settings } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { useValidTab } from '../hooks/useValidTab';
import useUrlParams from '../hooks/useUrlParams';
import { getPageNavTabs } from '../../../server/lib/navManifest.js';

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

export const TABS = getPageNavTabs('calendar').map((tab) => {
  const presentation = TAB_PRESENTATION[tab.id];
  if (!presentation) throw new Error(`Calendar: no tab presentation for manifest tab "${tab.id}"`);
  return { ...tab, ...presentation };
});

export default function Calendar() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'agenda');
  const [searchParams] = useUrlParams();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchAccounts = useCallback(async () => {
    const data = await api.getCalendarAccounts().catch(() => []);
    setAccounts(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

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
        return <ReviewTab />;
      case 'config':
        return <ConfigTab accounts={accounts} setAccounts={setAccounts} />;
      case 'sync':
        return <SyncTab accounts={accounts} onRefresh={fetchAccounts} />;
      default:
        return <AgendaTab accounts={accounts} />;
    }
  };

  if (loading) {
    return (
      <PageSkeleton
        header="bar"
        label="Loading calendar"
        fullHeight
        padded
        bodyClassName="p-4"
        titleWidthClass="w-32"
        showSubtitle
        tabs={TABS.length}
        cards={3}
        sidebar={false}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={CalendarDays}
        title="Calendar"
        subtitle="Unified calendar and event management"
        actions={<span className="text-sm text-gray-500">{accounts.length} accounts</span>}
      />

      <TabPills tabs={TABS} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Calendar sections" />

      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
