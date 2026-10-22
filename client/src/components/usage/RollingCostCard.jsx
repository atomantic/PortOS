import { useEffect, useMemo, useState } from 'react';
import useContainerWidth from '../../hooks/useContainerWidth';
import * as api from '../../services/api';
import { formatUsd } from '../../utils/formatters';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const RANGES = [
  { id: '1m', label: '1M' },
  { id: '3m', label: '3M' },
  { id: '6m', label: '6M' },
  { id: '1y', label: '1Y' },
  { id: 'all', label: 'All' },
];
const RANGE_KEY = 'usage:rollingCostRange';
const DEFAULT_RANGE = '3m';

// Plans keep one color across ranges and reloads; anything else takes the
// next free palette slot in the server's (largest-first) order.
const FAMILY_COLORS = {
  claude: 'rgb(var(--port-chart-3))',
  codex: 'rgb(var(--port-chart-2))',
  agy: 'rgb(var(--port-chart-1))',
  grok: 'rgb(var(--port-chart-4))',
};
const SPARE_COLORS = ['rgb(var(--port-accent-2))', 'rgb(var(--port-chart-1))', 'rgb(var(--port-chart-2))', 'rgb(var(--port-chart-4))'];
const OTHER_COLOR = 'rgb(156 163 175)';

export function seriesColors(series) {
  const used = new Set();
  const fixed = series.map((s) => {
    const color = s.key === 'other' ? OTHER_COLOR : FAMILY_COLORS[s.key];
    if (color) used.add(color);
    return color;
  });
  const spare = SPARE_COLORS.filter((c) => !used.has(c));
  return fixed.map((color) => color || spare.shift() || OTHER_COLOR);
}

/** Round axis ticks from zero: 1, 2, 2.5 or 5 × 10^n per step, about four steps. */
export function niceTicks(max, target = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step * 100) / 100);
}

// Series dates are UTC calendar days (server/services/peerUsage.js), so they
// are labeled in UTC or a west-of-UTC viewer would see every day shifted.
const dayLabel = (date) => new Date(`${date}T00:00:00Z`)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const compactUsd = (v) => formatUsd(v, { compact: true });

// Pin labels are 10px tabular text; their width is estimated from length so
// the row layout runs before paint. Overlapping labels move down a row.
const labelWidthPx = (text) => text.length * 5.8 + 10;
const LABEL_GAP_PX = 4;
const MAX_LABEL_ROWS = 4;
// A tap this close to an existing pin removes it rather than adding a neighbor.
const UNPIN_SLOP_PX = 14;

/**
 * Trailing-30-day estimated API cost summed across every instance, stacked by
 * plan, one point per day over a chosen range. Tap to pin a day (date and
 * total); tap a pin to remove it. The legend reads the newest pin, else today.
 * Hand-drawn SVG.
 */
