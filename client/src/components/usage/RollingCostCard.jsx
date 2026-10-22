import { useState } from 'react';
import { countSparklineGeometry } from '../../lib/editorialHealth';
import { formatUsd } from '../../utils/formatters';

const WIDTH = 300;
const HEIGHT = 96;
const PAD = 2;

// Series dates are UTC calendar days (server/services/peerUsage.js), so they
// are labeled in UTC or a west-of-UTC viewer would see every day shifted.
const dayLabel = (date) => new Date(`${date}T00:00:00Z`)
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Trailing-30-day estimated API cost summed across every instance, one point
 * per day. Tap or drag the chart to read a day; the headline shows today until
 * then. Hand-drawn SVG: the shape is one area and one line.
 */
export default function RollingCostCard({ rollingCost }) {
  const [selected, setSelected] = useState(null);
  const points = rollingCost?.points || [];
  if (points.length < 2) return null;

  const { coords } = countSparklineGeometry(points.map((p) => p.cost), { width: WIDTH, height: HEIGHT, pad: PAD });
  const line = coords.map((c, i) => `${i ? 'L' : 'M'}${c.x},${c.y}`).join('');
  const area = `${line}L${coords.at(-1).x},${HEIGHT}L${coords[0].x},${HEIGHT}Z`;
  const index = selected ?? points.length - 1;
  const point = points[index];
  const marker = coords[index];
  const instances = rollingCost.instanceCount || 1;

  const pick = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setSelected(Math.round(fraction * (points.length - 1)));
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-gray-400">Est. API cost, rolling {rollingCost.windowDays || 30} days</h3>
          <p className="text-[10px] sm:text-xs text-gray-500">
            {instances > 1 ? `${instances} instances` : 'This machine'}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-xl font-bold text-port-success tabular-nums">{formatUsd(point.cost)}</div>
          <div className="text-[10px] sm:text-xs text-gray-500">{selected === null ? 'Today' : dayLabel(point.date)}</div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="w-full h-24 sm:h-32 touch-none cursor-crosshair select-none"
        role="img"
        aria-label={`Rolling ${rollingCost.windowDays || 30}-day estimated API cost from ${dayLabel(points[0].date)} to ${dayLabel(points.at(-1).date)}, now ${formatUsd(points.at(-1).cost)}`}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); pick(event); }}
        onPointerMove={(event) => { if (event.buttons || event.pointerType === 'mouse') pick(event); }}
        onPointerLeave={(event) => { if (event.pointerType === 'mouse') setSelected(null); }}
      >
        <path d={area} className="fill-port-success/15" />
        <path d={line} fill="none" className="stroke-port-success" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {selected !== null && <line x1={marker.x} x2={marker.x} y1={0} y2={HEIGHT} className="stroke-gray-500" strokeWidth="1" vectorEffect="non-scaling-stroke" strokeDasharray="3 3" />}
      </svg>
      <div className="flex justify-between text-[10px] sm:text-xs text-gray-500">
        <span>{dayLabel(points[0].date)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}
