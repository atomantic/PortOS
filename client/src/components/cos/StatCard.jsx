export default function StatCard({ label, value, icon, active, activeLabel, compact, mini }) {
  if (compact) {
    return (
      <div className={`bg-port-card/80 border rounded-lg px-3 py-2 flex items-center gap-3 ${
        active ? 'border-port-accent shadow-md shadow-port-accent/20' : 'border-port-border'
      }`}>
        <div className={`shrink-0 ${active ? 'animate-pulse' : ''}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs text-gray-500 truncate">{label}</div>
          <div className="text-base font-bold text-white">{value}</div>
        </div>
      </div>
    );
  }

  if (mini) {
    return (
      <div className={`bg-port-card border rounded p-1.5 sm:p-2 lg:p-3 transition-all ${
        active ? 'border-port-accent shadow-md shadow-port-accent/20' : 'border-port-border'
      }`}>
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[10px] sm:text-xs text-gray-500 truncate">{label}</span>
          <div className={`shrink-0 ${active ? 'animate-pulse' : ''}`}>
            {icon}
          </div>
        </div>
        <div className="text-sm sm:text-base lg:text-xl font-bold text-white">{value}</div>
      </div>
    );
  }

  return (
    <div className={`bg-port-card border rounded-lg p-2 sm:p-3 lg:p-4 transition-all ${
      active ? 'border-port-accent shadow-lg shadow-port-accent/20' : 'border-port-border'
    }`}>
      <div className="flex items-center justify-between mb-0.5 sm:mb-1 lg:mb-2">
        <span className="text-xs sm:text-sm text-gray-500 truncate mr-1">{label}</span>
        <div className={`shrink-0 ${active ? 'animate-pulse' : ''}`}>
          {icon}
        </div>
      </div>
      <div className="text-lg sm:text-xl lg:text-2xl font-bold text-white">{value}</div>
      {active && activeLabel && (
        <div className="text-xs text-port-accent mt-0.5 sm:mt-1 truncate animate-pulse">
          {activeLabel}
        </div>
      )}
    </div>
  );
}