export default function RollingCostCard() {
  const [range, setRange] = useState(() => {
    const saved = safeReadStorage(RANGE_KEY);
    return RANGES.some((r) => r.id === saved) ? saved : DEFAULT_RANGE;
  });
  // undefined = loading, null = the read failed
  const [data, setData] = useState(undefined);
  const [pins, setPins] = useState([]);
  // Keyboard cursor (a point index): arrows move it, Enter/Space pins it.
  const [cursor, setCursor] = useState(null);
  const [plotRef, plotWidth] = useContainerWidth();

  useEffect(() => {
    let cancelled = false;
    api.getUsageRollingCost({ range }, { silent: true })
      .catch(() => null)
      .then((result) => { if (!cancelled) setData(result); });
    return () => { cancelled = true; };
  }, [range]);

  const chooseRange = (id) => {
    setRange(id);
    safeWriteStorage(RANGE_KEY, id);
  };

  const points = data?.points || [];
  const series = data?.series || [];
  const colors = useMemo(() => seriesColors(series), [series]);
  const ticks = useMemo(() => niceTicks(Math.max(0, ...points.map((p) => p.cost))), [points]);
  const top = ticks.at(-1);

  const indexByDate = useMemo(() => new Map(points.map((p, i) => [p.date, i])), [points]);
  const xPct = (i) => (points.length > 1 ? (i / (points.length - 1)) * 100 : 0);
  const yPct = (v) => 100 - (v / top) * 100;

  // Each plan's band sits on the sum of the plans below it.
  const areas = useMemo(() => {
    const x = (i) => (i / Math.max(1, points.length - 1)) * 100;
    const y = (v) => 100 - (v / top) * 100;
    const below = points.map(() => 0);
    return series.map((_, j) => {
      const lower = [...below];
      points.forEach((p, i) => { below[i] += p.values?.[j] || 0; });
      const upperPath = points.map((_, i) => `${i ? 'L' : 'M'}${x(i)},${y(below[i])}`).join('');
      const lowerPath = points.map((_, i) => i).reverse().map((i) => `L${x(i)},${y(lower[i])}`).join('');
      return `${upperPath}${lowerPath}Z`;
    });
  }, [points, series, top]);

  if (data === null) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-sm text-gray-500">
        Couldn&rsquo;t read the rolling API cost.
      </div>
    );
  }

  const visiblePins = pins.filter((date) => indexByDate.has(date));
  const focusDate = visiblePins.at(-1) ?? points.at(-1)?.date;
  const focus = points[indexByDate.get(focusDate)];
  const today = points.at(-1);

  const togglePin = (event) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box?.width || points.length < 2) return;
    const px = event.clientX - box.left;
    const nearest = visiblePins
      .map((date) => ({ date, gap: Math.abs((xPct(indexByDate.get(date)) / 100) * box.width - px) }))
      .sort((a, b) => a.gap - b.gap)[0];
    if (nearest && nearest.gap <= UNPIN_SLOP_PX) {
      setPins((prev) => prev.filter((d) => d !== nearest.date));
      return;
    }
    pinIndex(Math.round(Math.min(1, Math.max(0, px / box.width)) * (points.length - 1)));
  };

  function pinIndex(index) {
    const date = points[index].date;
    setPins((prev) => (prev.includes(date) && cursor === index
      ? prev.filter((d) => d !== date)
      : [...prev.filter((d) => d !== date), date]));
  }

  const onKeyDown = (event) => {
    const last = points.length - 1;
    const at = cursor ?? last;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setCursor(Math.min(last, Math.max(0, at + (event.key === 'ArrowLeft' ? -1 : 1))));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setCursor(at);
      pinIndex(at);
    }
  };

  // Stack labels left to right, centered on their pin unless that would run
  // off an edge; one that would overlap the previous label in its row drops to
  // the next row.
  const width = plotWidth || 300;
  const rowEnds = [];
  const labels = [...visiblePins]
    .sort((a, b) => indexByDate.get(a) - indexByDate.get(b))
    .map((date) => {
      const index = indexByDate.get(date);
      const x = xPct(index);
      const text = `${dayLabel(date)} · ${compactUsd(points[index].cost)}`;
      const w = labelWidthPx(text);
      const px = (x / 100) * width;
      const align = px - w / 2 < 0 ? 'left' : px + w / 2 > width ? 'right' : 'center';
      const left = align === 'left' ? px : align === 'right' ? px - w : px - w / 2;
      let row = rowEnds.findIndex((end) => end + LABEL_GAP_PX <= left);
      if (row === -1) row = rowEnds.length < MAX_LABEL_ROWS ? rowEnds.length : rowEnds.indexOf(Math.min(...rowEnds));
      rowEnds[row] = left + w;
      return { date, index, x, row, text, align };
    });

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-gray-400">Est. API cost, rolling {data?.windowDays || 30} days</h3>
          {data && (
            <p className="text-[10px] sm:text-xs text-gray-500">
              {data.instanceCount > 1 ? `${data.instanceCount} instances` : 'This machine'}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-bold text-port-success tabular-nums">{today ? formatUsd(today.cost) : '—'}</div>
          <div className="text-[10px] sm:text-xs text-gray-500">Today</div>
        </div>
      </div>

      <div className="flex gap-1" role="group" aria-label="Chart range">
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => chooseRange(r.id)}
            aria-pressed={range === r.id}
            className={`min-h-9 px-3 rounded-full text-xs border ${range === r.id
              ? 'bg-port-accent/20 border-port-accent text-white'
              : 'border-port-border text-gray-400 hover:text-white'}`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {points.length < 2 ? (
        <div className="h-40 sm:h-48 flex items-center justify-center text-sm text-gray-500">
          {data === undefined ? 'Loading…' : 'No usage in this range.'}
        </div>
      ) : (
        <>
          <div className="flex gap-1 pt-1">
            <div className="relative w-11 shrink-0 h-40 sm:h-48" aria-hidden="true">
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute right-0 -translate-y-1/2 text-[10px] text-gray-500 tabular-nums"
                  style={{ top: `${yPct(t)}%` }}
                >
                  {compactUsd(t)}
                </span>
              ))}
            </div>
            <div
              ref={plotRef}
              className="relative flex-1 h-40 sm:h-48 cursor-crosshair select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-port-accent"
              role="group"
              tabIndex={0}
              aria-label="Tap a day to pin it; arrow keys and Enter pin from the keyboard"
              onClick={togglePin}
              onKeyDown={onKeyDown}
              onBlur={() => setCursor(null)}
            >
              <svg
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full overflow-visible"
                role="img"
                aria-label={`Rolling ${data.windowDays}-day estimated API cost from ${dayLabel(points[0].date)} to ${dayLabel(today.date)}, now ${formatUsd(today.cost)}`}
              >
                {ticks.map((t) => (
                  <line key={t} x1="0" x2="100" y1={yPct(t)} y2={yPct(t)} className="stroke-port-border" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                ))}
                {areas.map((d, j) => (
                  <path key={series[j].key} d={d} style={{ fill: colors[j] }} fillOpacity="0.75" stroke={colors[j]} strokeWidth="1" vectorEffect="non-scaling-stroke" />
                ))}
                {cursor !== null && points[cursor] && (
                  <line x1={xPct(cursor)} x2={xPct(cursor)} y1="0" y2="100" className="stroke-port-accent" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                )}
                {labels.map((l) => (
                  <line key={l.date} x1={l.x} x2={l.x} y1="0" y2="100" className="stroke-gray-400" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="3 3" />
                ))}
              </svg>
              {labels.map((l) => (
                <span
                  key={l.date}
                  className="absolute w-2 h-2 -ml-1 -mt-1 rounded-full bg-gray-400 pointer-events-none"
                  style={{ left: `${l.x}%`, top: `${yPct(points[l.index].cost)}%` }}
                />
              ))}
              {labels.map((l) => (
                <span
                  key={l.date}
                  className="absolute whitespace-nowrap rounded border border-port-border bg-port-card/90 px-1 text-[10px] text-white tabular-nums pointer-events-none"
                  style={{
                    left: `${l.x}%`,
                    top: l.row * 18,
                    transform: { left: 'none', right: 'translateX(-100%)', center: 'translateX(-50%)' }[l.align],
                  }}
                >
                  {l.text}
                </span>
              ))}
            </div>
          </div>
          <div className="flex justify-between items-center pl-12 text-[10px] sm:text-xs text-gray-500">
            <span>{dayLabel(points[0].date)}</span>
            {visiblePins.length > 0 && (
              <button type="button" onClick={() => setPins([])} className="min-h-9 px-2 hover:text-white">
                Clear pins
              </button>
            )}
            <span>Today</span>
          </div>
        </>
      )}

      {focus && series.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] sm:text-xs text-gray-500">{focusDate === today?.date ? 'Today' : dayLabel(focusDate)}</div>
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 text-xs">
            {series.map((s, j) => (
              <li key={s.key} className="flex items-center gap-1.5 min-w-0">
                <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colors[j] }} />
                <span className="truncate text-gray-300">{s.label}</span>
                <span className="ml-auto tabular-nums text-white">{formatUsd(focus.values?.[j])}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
