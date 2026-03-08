import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Calendar, Coffee, Droplets, Utensils, Dumbbell, BookOpen, Scissors,
  Cake, Plane, Plus, Trash2, Circle, Sun, Moon, TreePine, Snowflake,
  Flower2, CloudSun
} from 'lucide-react';
import { Link } from 'react-router-dom';
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

const UNIT_MODES = [
  { id: 'years', label: 'Years' },
  { id: 'months', label: 'Months' },
  { id: 'weeks', label: 'Weeks' },
  { id: 'days', label: 'Days' },
];

const WEEK_LAYOUTS = [
  { id: 'year', label: '1Y', weeksPerRow: 52 },
  { id: 'half', label: '6M', weeksPerRow: 26 },
  { id: 'quarter', label: '3M', weeksPerRow: 13 },
  { id: 'auto', label: 'Auto', weeksPerRow: null },
];

const CELL_SIZES = [
  { id: 'xs', label: 'XS', size: 5, gap: 1 },
  { id: 'sm', label: 'S', size: 7, gap: 1 },
  { id: 'md', label: 'M', size: 9, gap: 1 },
  { id: 'lg', label: 'L', size: 12, gap: 2 },
];

const MS_PER_DAY = 86400000;

// === Grid computation helpers ===

function computeYearGrid(birthDate, deathDate) {
  const birth = new Date(birthDate);
  const death = new Date(deathDate);
  const now = new Date();
  const totalYears = Math.ceil((death - birth) / (365.25 * MS_PER_DAY));
  const cells = [];
  for (let y = 0; y < totalYears; y++) {
    const yearStart = new Date(birth);
    yearStart.setFullYear(birth.getFullYear() + y);
    const yearEnd = new Date(yearStart);
    yearEnd.setFullYear(yearEnd.getFullYear() + 1);
    let status;
    if (yearEnd <= now) status = 's';
    else if (yearStart <= now && now < yearEnd) status = 'c';
    else if (yearStart > death) break;
    else status = 'r';
    cells.push({ index: y, label: `Age ${y}`, status });
  }
  return cells;
}

function computeMonthGrid(birthDate, deathDate) {
  const birth = new Date(birthDate);
  const death = new Date(deathDate);
  const now = new Date();
  const cells = [];
  const cursor = new Date(birth);
  let i = 0;
  while (cursor < death) {
    const monthStart = new Date(cursor);
    const monthEnd = new Date(cursor);
    monthEnd.setMonth(monthEnd.getMonth() + 1);
    let status;
    if (monthEnd <= now) status = 's';
    else if (monthStart <= now && now < monthEnd) status = 'c';
    else status = 'r';
    const age = Math.floor(i / 12);
    const mo = i % 12;
    cells.push({ index: i, age, month: mo, label: `Age ${age}, Month ${mo + 1}`, status });
    cursor.setMonth(cursor.getMonth() + 1);
    i++;
  }
  return cells;
}

function computeDayGrid(birthDate, deathDate, selectedYear) {
  const birth = new Date(birthDate);
  const yearStart = new Date(birth);
  yearStart.setFullYear(birth.getFullYear() + selectedYear);
  const yearEnd = new Date(yearStart);
  yearEnd.setFullYear(yearEnd.getFullYear() + 1);
  const death = new Date(deathDate);
  const now = new Date();
  const cells = [];
  const cursor = new Date(yearStart);
  let dayIdx = 0;
  while (cursor < yearEnd && cursor < death) {
    const dayStart = new Date(cursor);
    const dayEnd = new Date(cursor.getTime() + MS_PER_DAY);
    let status;
    if (dayEnd <= now) status = 's';
    else if (dayStart <= now && now < dayEnd) status = 'c';
    else status = 'r';
    cells.push({ index: dayIdx, dayOfWeek: cursor.getDay(), label: cursor.toLocaleDateString(), status });
    cursor.setDate(cursor.getDate() + 1);
    dayIdx++;
  }
  return cells;
}

function cellBgClass(status, isCurrent) {
  if (status === 'c') return 'bg-port-accent shadow-[0_0_4px_rgba(59,130,246,0.5)]';
  if (status === 's') return isCurrent ? 'bg-gray-500' : 'bg-gray-700';
  return 'bg-port-success/20';
}

