import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Calendar, Coffee, Droplets, Utensils, Dumbbell, BookOpen, Scissors,
  Cake, Plane, Plus, Trash2, Circle, Sun, Moon, TreePine, Snowflake,
  Flower2, CloudSun, Settings2
} from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';

const ICON_MAP = {
  coffee: Coffee, droplets: Droplets, utensils: Utensils, dumbbell: Dumbbell,
  'book-open': BookOpen, scissors: Scissors, cake: Cake, plane: Plane,
  circle: Circle, sun: Sun, moon: Moon,
};

const CADENCE_LABELS = { day: '/day', week: '/week', month: '/month', year: '/year' };

function IconForName({ name, size = 16, className }) {
  const Comp = ICON_MAP[name] || Circle;
  return <Comp size={size} className={className} />;
}

// === Event Colors ===

const EVENT_COLORS = [
  { id: 'birthday', label: 'Birthday', color: 'bg-pink-500', ring: 'ring-pink-500/50' },
  { id: 'holiday', label: 'Holiday', color: 'bg-amber-500', ring: 'ring-amber-500/50' },
  { id: 'vacation', label: 'Vacation', color: 'bg-cyan-500', ring: 'ring-cyan-500/50' },
  { id: 'milestone', label: 'Milestone', color: 'bg-purple-500', ring: 'ring-purple-500/50' },
  { id: 'health', label: 'Health', color: 'bg-red-500', ring: 'ring-red-500/50' },
];

/**
 * Compute which weeks in the remaining grid correspond to birthdays.
 * Returns a Map<string, string> where key is "age-week" and value is event id.
 */
function computeEventWeeks(birthDate, grid, stats) {
  const events = new Map();
  if (!birthDate) return events;

  const birth = new Date(birthDate);
  const birthMonth = birth.getMonth();
  const birthDay = birth.getDate();
  const currentAge = Math.floor(stats.age.years);

  // Mark birthday weeks for remaining years
  for (const row of grid) {
    if (row.age <= currentAge) continue;
    // Birthday falls in this year — find which week
    const yearStart = new Date(birth);
    yearStart.setFullYear(birth.getFullYear() + row.age);
    const bday = new Date(yearStart.getFullYear(), birthMonth, birthDay);
    const weekOfYear = Math.floor((bday - yearStart) / (7 * 86400000));
    if (weekOfYear >= 0 && weekOfYear < 52) {
      events.set(`${row.age}-${weekOfYear}`, 'birthday');
    }
  }

  return events;
}

// === View Mode Config ===

const VIEW_MODES = [
  { id: 'year', label: 'Year (52 weeks/row)', weeksPerRow: 52 },
  { id: 'half', label: 'Half Year (26 weeks/row)', weeksPerRow: 26 },
  { id: 'quarter', label: 'Quarter (13 weeks/row)', weeksPerRow: 13 },
  { id: 'auto', label: 'Auto-fit', weeksPerRow: null },
];

const CELL_SIZES = [
  { id: 'xs', label: 'XS', size: 5, gap: 1 },
  { id: 'sm', label: 'S', size: 7, gap: 1 },
  { id: 'md', label: 'M', size: 9, gap: 1 },
  { id: 'lg', label: 'L', size: 12, gap: 2 },
];

// === Life Grid ===

