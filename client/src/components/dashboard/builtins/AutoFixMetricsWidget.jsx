import { memo } from 'react';
import { Link } from 'react-router-dom';
import { Wrench, ArrowRight } from 'lucide-react';
import * as api from '../../../services/api';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch';
import { formatDurationMs } from '../../../utils/formatters';

// Auto-fix telemetry (issue #2328). Self-fetches the aggregated
// GET /api/autofix/metrics (derived server-side from persisted
// metadata.diagnostics) — this data is NOT part of dashboardState, so unlike
// the dashboardState-slice widgets this one owns its own poll. Renders the
// overall auto-fix success rate, a daily success-rate trend sparkline, the
// fallback-tier breakdown, and median time-to-recovery.

const TIER_COLORS = {
  1: '#22c55e', // port-success — config/env (cheapest fix)
  2: '#3b82f6', // port-accent  — schema/type
  3: '#f59e0b', // port-warning — constrained-agent-retry
  4: '#ef4444', // port-error   — escalate
};

// Render a rate in [0,1] as a percent string, or an em dash for the null
// sentinel ("no data yet" must not read as 0%).
const pct = (rate) => (rate == null ? '—' : `${Math.round(rate * 100)}%`);

// Inline SVG sparkline of the daily success-rate trend. No chart dependency —
// a handful of points plotted on a 0–100 y-axis. Days with a null rate (no
// denominator) are skipped so a gap doesn't read as 0%.
function TrendSparkline({ trend }) {
  const points = (trend || []).filter((d) => d.successRate != null);
  if (points.length < 2) return null;

  const W = 120;
  const H = 28;
  const stepX = W / (points.length - 1);
  const coords = points.map((d, i) => {
    const x = i * stepX;
    const y = H - d.successRate * H; // 0% at bottom, 100% at top
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1];
  const lastX = (points.length - 1) * stepX;
  const lastY = H - last.successRate * H;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="overflow-visible"
      role="img"
      aria-label={`Success-rate trend, latest ${pct(last.successRate)}`}
    >
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="#3b82f6"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r="2" fill="#3b82f6" />
    </svg>
  );
}

function AutoFixMetricsWidget() {
  const { data, loading } = useAutoRefetch(
    () => api.getAutoFixMetrics({ silent: true }),
    60000,
    {
      // Skip the re-render when nothing observable moved. `generatedAt` is the
      // server's wall clock and changes every poll, so it must NOT be part of
      // this comparison — key on the aggregates the widget actually renders.
      compare: (prev, next) =>
        prev?.total === next?.total
        && prev?.overall?.resolved === next?.overall?.resolved
        && prev?.overall?.open === next?.overall?.open
        && (prev?.timeToRecovery?.count ?? null) === (next?.timeToRecovery?.count ?? null)
        && (prev?.timeToRecovery?.medianMs ?? null) === (next?.timeToRecovery?.medianMs ?? null)
        && (prev?.trend?.length ?? 0) === (next?.trend?.length ?? 0),
    },
  );

  const header = (
    <div className="flex items-center gap-2 mb-3">
      <Wrench size={16} className="text-gray-500" />
      <h3 className="text-sm font-semibold text-white">Auto-Fix Telemetry</h3>
      <Link to="/cos" className="ml-auto flex items-center gap-1 text-xs text-port-accent hover:underline">
        Open <ArrowRight size={12} />
      </Link>
    </div>
  );

  const shell = (children) => (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full">
      {header}
      {children}
    </div>
  );

  if (loading && !data) {
    return shell(<div className="text-xs text-gray-500">Loading…</div>);
  }

  // Empty state — no diagnostics-bearing tasks yet. Distinct from a 0% rate.
  if (!data || data.total === 0) {
    return shell(
      <div className="text-xs text-gray-500">
        No auto-fix activity yet. Provider/agent failures that trigger an
        investigation task will show up here, broken out by fallback tier and
        recovery rate.
      </div>,
    );
  }

  const { total, overall, byTier, timeToRecovery, trend } = data;

  return shell(
    <>
      <div className="flex items-end gap-3 mb-3">
        <div>
          <div className="text-2xl font-bold text-white leading-none">{pct(overall.successRate)}</div>
          <div className="text-xs text-gray-500 mt-1">
            {overall.resolved}/{total} recovered
          </div>
        </div>
        <div className="ml-auto">
          <TrendSparkline trend={trend} />
        </div>
      </div>

      <div className="space-y-1.5 mb-3">
        {byTier.map((t) => (
          <div key={t.tier} className="flex items-center gap-2 text-xs">
            <span
              className="inline-block w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: TIER_COLORS[t.tier] || '#6b7280' }}
              aria-hidden="true"
            />
            <span className="text-gray-300 flex-1 truncate" title={t.label}>
              T{t.tier} · {t.strategy}
            </span>
            <span className="text-gray-500 tabular-nums">
              {t.resolved}/{t.total}
            </span>
            <span className="text-gray-400 tabular-nums w-9 text-right">{pct(t.successRate)}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs border-t border-port-border pt-2">
        <span className="text-gray-500">Median recovery</span>
        <span className="text-gray-300 tabular-nums">
          {timeToRecovery ? formatDurationMs(timeToRecovery.medianMs) : '—'}
        </span>
      </div>
    </>,
  );
}

export default memo(AutoFixMetricsWidget);