// === Year Grid ===

function YearGridView({ birthDate, deathDate, cellCfg, hideSpent }) {
  const cells = useMemo(() => computeYearGrid(birthDate, deathDate), [birthDate, deathDate]);
  const currentAge = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * MS_PER_DAY));
  const filtered = hideSpent ? cells.filter(c => c.status === 'c' || c.status === 'r') : cells;
  const cols = 10;

  const rows = useMemo(() => {
    const result = [];
    for (let i = 0; i < filtered.length; i += cols) {
      result.push(filtered.slice(i, i + cols));
    }
    return result;
  }, [filtered]);

  return (
    <div className="overflow-x-auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${cellCfg.gap + 1}px` }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: `${cellCfg.gap + 1}px` }}>
            <span className="text-right shrink-0 text-gray-500" style={{ width: '28px', fontSize: '9px' }}>
              {row[0]?.index ?? ''}
            </span>
            {row.map((cell) => (
              <span
                key={cell.index}
                className={`shrink-0 rounded-sm ${cellBgClass(cell.status, cell.index === currentAge)}`}
                style={{ width: `${cellCfg.size + 6}px`, height: `${cellCfg.size + 6}px` }}
                title={cell.label}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// === Month Grid ===

function MonthGridView({ birthDate, deathDate, cellCfg, hideSpent }) {
  const cells = useMemo(() => computeMonthGrid(birthDate, deathDate), [birthDate, deathDate]);
  const currentAge = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * MS_PER_DAY));
  const filtered = hideSpent ? cells.filter(c => c.status === 'c' || c.status === 'r') : cells;

  const rows = useMemo(() => {
    const result = [];
    for (let i = 0; i < filtered.length; i += 12) {
      const row = filtered.slice(i, i + 12);
      result.push({ label: row[0]?.age, cells: row });
    }
    return result;
  }, [filtered]);

  const shouldLabel = (age) => age != null && age % 10 === 0;

  return (
    <div className="overflow-x-auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${cellCfg.gap}px` }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: `${cellCfg.gap}px` }}>
            <span
              className={`text-right shrink-0 ${shouldLabel(row.label) ? 'text-gray-400 font-medium' : 'text-transparent'}`}
              style={{ width: '24px', fontSize: '9px' }}
            >
              {shouldLabel(row.label) ? row.label : '.'}
            </span>
            {row.cells.map((cell) => (
              <span
                key={cell.index}
                className={`shrink-0 rounded-[1px] ${cellBgClass(cell.status, cell.age === currentAge)}`}
                style={{ width: `${cellCfg.size + 2}px`, height: `${cellCfg.size + 2}px` }}
                title={cell.label}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// === Day Grid (single year) ===

function DayGridView({ birthDate, deathDate, cellCfg, stats }) {
  const currentAge = Math.floor(stats.age.years);
  const totalYears = Math.ceil((new Date(deathDate) - new Date(birthDate)) / (365.25 * MS_PER_DAY));
  const [selectedYear, setSelectedYear] = useState(currentAge);

  const cells = useMemo(() => computeDayGrid(birthDate, deathDate, selectedYear), [birthDate, deathDate, selectedYear]);

  // Group into rows of 7 (week rows)
  const rows = useMemo(() => {
    const result = [];
    // Pad start to align with day of week
    const firstDow = cells[0]?.dayOfWeek ?? 0;
    const padded = [...Array(firstDow).fill(null), ...cells];
    for (let i = 0; i < padded.length; i += 7) {
      result.push(padded.slice(i, i + 7));
    }
    return result;
  }, [cells]);

  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={() => setSelectedYear(Math.max(0, selectedYear - 1))}
          className="px-2 py-0.5 text-xs text-gray-400 hover:text-white rounded bg-port-bg border border-port-border"
        >
          &larr;
        </button>
        <span className="text-sm text-white font-medium">Age {selectedYear}</span>
        <button
          onClick={() => setSelectedYear(Math.min(totalYears - 1, selectedYear + 1))}
          className="px-2 py-0.5 text-xs text-gray-400 hover:text-white rounded bg-port-bg border border-port-border"
        >
          &rarr;
        </button>
        {selectedYear !== currentAge && (
          <button
            onClick={() => setSelectedYear(currentAge)}
            className="px-2 py-0.5 text-xs text-port-accent hover:text-white"
          >
            Current
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <div style={{ display: 'flex', flexDirection: 'column', gap: `${cellCfg.gap}px` }}>
          {/* Day-of-week header */}
          <div style={{ display: 'flex', gap: `${cellCfg.gap}px`, marginLeft: '0px' }}>
            {dayLabels.map((d, i) => (
              <span key={i} className="text-center text-gray-600 shrink-0" style={{ width: `${cellCfg.size}px`, fontSize: '8px' }}>
                {d}
              </span>
            ))}
          </div>
          {rows.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: `${cellCfg.gap}px` }}>
              {row.map((cell, ci) => cell ? (
                <span
                  key={ci}
                  className={`shrink-0 rounded-[1px] ${cellBgClass(cell.status, false)}`}
                  style={{ width: `${cellCfg.size}px`, height: `${cellCfg.size}px` }}
                  title={cell.label}
                />
              ) : (
                <span key={ci} className="shrink-0" style={{ width: `${cellCfg.size}px`, height: `${cellCfg.size}px` }} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// === Week Grid (original) ===

function WeekGridView({ grid, stats, birthDate, cellCfg, weekLayout, hideSpent, showEvents }) {
  const currentAge = Math.floor(stats.age.years);
  const layoutCfg = WEEK_LAYOUTS.find(v => v.id === weekLayout) || WEEK_LAYOUTS[0];

  const allWeeks = useMemo(() => {
    const weeks = [];
    for (const row of grid) {
      for (let w = 0; w < row.weeks.length; w++) {
        weeks.push({ age: row.age, week: w, status: row.weeks[w] });
      }
    }
    return weeks;
  }, [grid]);

  const eventWeeks = useMemo(
    () => showEvents ? computeEventWeeks(birthDate, grid, stats) : new Map(),
    [birthDate, grid, stats, showEvents]
  );

  const weeksPerRow = layoutCfg.weeksPerRow || 104;

  const filteredGrid = useMemo(() => {
    if (!hideSpent) return grid;
    return grid.filter(row => row.weeks.some(s => s === 'c' || s === 'r'));
  }, [grid, hideSpent]);

  const rows = useMemo(() => {
    if (weekLayout !== 'auto' && layoutCfg.weeksPerRow) {
      if (layoutCfg.weeksPerRow === 52) {
        return filteredGrid.map(row => ({ label: row.age, weeks: row.weeks.map((s, w) => ({ age: row.age, week: w, status: s })) }));
      }
      const result = [];
      for (const row of filteredGrid) {
        for (let start = 0; start < row.weeks.length; start += layoutCfg.weeksPerRow) {
          const slice = row.weeks.slice(start, start + layoutCfg.weeksPerRow);
          const label = start === 0 ? row.age : null;
          result.push({ label, weeks: slice.map((s, i) => ({ age: row.age, week: start + i, status: s })) });
        }
      }
      return result;
    }
    const result = [];
    for (let i = 0; i < allWeeks.length; i += weeksPerRow) {
      const slice = allWeeks.slice(i, i + weeksPerRow);
      const firstAge = slice[0]?.age;
      result.push({ label: firstAge, weeks: slice });
    }
    return result;
  }, [filteredGrid, allWeeks, weekLayout, layoutCfg, weeksPerRow, hideSpent]);

  const shouldLabel = (age) => age != null && age % 10 === 0;

  return (
    <div className="overflow-x-auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${cellCfg.gap}px` }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: `${cellCfg.gap}px` }}>
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
  );
}

// === Life Grid (main component) ===

function LifeGrid({ grid, stats, birthDate, deathDate }) {
  const [unit, setUnit] = useState('weeks');
  const [weekLayout, setWeekLayout] = useState('year');
  const [cellSizeId, setCellSizeId] = useState('sm');
  const [showEvents, setShowEvents] = useState(true);
  const [hideSpent, setHideSpent] = useState(false);

  const cellCfg = CELL_SIZES.find(c => c.id === cellSizeId) || CELL_SIZES[1];

  const unitLabel = {
    years: `Year ${Math.floor(stats.age.years)} of ${Math.ceil(stats.remaining.years + stats.age.years)}`,
    months: `Month ${Math.floor(stats.age.years * 12)} of ${Math.floor((stats.remaining.years + stats.age.years) * 12)}`,
    weeks: `Week ${stats.age.weeks.toLocaleString()} of ${stats.total.weeks.toLocaleString()}`,
    days: `Day ${stats.age.days.toLocaleString()} of ${Math.floor((stats.remaining.days || 0) + stats.age.days).toLocaleString()}`,
  };

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      {/* Header: title + unit toggle + controls */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Calendar size={16} className="text-port-accent" />
        <h3 className="text-sm font-medium text-white">Life Calendar</h3>
        {/* Unit toggle */}
        <div className="flex items-center gap-0.5 ml-1 bg-port-bg rounded-md p-0.5 border border-port-border">
          {UNIT_MODES.map(u => (
            <button
              key={u.id}
              onClick={() => setUnit(u.id)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${unit === u.id ? 'bg-port-accent/20 text-port-accent font-medium' : 'text-gray-400 hover:text-white'}`}
            >
              {u.label}
            </button>
          ))}
        </div>
        {/* Week layout (only in weeks mode) */}
        {unit === 'weeks' && (
          <div className="flex items-center gap-0.5 bg-port-bg rounded-md p-0.5 border border-port-border">
            {WEEK_LAYOUTS.map(v => (
              <button
                key={v.id}
                onClick={() => setWeekLayout(v.id)}
                className={`px-2 py-0.5 text-xs rounded ${weekLayout === v.id ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
        {/* Cell size */}
        <div className="flex items-center gap-0.5 bg-port-bg rounded-md p-0.5 border border-port-border">
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
        {/* Toggles */}
        {unit === 'weeks' && (
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} className="rounded border-port-border" />
            Birthdays
          </label>
        )}
        {unit !== 'days' && (
          <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
            <input type="checkbox" checked={hideSpent} onChange={(e) => setHideSpent(e.target.checked)} className="rounded border-port-border" />
            Hide spent
          </label>
        )}
        <span className="text-xs text-gray-500 ml-auto">
          {unitLabel[unit]}
        </span>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mb-3 text-xs text-gray-500 flex-wrap">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-gray-600" /> Spent</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-port-accent" /> Now</span>
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-port-success/30" /> Remaining</span>
        {unit === 'weeks' && showEvents && EVENT_COLORS.filter(e => e.id === 'birthday').map(e => (
          <span key={e.id} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-sm ${e.color}`} /> {e.label}
          </span>
        ))}
      </div>

      {/* Grid */}
      {unit === 'years' && (
        <YearGridView birthDate={birthDate} deathDate={deathDate} cellCfg={cellCfg} hideSpent={hideSpent} />
      )}
      {unit === 'months' && (
        <MonthGridView birthDate={birthDate} deathDate={deathDate} cellCfg={cellCfg} hideSpent={hideSpent} />
      )}
      {unit === 'weeks' && (
        <WeekGridView grid={grid} stats={stats} birthDate={birthDate} cellCfg={cellCfg} weekLayout={weekLayout} hideSpent={hideSpent} showEvents={showEvents} />
      )}
      {unit === 'days' && (
        <DayGridView birthDate={birthDate} deathDate={deathDate} cellCfg={cellCfg} stats={stats} />
      )}
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
    const isBirthDateMissing = (error || data?.error || '').includes('Birth date not set');
    return (
      <div className="text-center py-12">
        <Calendar size={48} className="text-gray-600 mx-auto mb-4" />
        <p className="text-gray-400 mb-2">Life calendar unavailable</p>
        <p className="text-sm text-gray-500 mb-4">{error || data.error}</p>
        {isBirthDateMissing && (
          <Link
            to="/meatspace/age"
            className="inline-block px-4 py-2 rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30 text-sm"
          >
            Set Birth Date
          </Link>
        )}
      </div>
    );
  }

  const { stats, grid, budgets, birthDate, deathDate } = data;

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
      <LifeGrid grid={grid} stats={stats} birthDate={birthDate} deathDate={deathDate} />

      {/* Time remaining stats */}
      <TimeStats stats={stats} />

      {/* Activity budgets */}
      <ActivityBudgets budgets={budgets} onRemove={handleRemoveActivity} />
      <AddActivityForm onAdd={handleAddActivity} />
    </div>
  );
}
