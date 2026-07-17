// Small presentational bits shared by the City HUD panels (desktop cockpit +
// compact/phone disclosure surfaces). Extracted so the vitals rows, health
// sentinel and corner chrome render identically in both layouts instead of being
// copy-pasted per host.

// Animated corner decoration for HUD panels.
export function HudCorner({ position = 'tl', color = 'cyan' }) {
  const corners = {
    tl: 'top-0 left-0 border-t border-l',
    tr: 'top-0 right-0 border-t border-r',
    bl: 'bottom-0 left-0 border-b border-l',
    br: 'bottom-0 right-0 border-b border-r',
  };
  return (
    <div
      className={`absolute w-2 h-2 ${corners[position]} border-${color}-400/60`}
      style={{ borderWidth: '1px' }}
    />
  );
}

export function HealthBar({ value, max, color }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="w-full h-1 bg-gray-800/60 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-1000"
        style={{ width: `${pct}%`, backgroundColor: color, boxShadow: `0 0 4px ${color}` }}
      />
    </div>
  );
}

// A tappable vitals row (label + value). 44px min height keeps it a valid touch
// target on phone where these rows become the primary controls.
export function StatButton({ label, valueClass, value, onClick, title, prefix = null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title || label}
      className="w-full flex items-center justify-between gap-6 -mx-1 px-1 py-0.5 min-h-[44px] sm:min-h-0 rounded hover:bg-cyan-500/5 transition-colors"
    >
      <span className="font-pixel text-[10px] text-gray-400 tracking-wide">{label}</span>
      <span className={`font-pixel text-[11px] ${valueClass || 'text-cyan-400'}`}>
        {prefix}
        {value}
      </span>
    </button>
  );
}

export const getHealthSentinel = (systemHealth, onlineRatio) => {
  if (systemHealth?.overallHealth === 'critical') return { dot: 'bg-port-error', text: 'text-port-error', label: 'CRITICAL' };
  if (systemHealth?.overallHealth === 'warning') return { dot: 'bg-port-warning', text: 'text-port-warning', label: 'WARN' };
  if (systemHealth?.overallHealth === 'healthy') return { dot: 'bg-port-success', text: 'text-port-success', label: 'OK' };
  if (onlineRatio >= 0.8) return { dot: 'bg-cyan-400', text: 'text-cyan-400', label: 'OK' };
  if (onlineRatio >= 0.5) return { dot: 'bg-port-warning', text: 'text-port-warning', label: 'WARN' };
  return { dot: 'bg-port-error', text: 'text-port-error', label: 'CRIT' };
};

export const metricColor = (pct) => {
  if (pct == null) return 'text-gray-500';
  if (pct >= 90) return 'text-port-error';
  if (pct >= 75) return 'text-port-warning';
  return 'text-cyan-400';
};
