import { Fragment, useMemo, useState } from 'react';
import { Calendar } from 'lucide-react';
import useContainerWidth from '../../../../hooks/useContainerWidth';
import { usePersistedState } from './usePersistedState';
import {
  MS_PER_DAY, DAY_LABELS, UNIT_MODES, WEEK_LAYOUTS, UNIT_CELL_SIZES,
  EVENT_TYPE_STYLES, cellClasses, computeYearGrid, computeMonthGrid,
  computeMonthCalendars, computeEventWeeks,
} from './lifeGridMath';

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

// === Life Grid (main grid card) ===

export default function LifeGrid({ grid, stats, birthDate, deathDate, lifeEvents }) {
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
