import { useParams, useNavigate } from 'react-router-dom';
import { CalendarDays, Calendar as CalendarIcon, ClipboardList, Clock, Columns, LayoutGrid, RefreshCw, Settings } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import TabPills from '../components/ui/TabPills';

import AgendaTab from '../components/calendar/AgendaTab';
import DayView from '../components/calendar/DayView';
import WeekView from '../components/calendar/WeekView';
import MonthView from '../components/calendar/MonthView';
import ConfigTab from '../components/calendar/ConfigTab';
import ReviewTab from '../components/calendar/ReviewTab';
import CalendarLifetimeTab from '../components/meatspace/tabs/CalendarTab';
import SyncTab from '../components/calendar/SyncTab';

const TABS = [
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
  const { tab } = useParams();
  const navigate = useNavigate();
  const VALID_TABS = TABS.map(t => t.id);
  const activeTab = VALID_TABS.includes(tab) ? tab : 'agenda';
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
      <div className="flex items-center justify-center h-full">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-port-border">
        <div className="flex items-center gap-3">
          <CalendarDays className="w-8 h-8 text-port-accent" />
          <div>
            <h1 className="text-xl font-bold text-white">Calendar</h1>
            <p className="text-sm text-gray-500">Unified calendar and event management</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-500">{accounts.length} accounts</span>
        </div>
      </div>

      <TabPills tabs={TABS} activeTab={activeTab} onChange={handleTabChange} ariaLabel="Calendar sections" />

      <div className="flex-1 overflow-auto p-4">
        {renderTabContent()}
      </div>
    </div>
  );
}
