export default function StatCard({ label, value, icon, active, activeLabel }) {
  return (
    <div className={`bg-port-card border rounded-lg p-4 transition-all ${
      active ? 'border-port-accent shadow-lg shadow-port-accent/20' : 'border-port-border'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500">{label}</span>
        <div className={active ? 'animate-pulse' : ''}>
          {icon}
        </div>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {active && activeLabel && (
        <div className="text-xs text-port-accent mt-1 truncate animate-pulse">
          {activeLabel}
        </div>
      )}
    </div>
  );
}
