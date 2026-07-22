import { useNavigate } from 'react-router-dom';
import { CalendarDays, Calendar as CalendarIcon, ClipboardList, Clock, Columns, LayoutGrid, RefreshCw, Settings } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';
import PageSkeleton from '../components/ui/PageSkeleton';
import PageHeader from '../components/PageHeader';
import TabPills from '../components/ui/TabPills';
import { useValidTab } from '../hooks/useValidTab';

import AgendaTab from '../components/calendar/AgendaTab';
import DayView from '../components/calendar/DayView';
import WeekView from '../components/calendar/WeekView';
import MonthView from '../components/calendar/MonthView';
import ConfigTab from '../components/calendar/ConfigTab';
import ReviewTab from '../components/calendar/ReviewTab';
import CalendarLifetimeTab from '../components/meatspace/tabs/CalendarTab';
import SyncTab from '../components/calendar/SyncTab';

// Exported so the nav-manifest tab-coverage guard (server/lib/navManifest.test.js)
// can assert each tab round-trips to a NAV_COMMANDS path.
export const TABS = [
  { id: 'agenda', label: 'Agenda', icon: CalendarDays },
  { id: 'day', label: 'Day', icon: CalendarIcon },
  { id: 'week', label: 'Week', icon: Columns },
  { id: 'month', label: 'Month', icon: LayoutGrid },
  { id: 'lifetime', label: 'Lifetime', icon: Clock },
  { id: 'review', label: 'Review', icon: ClipboardList },
  { id: 'sync', label: 'Sync', icon: RefreshCw },
  { id: 'config', label: 'Config', icon: Settings }
];

export default function Calendar() {
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'agenda');
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
    navigate(`/calendar/${tabId}`);
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
        fullHeight
        padded
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
