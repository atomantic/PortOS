import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Calendar, Coffee, Droplets, Utensils, Dumbbell, BookOpen, Scissors,
  Cake, Plane, Plus, Trash2, Circle, Sun, Moon, TreePine, Snowflake,
  Flower2, CloudSun, ChevronDown, Eye, EyeOff
} from 'lucide-react';
import { Link } from 'react-router-dom';
import toast from '../../ui/Toast';
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

/**
 * Compute which weeks in the remaining grid correspond to events.
 * Uses server-provided events plus birthdays.
 * Returns a Map<string, { type, name }> where key is "age-week".
 */
function computeEventWeeks(birthDate, grid, stats, lifeEvents) {
  const events = new Map();
  if (!birthDate) return events;

  const birth = new Date(birthDate);
  // Helper: compute week offset within an age-year (server uses birth time as yearStart)
  const weekInAgeYear = (eventDate, yearStart) => {
    const ms = eventDate.getTime() - yearStart.getTime();
    return Math.floor(ms / (7 * 86400000));
  };

  // Mark birthday weeks for all years (birthday is always week 0 by definition)
  for (const row of grid) {
    events.set(`${row.age}-0`, { type: 'birthday', name: 'Birthday' });
  }

  // Add life events from server
  if (lifeEvents?.length) {
    for (const event of lifeEvents) {
      if (!event.enabled) continue;

      if (event.recurrence === 'yearly' && event.month != null && event.day != null) {
        for (const row of grid) {
          const yearStart = new Date(birth);
          yearStart.setFullYear(birth.getFullYear() + row.age);
          // Event may fall in this calendar year or next (if before birthday)
          let eventDate = new Date(yearStart.getFullYear(), event.month, event.day);
          if (eventDate < yearStart) {
            eventDate = new Date(yearStart.getFullYear() + 1, event.month, event.day);
          }
          const weekOfYear = weekInAgeYear(eventDate, yearStart);
          if (weekOfYear >= 0 && weekOfYear < 52) {
            const key = `${row.age}-${weekOfYear}`;
            if (!events.has(key)) {
              events.set(key, { type: event.type, name: event.name });
            }
          }
        }
      } else if (event.recurrence === 'once' && event.date) {
        const eventDate = new Date(event.date);
        const ageMs = eventDate - birth;
        const age = Math.floor(ageMs / (365.25 * 86400000));
        const yearStart = new Date(birth);
        yearStart.setFullYear(birth.getFullYear() + age);
        const weekOfYear = weekInAgeYear(eventDate, yearStart);
        if (weekOfYear >= 0 && weekOfYear < 52) {
          const key = `${age}-${weekOfYear}`;
          if (!events.has(key)) {
            events.set(key, { type: event.type, name: event.name });
          }
        }
      }
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

// Fixed cell sizes per unit mode — no user toggle needed
const UNIT_CELL_SIZES = {
  years: { size: 18, gap: 2 },
  months: { size: 9, gap: 1 },
  weeks: { size: 7, gap: 1 },
  days: { size: 16, gap: 2 },
};

// Hook: track container width via ResizeObserver for responsive sizing
function useContainerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(Math.floor(w));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

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
    // Every year contains a birthday
    cells.push({ index: y, label: `Age ${y}`, status, isBirthday: true });
  }
  return cells;
}

function computeMonthGrid(birthDate, deathDate) {
  const birth = new Date(birthDate);
  const death = new Date(deathDate);
  const now = new Date();
  const birthMonth = birth.getMonth();
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
    const calMonth = cursor.getMonth();
    const isBirthday = calMonth === birthMonth;
    cells.push({ index: i, age, month: mo, calMonth, label: `Age ${age}, Month ${mo + 1}`, status, isBirthday });
    cursor.setMonth(cursor.getMonth() + 1);
    i++;
  }
  return cells;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function computeMonthCalendars(birthDate, deathDate, selectedAge) {
  const birth = new Date(birthDate);
  const birthMonth = birth.getMonth();
  const birthDay = birth.getDate();
  const death = new Date(deathDate);
  const now = new Date();

  // 1-year span: from birthday at selectedAge to day before birthday at selectedAge+1
  const rangeStart = new Date(birth);
  rangeStart.setFullYear(birth.getFullYear() + selectedAge);
  const rangeEnd = new Date(rangeStart);
  rangeEnd.setFullYear(rangeEnd.getFullYear() + 1);

  const months = [];
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);

  while (cursor < rangeEnd && cursor < death) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDow = new Date(year, month, 1).getDay();

    const days = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const dateEnd = new Date(date.getTime() + MS_PER_DAY);
      let status;
      if (date >= death) break;
      if (dateEnd <= now) status = 's';
      else if (date <= now && now < dateEnd) status = 'c';
      else status = 'r';
      const isBirthday = month === birthMonth && d === birthDay;
      days.push({ day: d, status, isBirthday, dow: date.getDay(), label: date.toLocaleDateString() });
    }

    months.push({ year, month, name: `${MONTH_NAMES[month]} ${year}`, firstDow, days });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months;
}

