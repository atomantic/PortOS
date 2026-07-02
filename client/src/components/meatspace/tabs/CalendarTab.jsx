import { useState, useEffect, useCallback } from 'react';
import { Calendar, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from '../../ui/Toast';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import { IconForName } from './calendar/icons';
import { CADENCE_LABELS } from './calendar/lifeGridMath';
import LifeGrid from './calendar/LifeGrid';
import TimeStats from './calendar/TimeStats';
import AddActivityForm from './calendar/AddActivityForm';
import LifeEventsPanel from './calendar/LifeEventsPanel';

export default function CalendarTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    const result = await api.getLifeCalendar().catch(err => {
      setError(err.message);
      return null;
    });
    if (result) {
      setData(result);
      setError(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleAddActivity = async (activity) => {
    const result = await api.addActivity(activity).catch(() => null);
    if (result) {
      toast.success(`Added ${activity.name}`);
      fetchData();
    }
  };

  const handleRemoveActivity = async (index) => {
    const name = data?.budgets?.[index]?.name || 'Activity';
    const result = await api.removeActivity(index).catch(() => null);
    if (result) {
      toast.success(`Removed ${name}`);
      fetchData();
    }
  };

  const handleAddEvent = async (event) => {
    const result = await api.addLifeEvent(event).catch(() => null);
    if (result) {
      toast.success(`Added ${event.name}`);
      fetchData();
    }
  };

  const handleToggleEvent = async (id, enabled) => {
    const result = await api.updateLifeEvent(id, { enabled }).catch(() => null);
    if (result) fetchData();
  };

  const handleRemoveEvent = async (id) => {
    const event = data?.events?.find(e => e.id === id);
    const result = await api.removeLifeEvent(id).catch(() => null);
    if (result) {
      toast.success(`Removed ${event?.name || 'event'}`);
      fetchData();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading life calendar" />
      </div>
    );
  }

  if (error || data?.error) {
    const isBirthDateMissing = (error || data?.error || '').includes('Birth date not set');
    return (
      <div className="text-center py-12 max-w-md mx-auto">
        <Calendar size={48} className="text-gray-600 mx-auto mb-4" />
        <p className="text-gray-400 mb-2">Life calendar unavailable</p>
        <p className="text-sm text-gray-500 mb-4">{error || data.error}</p>
        {isBirthDateMissing && (
          <div className="space-y-3">
            <Link
              to="/meatspace/age"
              className="inline-block px-4 py-2 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-sm"
            >
              Set Birth Date
            </Link>
            <p className="text-xs text-gray-600">
              Your birth date is required to calculate your life timeline.
              Set it in <Link to="/meatspace/age" className="text-port-accent hover:underline">MeatSpace &gt; Age</Link>.
            </p>
          </div>
        )}
      </div>
    );
  }

  const { stats, grid, budgets, birthDate, deathDate, events: lifeEvents } = data;

  const pctSpent = stats.age.weeks / stats.total.weeks * 100;
  const pctColor = pctSpent < 50 ? 'text-port-accent' : pctSpent < 75 ? 'text-port-warning' : 'text-port-error';

  return (
    <div className="space-y-4">
      {/* Top summary row: age + progress + key stats */}
      <div className="bg-port-card border border-port-border rounded-lg p-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="text-3xl font-bold text-white">{Math.floor(stats.age.years)}</div>
            <div className="text-xs text-gray-500 leading-tight">years<br/>old</div>
          </div>
          <div className="flex-1 min-w-[140px] max-w-[300px]">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Life Progress</span>
              <span className={pctColor}>{pctSpent.toFixed(1)}%</span>
            </div>
            <div className="h-2 bg-port-bg rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  pctSpent < 50 ? 'bg-port-accent' : pctSpent < 75 ? 'bg-port-warning' : 'bg-port-error'
                }`}
                style={{ width: `${pctSpent}%` }}
              />
            </div>
          </div>
          <div className="flex gap-6 text-sm ml-auto">
            <div className="text-center">
              <div className="font-bold text-port-success">{Math.floor(stats.remaining.years)}</div>
              <div className="text-[10px] text-gray-500">years left</div>
            </div>
            <div className="text-center">
              <div className="font-bold text-port-success">{stats.remaining.months.toLocaleString()}</div>
              <div className="text-[10px] text-gray-500">months</div>
            </div>
            <div className="text-center">
              <div className="font-bold text-port-success">{stats.remaining.weeks.toLocaleString()}</div>
              <div className="text-[10px] text-gray-500">weeks</div>
            </div>
            <div className="text-center">
              <div className="font-bold text-port-success">{stats.remaining.days.toLocaleString()}</div>
              <div className="text-[10px] text-gray-500">days</div>
            </div>
          </div>
        </div>
      </div>

      {/* Setup tips for improving accuracy */}
      <details className="text-xs text-gray-600">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-400">
          Improve your timeline accuracy
        </summary>
        <div className="mt-2 p-3 bg-port-card border border-port-border rounded-lg space-y-1.5">
          {[
            { to: '/meatspace/age', label: 'Birth date', desc: 'required for all calculations' },
            { to: '/meatspace/genome', label: 'Genome', desc: 'upload 23andMe data for genetic longevity markers' },
            { to: '/digital-twin/identity', label: 'Longevity profile', desc: 'derives life expectancy from genome + cardiovascular markers' },
            { to: '/meatspace/lifestyle', label: 'Lifestyle questionnaire', desc: 'smoking, exercise, diet, sleep adjustments' },
            { to: '/meatspace/health', label: 'Health tracking', desc: 'ongoing health data for refined estimates' },
          ].map(tip => (
            <div key={tip.to} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-port-accent shrink-0" />
              <span><Link to={tip.to} className="text-port-accent hover:underline">{tip.label}</Link> — {tip.desc}</span>
            </div>
          ))}
        </div>
      </details>

      {/* Dashboard grid: Life Grid (main) + Time Stats (sidebar) */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        <LifeGrid grid={grid} stats={stats} birthDate={birthDate} deathDate={deathDate} lifeEvents={lifeEvents} />
        <TimeStats stats={stats} />
      </div>

      {/* Activity budgets */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Activity Budget</h3>
          <AddActivityForm onAdd={handleAddActivity} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
          {budgets.map((b, i) => (
            <div key={i} className="bg-port-bg border border-port-border rounded-lg p-2.5 flex items-center gap-2.5 group">
              <IconForName name={b.icon} size={16} className="text-port-accent shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">{b.name}</div>
                <div className="text-[10px] text-gray-500">{b.frequency}{CADENCE_LABELS[b.cadence]}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-base font-bold text-white">{b.remaining.toLocaleString()}</div>
              </div>
              <button
                onClick={() => handleRemoveActivity(i)}
                className="opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-gray-600 hover:text-port-error p-0.5"
                title="Remove activity"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Life Events */}
      <LifeEventsPanel
        events={lifeEvents || []}
        onAdd={handleAddEvent}
        onToggle={handleToggleEvent}
        onRemove={handleRemoveEvent}
      />
    </div>
  );
}
