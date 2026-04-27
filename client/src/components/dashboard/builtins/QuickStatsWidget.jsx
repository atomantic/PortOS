export default function QuickStatsWidget({ dashboardState }) {
  const { appStats } = dashboardState;
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 h-full">
      <h3 className="text-sm font-semibold text-white mb-3">Quick Stats</h3>
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Total Apps" value={appStats.total} icon="📦" />
        <StatCard label="Online" value={appStats.online} icon="🟢" />
        <StatCard label="Stopped" value={appStats.stopped} icon="🟡" />
        <StatCard label="Offline" value={appStats.notStarted} icon="⚪" />
      </div>
    </div>
  );
}

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3" role="group" aria-label={`${label}: ${value}`}>
      <div className="flex items-center gap-2 mb-1">
        <span aria-hidden="true" className="text-base">{icon}</span>
        <span className="text-xs text-gray-500">{label}</span>
      </div>
      <div className="text-xl font-bold text-white">{value}</div>
    </div>
  );
}