const EVENT_TYPE_STYLES = {
  birthday: { bg: 'bg-pink-500', ring: 'ring-1 ring-pink-500/50' },
  holiday: { bg: 'bg-amber-500', ring: 'ring-1 ring-amber-500/50' },
  vacation: { bg: 'bg-cyan-500', ring: 'ring-1 ring-cyan-500/50' },
  milestone: { bg: 'bg-purple-500', ring: 'ring-1 ring-purple-500/50' },
  health: { bg: 'bg-red-500', ring: 'ring-1 ring-red-500/50' },
  custom: { bg: 'bg-emerald-500', ring: 'ring-1 ring-emerald-500/50' },
};

function cellClasses(status, isCurrent, isBirthday, showEvents) {
  if (isBirthday && showEvents && status === 'r') return 'bg-pink-500 ring-1 ring-pink-500/50';
  if (status === 'c') return 'bg-port-accent shadow-[0_0_4px_rgba(59,130,246,0.5)]';
  if (status === 's') {
    const base = isCurrent ? 'bg-gray-500' : 'bg-gray-700';
    return isBirthday && showEvents ? `${base} ring-1 ring-pink-500/50` : base;
  }
  return isBirthday && showEvents ? 'bg-pink-500 ring-1 ring-pink-500/50' : 'bg-port-success/20';
}

// === Year Grid ===

