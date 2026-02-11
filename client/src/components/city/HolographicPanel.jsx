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
      <div className={`bg-black/85 border ${colorClass} rounded px-2.5 py-1.5 whitespace-nowrap backdrop-blur-sm`}>
        <div className="font-pixel text-[11px] tracking-wider truncate max-w-[140px]">{app.name}</div>
        <div className="flex items-center gap-1.5 text-[9px] font-pixel tracking-wide opacity-75 mt-0.5">
          <span>{app.archived ? 'ARCHIVED' : (app.overallStatus || '').toUpperCase().replace('_', ' ')}</span>
          {agentCount > 0 && <span>| {agentCount} AGENT{agentCount > 1 ? 'S' : ''}</span>}
        </div>
      </div>
    </Html>
  );
}
