import { Html } from '@react-three/drei';

const STATUS_ICONS = {
  online: '\u25CF',
  stopped: '\u25A0',
  not_started: '\u25CB',
  not_found: '\u25CB',
};

export default function HolographicPanel({ app, agentCount, position, expanded = false }) {
  const statusColors = {
    online: 'border-cyan-500/50 text-cyan-400',
    stopped: 'border-red-500/50 text-red-400',
    not_started: 'border-violet-500/50 text-violet-400',
    not_found: 'border-violet-500/50 text-violet-400',
  };

  const statusDotColors = {
    online: 'text-cyan-400',
    stopped: 'text-red-400',
    not_started: 'text-violet-400',
    not_found: 'text-violet-400',
  };

  const colorClass = app.archived
    ? 'border-slate-500/50 text-slate-400'
    : statusColors[app.overallStatus] || statusColors.not_started;

  const dotColor = app.archived
    ? 'text-slate-500'
    : statusDotColors[app.overallStatus] || 'text-violet-400';

  const processCount = app.processes?.length || 0;

  return (
    <Html
      position={position}
      center
      distanceFactor={expanded ? 8 : 15}
      occlude
      style={{ pointerEvents: 'none' }}
    >
      <div className={`bg-black/90 border ${colorClass} rounded-md ${expanded ? 'px-4 py-3' : 'px-3 py-2'} whitespace-nowrap backdrop-blur-sm`} style={{ boxShadow: expanded ? '0 0 20px rgba(6,182,212,0.3)' : '0 0 12px rgba(0,0,0,0.5)' }}>
        <div className={`font-pixel tracking-wider truncate font-bold ${expanded ? 'text-[14px] max-w-[200px]' : 'text-[12px] max-w-[160px]'}`}>{app.name}</div>
        <div className="flex items-center gap-2 text-[9px] font-pixel tracking-wide mt-1">
          <span className={dotColor}>
            {STATUS_ICONS[app.overallStatus] || '\u25CB'}
          </span>
          <span className="opacity-80">{app.archived ? 'ARCHIVED' : (app.overallStatus || '').toUpperCase().replace('_', ' ')}</span>
          {processCount > 0 && (
            <span className="opacity-50">| {processCount} PROC</span>
          )}
          {agentCount > 0 && (
            <span className="opacity-50">| {agentCount} AGENT{agentCount > 1 ? 'S' : ''}</span>
          )}
        </div>
        <div className="font-pixel text-[8px] text-cyan-500/30 tracking-widest mt-1">
          {expanded ? 'PRESS E TO ENTER' : 'CLICK TO VIEW'}
        </div>
      </div>
    </Html>
  );
}
