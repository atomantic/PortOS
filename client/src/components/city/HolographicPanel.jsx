import { Html } from '@react-three/drei';

export default function HolographicPanel({ app, agentCount, position }) {
  const statusColors = {
    online: 'border-cyan-500/50 text-cyan-400',
    stopped: 'border-amber-500/50 text-amber-400',
    not_started: 'border-indigo-500/50 text-indigo-400',
    not_found: 'border-indigo-500/50 text-indigo-400',
  };

  const colorClass = app.archived
    ? 'border-slate-500/50 text-slate-400'
    : statusColors[app.overallStatus] || statusColors.not_started;

  return (
    <Html
      position={position}
      center
      distanceFactor={15}
      occlude
      style={{ pointerEvents: 'none' }}
    >
      <div className={`bg-black/80 border ${colorClass} rounded px-2 py-1 font-mono text-xs whitespace-nowrap backdrop-blur-sm`}>
        <div className="font-bold text-[10px] truncate max-w-[120px]">{app.name}</div>
        <div className="flex items-center gap-1 text-[9px] opacity-75">
          <span>{app.archived ? 'archived' : app.overallStatus}</span>
          {agentCount > 0 && <span>| {agentCount} agent{agentCount > 1 ? 's' : ''}</span>}
        </div>
      </div>
    </Html>
  );
}