function YearGridView({ birthDate, deathDate, hideSpent }) {
  const cells = useMemo(() => computeYearGrid(birthDate, deathDate), [birthDate, deathDate]);
  const currentAge = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * MS_PER_DAY));
  const filtered = hideSpent ? cells.filter(c => c.status === 'c' || c.status === 'r') : cells;
  const [containerRef, containerWidth] = useContainerWidth();
  // Responsive columns: shrink from 10 on narrow screens
  const cols = containerWidth < 200 ? 5 : 10;
  const labelW = containerWidth < 300 ? 28 : 36;

  const rows = useMemo(() => {
    const result = [];
    for (let i = 0; i < filtered.length; i += cols) {
      result.push(filtered.slice(i, i + cols));
    }
    return result;
  }, [filtered, cols]);

  return (
    <div ref={containerRef}>
      <div style={{ display: 'grid', gridTemplateColumns: `${labelW}px repeat(${cols}, 1fr)`, gap: '3px' }}>
        {rows.map((row, ri) => (
          <Fragment key={ri}>
            <span className="text-right text-gray-500 self-center" style={{ fontSize: '10px' }}>
              {row[0]?.index ?? ''}
            </span>
            {row.map((cell) => (
              <span
                key={cell.index}
                className={`rounded-sm ${cellClasses(cell.status, cell.index === currentAge, false, false)}`}
                style={{ aspectRatio: '1', width: '100%' }}
                title={cell.label}
              />
            ))}
            {row.length < cols && Array.from({ length: cols - row.length }).map((_, i) => (
              <span key={`empty-${i}`} />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

// === Month Grid ===

function MonthGridView({ birthDate, deathDate, hideSpent, showEvents, lifeEvents }) {
  const cells = useMemo(() => computeMonthGrid(birthDate, deathDate), [birthDate, deathDate]);
  const currentAge = Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * MS_PER_DAY));
  const filtered = hideSpent ? cells.filter(c => c.status === 'c' || c.status === 'r') : cells;
  const [containerRef, containerWidth] = useContainerWidth();

  // Build a set of calendar months that have yearly events
  const eventMonths = useMemo(() => {
    if (!showEvents || !lifeEvents?.length) return new Map();
    const map = new Map();
    for (const event of lifeEvents) {
      if (!event.enabled || event.recurrence !== 'yearly' || event.month == null) continue;
      if (!map.has(event.month)) {
        map.set(event.month, { type: event.type, name: event.name });
      }
    }
    return map;
  }, [showEvents, lifeEvents]);

  // Responsive: fit cells to container width
  // Each row is N years × 12 months. Pick years-per-row based on width.
  const baseCellSize = 6;
  const gap = 1;
  const yearsPerRow = containerWidth
    ? Math.max(1, Math.min(10, Math.floor(containerWidth / ((baseCellSize + gap) * 12))))
    : 10;
  const cols = yearsPerRow * 12;
  // Auto-size cells to fill available width
  const cellSize = containerWidth
    ? Math.max(3, Math.floor((containerWidth - (cols - 1) * gap) / cols))
    : baseCellSize;

  const rows = useMemo(() => {
    const result = [];
    for (let i = 0; i < filtered.length; i += cols) {
      const row = filtered.slice(i, i + cols);
      const startAge = row[0]?.age ?? 0;
      const endAge = startAge + yearsPerRow - 1;
      result.push({ label: startAge, endAge, cells: row });
    }
    return result;
  }, [filtered, cols, yearsPerRow]);

  return (
    <div ref={containerRef}>
      {rows.map((row, ri) => (
        <div key={ri} className="mb-2">
          <span className="text-gray-400 font-medium" style={{ fontSize: '9px' }}>
            {row.label}–{row.endAge}
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${gap}px`, marginTop: '1px' }}>
            {row.cells.map((cell) => {
              const eventInfo = showEvents ? eventMonths.get(cell.calMonth) : null;
              const eventStyle = eventInfo ? EVENT_TYPE_STYLES[eventInfo.type] : null;

              let cls;
              if (cell.status === 'c') {
                cls = 'bg-port-accent shadow-[0_0_4px_rgba(59,130,246,0.5)]';
              } else if (cell.isBirthday && showEvents) {
                cls = cell.status === 's'
                  ? `${cell.age === currentAge ? 'bg-gray-500' : 'bg-gray-700'} ring-1 ring-pink-500/50`
                  : 'bg-pink-500 ring-1 ring-pink-500/50';
              } else if (eventStyle) {
                cls = cell.status === 's'
                  ? `${cell.age === currentAge ? 'bg-gray-500' : 'bg-gray-700'} ${eventStyle.ring}`
                  : `${eventStyle.bg} ${eventStyle.ring}`;
              } else if (cell.status === 's') {
                cls = cell.age === currentAge ? 'bg-gray-500' : 'bg-gray-700';
              } else {
                cls = 'bg-port-success/20';
              }

              return (
                <span
                  key={cell.index}
                  className={`rounded-[1px] ${cls}`}
                  style={{ width: `${cellSize}px`, height: `${cellSize}px` }}
                  title={`${cell.label}${eventInfo ? ` — ${eventInfo.name}` : ''}`}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// === Day Grid (monthly calendar layout, 2-year span) ===

function MiniMonth({ month, cellSize, gap, showEvents }) {
  // Build week rows with leading padding
  const rows = useMemo(() => {
    const result = [];
    const padded = [...Array(month.firstDow).fill(null), ...month.days];
    for (let i = 0; i < padded.length; i += 7) {
      result.push(padded.slice(i, i + 7));
    }
    // Pad last row to 7
    const last = result[result.length - 1];
    while (last && last.length < 7) last.push(null);
    return result;
  }, [month]);

  const rowStyle = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: `${gap}px` };

  return (
    <div className="flex flex-col w-full">
      <div className="text-[10px] text-gray-400 font-medium mb-1 text-center">{month.name}</div>
      <div style={rowStyle}>
        {DAY_LABELS.map((d, i) => (
          <span key={i} className="text-center text-gray-600" style={{ fontSize: '7px', lineHeight: `${cellSize}px` }}>
            {d}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${gap}px`, marginTop: `${gap}px` }}>
        {rows.map((row, ri) => (
          <div key={ri} style={rowStyle}>
            {row.map((cell, ci) => cell ? (
              <span
                key={ci}
                className={`rounded-[1px] ${cellClasses(cell.status, false, cell.isBirthday, showEvents)}`}
                style={{ aspectRatio: '1', width: '100%' }}
                title={cell.label}
              />
            ) : (
              <span key={ci} style={{ aspectRatio: '1', width: '100%' }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function DayGridView({ birthDate, deathDate, cellCfg, stats, showEvents }) {
  const currentAge = Math.floor(stats.age.years);
  const totalYears = Math.ceil((new Date(deathDate) - new Date(birthDate)) / (365.25 * MS_PER_DAY));
  const [selectedAge, setSelectedAge] = useState(currentAge);
  const [containerRef, containerWidth] = useContainerWidth();

  const months = useMemo(
    () => computeMonthCalendars(birthDate, deathDate, selectedAge),
    [birthDate, deathDate, selectedAge]
  );

  // Responsive: compute grid cols and cell size based on container width
  const gridCols = containerWidth < 300 ? 2 : containerWidth < 400 ? 3 : containerWidth < 600 ? 4 : 6;
  const gridGap = 12;
  const monthWidth = containerWidth ? Math.floor((containerWidth - (gridCols - 1) * gridGap) / gridCols) : null;
  // Fit 7 day columns + 6 gaps into monthWidth
  const responsiveDaySize = monthWidth ? Math.max(8, Math.floor((monthWidth - cellCfg.gap * 6) / 7)) : cellCfg.size;

  return (
    <div ref={containerRef}>
      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={() => setSelectedAge(Math.max(0, selectedAge - 1))}
          className="px-2 py-0.5 text-xs text-gray-400 hover:text-white rounded bg-port-bg border border-port-border"
        >
          &larr;
        </button>
        <span className="text-sm text-white font-medium">Age {selectedAge}</span>
        <button
          onClick={() => setSelectedAge(Math.min(totalYears - 1, selectedAge + 1))}
          className="px-2 py-0.5 text-xs text-gray-400 hover:text-white rounded bg-port-bg border border-port-border"
        >
          &rarr;
        </button>
        {selectedAge !== currentAge && (
          <button
            onClick={() => setSelectedAge(currentAge)}
            className="px-2 py-0.5 text-xs text-port-accent hover:text-white"
          >
            Current
          </button>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gap: `${gridGap}px` }}>
        {months.map((m, i) => (
          <MiniMonth key={i} month={m} cellSize={responsiveDaySize} gap={cellCfg.gap} showEvents={showEvents} />
        ))}
      </div>
    </div>
  );
}

// === Week Grid (original) ===

function WeekGridView({ grid, stats, birthDate, cellCfg, weekLayout, hideSpent, showEvents, lifeEvents }) {
  const currentAge = Math.floor(stats.age.years);
  const layoutCfg = WEEK_LAYOUTS.find(v => v.id === weekLayout) || WEEK_LAYOUTS[0];
  const [containerRef, containerWidth] = useContainerWidth();

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
    () => showEvents ? computeEventWeeks(birthDate, grid, stats, lifeEvents) : new Map(),
    [birthDate, grid, stats, showEvents, lifeEvents]
  );

  // Responsive: compute how many weeks fit in available width
  const labelW = 24;
  const effectiveWeeksPerRow = useMemo(() => {
    const desired = layoutCfg.weeksPerRow || 104;
    if (!containerWidth) return desired;
    const available = containerWidth - labelW - cellCfg.gap;
    const maxWeeks = Math.floor((available + cellCfg.gap) / (cellCfg.size + cellCfg.gap));
    return Math.max(13, Math.min(desired, maxWeeks));
  }, [containerWidth, layoutCfg, cellCfg, labelW]);

  // Auto-size cells to fill when constrained
  const responsiveCell = useMemo(() => {
    if (!containerWidth) return cellCfg;
    const available = containerWidth - labelW - cellCfg.gap;
    const neededWidth = effectiveWeeksPerRow * (cellCfg.size + cellCfg.gap) - cellCfg.gap;
    if (neededWidth <= available) return cellCfg;
    const size = Math.max(2, Math.floor((available + cellCfg.gap) / effectiveWeeksPerRow - cellCfg.gap));
    return { size, gap: cellCfg.gap };
  }, [containerWidth, effectiveWeeksPerRow, cellCfg, labelW]);

  const filteredGrid = useMemo(() => {
    if (!hideSpent) return grid;
    return grid.filter(row => row.weeks.some(s => s === 'c' || s === 'r'));
  }, [grid, hideSpent]);

  const rows = useMemo(() => {
    if (weekLayout !== 'auto' && layoutCfg.weeksPerRow) {
      if (effectiveWeeksPerRow >= 52) {
        return filteredGrid.map(row => ({ label: row.age, weeks: row.weeks.map((s, w) => ({ age: row.age, week: w, status: s })) }));
      }
      const result = [];
      for (const row of filteredGrid) {
        for (let start = 0; start < row.weeks.length; start += effectiveWeeksPerRow) {
          const slice = row.weeks.slice(start, start + effectiveWeeksPerRow);
          const label = start === 0 ? row.age : null;
          result.push({ label, weeks: slice.map((s, i) => ({ age: row.age, week: start + i, status: s })) });
        }
      }
      return result;
    }
    const result = [];
    for (let i = 0; i < allWeeks.length; i += effectiveWeeksPerRow) {
      const slice = allWeeks.slice(i, i + effectiveWeeksPerRow);
      const firstAge = slice[0]?.age;
      result.push({ label: firstAge, weeks: slice });
    }
    return result;
  }, [filteredGrid, allWeeks, weekLayout, layoutCfg, effectiveWeeksPerRow]);

  const shouldLabel = (age) => age != null && age % 10 === 0;

  return (
    <div ref={containerRef} className="overflow-x-auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${responsiveCell.gap}px` }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: `${responsiveCell.gap}px` }}>
            <span
              className={`text-right shrink-0 ${shouldLabel(row.label) ? 'text-gray-400 font-medium' : 'text-transparent'}`}
              style={{ width: `${labelW}px`, fontSize: '9px' }}
            >
              {shouldLabel(row.label) ? row.label : '.'}
            </span>
            {row.weeks.map((cell, wi) => {
              const eventInfo = eventWeeks.get(`${cell.age}-${cell.week}`);
              const eventStyle = eventInfo ? EVENT_TYPE_STYLES[eventInfo.type] : null;

              let bgClass;
              if (cell.status === 'c') {
                bgClass = 'bg-port-accent shadow-[0_0_4px_rgba(59,130,246,0.5)]';
              } else if (eventStyle && cell.status === 'r') {
                bgClass = eventStyle.bg;
              } else if (cell.status === 's') {
                bgClass = cell.age === currentAge ? 'bg-gray-500' : 'bg-gray-700';
              } else {
                bgClass = 'bg-port-success/20';
              }
              return (
                <span
                  key={wi}
                  className={`shrink-0 rounded-[1px] ${bgClass} ${eventStyle?.ring ?? ''}`}
                  style={{ width: `${responsiveCell.size}px`, height: `${responsiveCell.size}px` }}
                  title={`Age ${cell.age}, Week ${cell.week + 1}${eventInfo ? ` — ${eventInfo.name}` : ''}`}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// === Persisted state helper ===

const STORAGE_KEY = 'portos:life-calendar';

function loadGridPrefs() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  return JSON.parse(raw);
}

function saveGridPrefs(prefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function usePersistedState(key, defaultValue) {
  const [value, setValue] = useState(() => {
    const prefs = loadGridPrefs();
    return prefs[key] ?? defaultValue;
  });
  const set = useCallback((v) => {
    setValue(v);
    const prefs = loadGridPrefs();
    prefs[key] = v;
    saveGridPrefs(prefs);
  }, [key]);
  return [value, set];
}

// === Life Grid (main component) ===

function LifeGrid({ grid, stats, birthDate, deathDate, lifeEvents }) {
  const [unit, setUnit] = usePersistedState('unit', 'weeks');
  const [weekLayout, setWeekLayout] = usePersistedState('weekLayout', 'year');
  const [showEvents, setShowEvents] = usePersistedState('showEvents', true);
  const [hideSpent, setHideSpent] = usePersistedState('hideSpent', false);

  const cellCfg = UNIT_CELL_SIZES[unit] || UNIT_CELL_SIZES.weeks;

  // Unique event types from configured events (for legend)
  const activeEventTypes = useMemo(() => {
    if (!lifeEvents?.length) return [];
    const types = new Set(lifeEvents.filter(e => e.enabled).map(e => e.type));
    return [...types];
  }, [lifeEvents]);

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
        {/* Toggles */}
        <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
          <input type="checkbox" checked={showEvents} onChange={(e) => setShowEvents(e.target.checked)} className="rounded border-port-border" />
          Events
        </label>
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
        {showEvents && unit !== 'years' && (
          <>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-pink-500" /> Birthday</span>
            {activeEventTypes.map(type => {
              const style = EVENT_TYPE_STYLES[type];
              return style ? (
                <span key={type} className="flex items-center gap-1">
                  <span className={`w-2 h-2 rounded-sm ${style.bg}`} /> {type.charAt(0).toUpperCase() + type.slice(1)}
                </span>
              ) : null;
            })}
          </>
        )}
      </div>

      {/* Grid */}
      {unit === 'years' && (
        <YearGridView birthDate={birthDate} deathDate={deathDate} hideSpent={hideSpent} />
      )}
      {unit === 'months' && (
        <MonthGridView birthDate={birthDate} deathDate={deathDate} hideSpent={hideSpent} showEvents={showEvents} lifeEvents={lifeEvents} />
      )}
      {unit === 'weeks' && (
        <WeekGridView grid={grid} stats={stats} birthDate={birthDate} cellCfg={cellCfg} weekLayout={weekLayout} hideSpent={hideSpent} showEvents={showEvents} lifeEvents={lifeEvents} />
      )}
      {unit === 'days' && (
        <DayGridView birthDate={birthDate} deathDate={deathDate} cellCfg={cellCfg} stats={stats} showEvents={showEvents} />
      )}
    </div>
  );
}

// === Stats ===

function CompactStat({ icon: Icon, iconColor, label, value, sub }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <Icon size={14} className={`${iconColor} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-gray-400">{label}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-bold text-white">{typeof value === 'number' ? value.toLocaleString() : value}</div>
        {sub && <div className="text-[9px] text-gray-600">{sub}</div>}
      </div>
    </div>
  );
}

function TimeStats({ stats }) {
  const r = stats.remaining;
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 h-full">
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">Time Remaining</h3>
      <div className="divide-y divide-port-border">
        <CompactStat icon={Sun} iconColor="text-yellow-400" label="Saturdays" value={r.saturdays} sub={`${Math.round(r.saturdays / 52)}y`} />
        <CompactStat icon={Sun} iconColor="text-orange-400" label="Sundays" value={r.sundays} sub={`${Math.round(r.sundays / 52)}y`} />
        <CompactStat icon={CloudSun} iconColor="text-blue-400" label="Weekends" value={r.weekends} sub={`${Math.round(r.weekends * 2)} days`} />
        <CompactStat icon={Moon} iconColor="text-indigo-400" label="Sleep" value={`${Math.round(r.sleepHours / 24 / 365.25)}y`} sub={`${r.sleepHours.toLocaleString()}h`} />
        <CompactStat icon={Sun} iconColor="text-green-400" label="Awake Days" value={r.awakeDays} sub={`${Math.round(r.awakeDays / 365.25)}y`} />
        <CompactStat icon={Calendar} iconColor="text-purple-400" label="Months" value={r.months} />
        <CompactStat icon={Calendar} iconColor="text-teal-400" label="Weeks" value={r.weeks} />
        <CompactStat icon={Calendar} iconColor="text-port-accent" label="Days" value={r.days} />
        <CompactStat icon={Snowflake} iconColor="text-cyan-400" label="Winters" value={Math.floor(r.seasons / 4)} />
        <CompactStat icon={Flower2} iconColor="text-pink-400" label="Springs" value={Math.floor(r.seasons / 4)} />
        <CompactStat icon={TreePine} iconColor="text-green-400" label="Summers" value={Math.floor(r.seasons / 4)} />
        <CompactStat icon={Cake} iconColor="text-port-warning" label="Holidays" value={r.holidays} />
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
        className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 hover:text-white border border-dashed border-port-border rounded hover:border-port-accent/50 transition-colors"
      >
        <Plus size={14} />
        Add
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
    const event = lifeEvents?.find(e => e.id === id);
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
                className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-600 hover:text-port-error p-0.5"
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

// === Life Events Panel ===

const MONTH_NAMES_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EVENT_TYPES = [
  { id: 'holiday', label: 'Holiday' },
  { id: 'vacation', label: 'Vacation' },
  { id: 'milestone', label: 'Milestone' },
  { id: 'health', label: 'Health' },
  { id: 'custom', label: 'Custom' },
];

function LifeEventsPanel({ events, onAdd, onToggle, onRemove }) {
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);

  // Add form state
  const [name, setName] = useState('');
  const [type, setType] = useState('holiday');
  const [recurrence, setRecurrence] = useState('yearly');
  const [month, setMonth] = useState(0);
  const [day, setDay] = useState(1);
  const [date, setDate] = useState('');

  function resetForm() {
    setName('');
    setType('holiday');
    setRecurrence('yearly');
    setMonth(0);
    setDay(1);
    setDate('');
    setAdding(false);
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    const event = {
      name: name.trim(),
      type,
      recurrence,
      ...(recurrence === 'yearly' ? { month, day: parseInt(day) } : { date }),
    };
    onAdd(event);
    resetForm();
  }

  const enabledCount = events.filter(e => e.enabled).length;

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-port-bg/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Calendar size={16} className="text-amber-400" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Life Events</h3>
          <span className="text-xs text-gray-600">{enabledCount} active</span>
        </div>
        <ChevronDown size={16} className={`text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          {/* Event list */}
          <div className="space-y-1.5">
            {events.map(event => {
              const style = EVENT_TYPE_STYLES[event.type] || EVENT_TYPE_STYLES.custom;
              return (
                <div key={event.id} className="flex items-center gap-2.5 py-1.5 group">
                  <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${style.bg}`} />
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm ${event.enabled ? 'text-white' : 'text-gray-600 line-through'}`}>
                      {event.name}
                    </span>
                    <span className="text-[10px] text-gray-600 ml-2">
                      {event.recurrence === 'yearly'
                        ? `${MONTH_NAMES_FULL[event.month]} ${event.day}`
                        : event.date}
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-600">{event.type}</span>
                  <button
                    onClick={() => onToggle(event.id, !event.enabled)}
                    className="text-gray-500 hover:text-white transition-colors p-0.5"
                    title={event.enabled ? 'Disable' : 'Enable'}
                  >
                    {event.enabled ? <Eye size={12} /> : <EyeOff size={12} />}
                  </button>
                  <button
                    onClick={() => onRemove(event.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-600 hover:text-port-error p-0.5"
                    title="Remove"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Add form */}
          {adding ? (
            <form onSubmit={handleSubmit} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. Anniversary"
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Type</label>
                  <select
                    value={type}
                    onChange={e => setType(e.target.value)}
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                  >
                    {EVENT_TYPES.map(t => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-400 mb-1 block">Recurrence</label>
                  <select
                    value={recurrence}
                    onChange={e => setRecurrence(e.target.value)}
                    className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                  >
                    <option value="yearly">Yearly</option>
                    <option value="once">One-time</option>
                  </select>
                </div>
                {recurrence === 'yearly' ? (
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-xs text-gray-400 mb-1 block">Month</label>
                      <select
                        value={month}
                        onChange={e => setMonth(parseInt(e.target.value))}
                        className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                      >
                        {MONTH_NAMES_FULL.map((m, i) => (
                          <option key={i} value={i}>{m}</option>
                        ))}
                      </select>
                    </div>
                    <div className="w-16">
                      <label className="text-xs text-gray-400 mb-1 block">Day</label>
                      <input
                        type="number"
                        value={day}
                        onChange={e => setDay(e.target.value)}
                        min="1"
                        max="31"
                        className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                      />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="text-xs text-gray-400 mb-1 block">Date</label>
                    <input
                      type="date"
                      value={date}
                      onChange={e => setDate(e.target.value)}
                      className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-sm text-white focus:border-port-accent focus:outline-hidden"
                    />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button type="submit" disabled={!name.trim()} className="px-3 py-1.5 bg-port-accent text-white text-sm rounded hover:bg-port-accent/80 disabled:opacity-50 transition-colors">
                  Add Event
                </button>
                <button type="button" onClick={resetForm} className="px-3 py-1.5 text-gray-400 text-sm hover:text-white transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-400 hover:text-white border border-dashed border-port-border rounded hover:border-port-accent/50 transition-colors"
            >
              <Plus size={14} />
              Add Event
            </button>
          )}
        </div>
      )}
    </div>
  );
}