function LifeGrid({ grid, stats, birthDate }) {
  const [viewMode, setViewMode] = useState('auto');
  const [cellSizeId, setCellSizeId] = useState('sm');
  const [showEvents, setShowEvents] = useState(true);
  const [hideSpent, setHideSpent] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  const currentAge = Math.floor(stats.age.years);
  const cellCfg = CELL_SIZES.find(c => c.id === cellSizeId) || CELL_SIZES[1];
  const viewCfg = VIEW_MODES.find(v => v.id === viewMode) || VIEW_MODES[0];

  // Flatten all weeks into a single array with metadata
  const allWeeks = useMemo(() => {
    const weeks = [];
    for (const row of grid) {
      for (let w = 0; w < row.weeks.length; w++) {
        weeks.push({ age: row.age, week: w, status: row.weeks[w] });
      }
    }
    return weeks;
  }, [grid]);

  // Compute event markers
  const eventWeeks = useMemo(
    () => showEvents ? computeEventWeeks(birthDate, grid, stats) : new Map(),
    [birthDate, grid, stats, showEvents]
  );

  // Determine weeks per row
  const weeksPerRow = viewCfg.weeksPerRow || 104; // auto = ~2 years per row for wide screens

  // Filter grid when hiding spent
  const filteredGrid = useMemo(() => {
    if (!hideSpent) return grid;
    return grid.filter(row => row.weeks.some(s => s === 'c' || s === 'r'));
  }, [grid, hideSpent]);

  // Group weeks into rows
  const rows = useMemo(() => {
    if (viewMode !== 'auto' && viewCfg.weeksPerRow) {
      // Year-aligned: use grid rows directly, but split/merge as needed
      if (viewCfg.weeksPerRow === 52) {
        return filteredGrid.map(row => ({ label: row.age, weeks: row.weeks.map((s, w) => ({ age: row.age, week: w, status: s })) }));
      }
      // Sub-year: split each year row
      const result = [];
      for (const row of filteredGrid) {
        for (let start = 0; start < row.weeks.length; start += viewCfg.weeksPerRow) {
          const slice = row.weeks.slice(start, start + viewCfg.weeksPerRow);
          const label = start === 0 ? row.age : null;
          result.push({ label, weeks: slice.map((s, i) => ({ age: row.age, week: start + i, status: s })) });
        }
      }
      return result;
    }
    // Auto-fit: pack all weeks into rows of weeksPerRow
    const result = [];
    for (let i = 0; i < allWeeks.length; i += weeksPerRow) {
      const slice = allWeeks.slice(i, i + weeksPerRow);
      const firstAge = slice[0]?.age;
      const label = i === 0 || firstAge !== allWeeks[Math.max(0, i - 1)]?.age ? firstAge : null;
      result.push({ label: firstAge, weeks: slice });
    }
    return result;
  }, [filteredGrid, allWeeks, viewMode, viewCfg, weeksPerRow, hideSpent]);

  // Decade/5-year labels
  const shouldLabel = (age) => age != null && age % 10 === 0;

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Calendar size={16} className="text-port-accent" />
        <h3 className="text-sm font-medium text-white">Life in Weeks</h3>
        <span className="text-xs text-gray-500 ml-auto">
          Week {stats.age.weeks.toLocaleString()} of {stats.total.weeks.toLocaleString()}
        </span>
        <button
          onClick={() => setShowConfig(v => !v)}
          className={`p-1 rounded transition-colors ${showConfig ? 'text-port-accent bg-port-accent/10' : 'text-gray-500 hover:text-white'}`}
          title="Grid settings"
        >
          <Settings2 size={14} />
        </button>
      </div>

      {/* Config panel */}
      {showConfig && (
        <div className="flex flex-wrap items-center gap-4 mb-3 p-2 bg-port-bg rounded-lg border border-port-border">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Layout:</span>
            {VIEW_MODES.map(v => (
              <button
                key={v.id}
                onClick={() => setViewMode(v.id)}
                className={`px-2 py-0.5 text-xs rounded ${viewMode === v.id ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              >
                {v.id === 'auto' ? 'Auto' : v.id === 'year' ? '1Y' : v.id === 'half' ? '6M' : '3M'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Size:</span>
            {CELL_SIZES.map(c => (
              <button
                key={c.id}
                onClick={() => setCellSizeId(c.id)}
                className={`px-2 py-0.5 text-xs rounded ${cellSizeId === c.id ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} className="rounded border-port-border" />
            Birthdays
          </label>
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={hideSpent} onChange={(e) => setHideSpent(e.target.checked)} className="rounded border-port-border" />
            Hide spent
          </label>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-4 mb-3 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-gray-600" /> Spent</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-port-accent" /> Now</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-port-success/30" /> Remaining</span>
        {showEvents && (
          <>
            {EVENT_COLORS.filter(e => e.id === 'birthday').map(e => (
              <span key={e.id} className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-sm ${e.color}`} /> {e.label}
              </span>
            ))}
          </>
        )}
      </div>

      {/* Grid */}
      <div className="overflow-x-auto">
        <div style={{ display: 'flex', flexDirection: 'column', gap: `${cellCfg.gap}px` }}>
          {rows.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: `${cellCfg.gap}px` }}>
              {/* Age label */}
              <span
                className={`text-right shrink-0 ${shouldLabel(row.label) ? 'text-gray-400 font-medium' : 'text-transparent'}`}
                style={{ width: '24px', fontSize: '9px' }}
              >
                {shouldLabel(row.label) ? row.label : '.'}
              </span>
              {row.weeks.map((cell, wi) => {
                const eventId = eventWeeks.get(`${cell.age}-${cell.week}`);
                const eventCfg = eventId ? EVENT_COLORS.find(e => e.id === eventId) : null;

                let bgClass;
                if (eventCfg && cell.status === 'r') {
                  bgClass = eventCfg.color;
                } else if (cell.status === 'c') {
                  bgClass = 'bg-port-accent shadow-[0_0_4px_rgba(59,130,246,0.5)]';
                } else if (cell.status === 's') {
                  bgClass = cell.age === currentAge ? 'bg-gray-500' : 'bg-gray-700';
                } else {
                  bgClass = 'bg-port-success/20';
                }

                return (
                  <span
                    key={wi}
                    className={`shrink-0 rounded-[1px] ${bgClass} ${eventCfg ? `ring-1 ${eventCfg.ring}` : ''}`}
                    style={{ width: `${cellCfg.size}px`, height: `${cellCfg.size}px` }}
                    title={`Age ${cell.age}, Week ${cell.week + 1}${eventCfg ? ` — ${eventCfg.label}` : ''}`}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// === Stats Cards ===

function StatCard({ icon: Icon, iconColor, label, value, sub }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} className={iconColor} />
        <span className="text-xs text-gray-400 uppercase tracking-wider">{label}</span>
      </div>
      <div className="text-xl font-bold text-white">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function TimeStats({ stats }) {
  const r = stats.remaining;
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Time Remaining</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        <StatCard icon={Sun} iconColor="text-yellow-400" label="Saturdays" value={r.saturdays} sub={`${Math.round(r.saturdays / 52)} years of Saturdays`} />
        <StatCard icon={Sun} iconColor="text-orange-400" label="Sundays" value={r.sundays} sub={`${Math.round(r.sundays / 52)} years of Sundays`} />
        <StatCard icon={CloudSun} iconColor="text-blue-400" label="Weekends" value={r.weekends} sub={`${Math.round(r.weekends * 2)} weekend days`} />
        <StatCard icon={Moon} iconColor="text-indigo-400" label="Sleep" value={`${Math.round(r.sleepHours / 24 / 365.25)}y`} sub={`${r.sleepHours.toLocaleString()} hours`} />
        <StatCard icon={Sun} iconColor="text-green-400" label="Awake Days" value={r.awakeDays} sub={`${Math.round(r.awakeDays / 365.25)} awake years`} />
        <StatCard icon={Calendar} iconColor="text-purple-400" label="Months" value={r.months} />
        <StatCard icon={Calendar} iconColor="text-teal-400" label="Weeks" value={r.weeks} />
        <StatCard icon={Calendar} iconColor="text-port-accent" label="Days" value={r.days} />
        <StatCard icon={Snowflake} iconColor="text-cyan-400" label="Winters" value={Math.floor(r.seasons / 4)} />
        <StatCard icon={Flower2} iconColor="text-pink-400" label="Springs" value={Math.floor(r.seasons / 4)} />
        <StatCard icon={TreePine} iconColor="text-green-400" label="Summers" value={Math.floor(r.seasons / 4)} />
        <StatCard icon={Cake} iconColor="text-port-warning" label="Holidays" value={r.holidays} sub="Major holidays left" />
      </div>
    </div>
  );
}

// === Activity Budgets ===

function ActivityBudgets({ budgets, onRemove }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Activity Budget</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {budgets.map((b, i) => (
          <div key={i} className="bg-port-card border border-port-border rounded-lg p-3 flex items-center gap-3 group">
            <IconForName name={b.icon} size={18} className="text-port-accent shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-white">{b.name}</div>
              <div className="text-xs text-gray-500">{b.frequency}{CADENCE_LABELS[b.cadence]}</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold text-white">{b.remaining.toLocaleString()}</div>
              <div className="text-[10px] text-gray-500">remaining</div>
            </div>
            <button
              onClick={() => onRemove(i)}
              className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-600 hover:text-port-error p-1"
              title="Remove activity"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// === Add Activity Form ===

function AddActivityForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState('day');
  const [frequency, setFrequency] = useState('1');
  const [icon, setIcon] = useState('circle');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd({ name: name.trim(), cadence, frequency: parseFloat(frequency) || 1, icon });
    setName('');
    setFrequency('1');
    setIcon('circle');
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white bg-port-card border border-dashed border-port-border rounded-lg hover:border-port-accent/50 transition-colors"
      >
        <Plus size={16} />
        Add Activity
      </button>
    );
  }

  const iconOptions = Object.keys(ICON_MAP);

  return (
    <form onSubmit={handleSubmit} className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Coffees"
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Icon</label>
          <div className="flex gap-1 flex-wrap">
            {iconOptions.map(ic => (
              <button
                key={ic}
                type="button"
                onClick={() => setIcon(ic)}
                className={`p-1.5 rounded ${icon === ic ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-white'}`}
              >
                <IconForName name={ic} size={14} />
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Frequency</label>
          <input
            type="number"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            min="0.01"
            step="0.5"
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Cadence</label>
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
          >
            <option value="day">Per Day</option>
            <option value="week">Per Week</option>
            <option value="month">Per Month</option>
            <option value="year">Per Year</option>
          </select>
        </div>
      </div>
      <div className="flex gap-2">
        <button type="submit" className="px-3 py-1.5 bg-port-accent text-white text-sm rounded hover:bg-port-accent/80 transition-colors">
          Add
        </button>
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-1.5 text-gray-400 text-sm hover:text-white transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}

// === Main CalendarTab ===

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading life calendar" />
      </div>
    );
  }

  if (error || data?.error) {
    return (
      <div className="text-center py-12">
        <Calendar size={48} className="text-gray-600 mx-auto mb-4" />
        <p className="text-gray-400 mb-2">Life calendar unavailable</p>
        <p className="text-sm text-gray-500">{error || data.error}</p>
      </div>
    );
  }

  const { stats, grid, budgets, birthDate } = data;

  const pctSpent = stats.age.weeks / stats.total.weeks * 100;
  const pctColor = pctSpent < 50 ? 'text-port-accent' : pctSpent < 75 ? 'text-port-warning' : 'text-port-error';

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="bg-port-card border border-port-border rounded-lg p-4">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Age</div>
            <div className="text-2xl font-bold text-white">{Math.floor(stats.age.years)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Weeks Lived</div>
            <div className="text-2xl font-bold text-gray-400">{stats.age.weeks.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-wider">Weeks Left</div>
            <div className="text-2xl font-bold text-port-success">{stats.remaining.weeks.toLocaleString()}</div>
          </div>
          <div className="flex-1 min-w-[200px]">
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
        </div>
      </div>

      {/* Life Grid */}
      <LifeGrid grid={grid} stats={stats} birthDate={birthDate} />

      {/* Time remaining stats */}
      <TimeStats stats={stats} />

      {/* Activity budgets */}
      <ActivityBudgets budgets={budgets} onRemove={handleRemoveActivity} />
      <AddActivityForm onAdd={handleAddActivity} />
    </div>
  );
}
