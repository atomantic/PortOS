import { useRef, useEffect, useState } from 'react';

const LEVEL_COLORS = {
  info: 'text-cyan-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  success: 'text-emerald-400',
  debug: 'text-gray-500',
};

const LEVEL_INDICATORS = {
  info: 'bg-cyan-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
  success: 'bg-emerald-400',
  debug: 'bg-gray-600',
};

export default function CityActivityLog({ logs }) {
  const scrollRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (logs.length === 0) return null;

  return (
    <div className={`absolute top-16 right-3 ${collapsed ? '' : 'bottom-20'} w-72 pointer-events-auto`}>
      <div className={`${collapsed ? '' : 'h-full'} bg-black/80 backdrop-blur-sm border border-cyan-500/25 rounded-lg overflow-hidden flex flex-col`}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-between px-3 py-2 border-b border-cyan-500/20 hover:bg-cyan-500/5 transition-colors"
        >
          <span className="text-cyan-400 text-[11px] font-pixel tracking-wider font-bold">
            ACTIVITY LOG
          </span>
          <div className="flex items-center gap-2">
            <span className="font-pixel text-[9px] text-cyan-500/40">{logs.length}</span>
            <span className="font-pixel text-[10px] text-cyan-500/50">
              {collapsed ? '[+]' : '[-]'}
            </span>
          </div>
        </button>
        {!collapsed && (
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-1.5 space-y-1"
            style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(6,182,212,0.2) transparent' }}
          >
            {logs.slice(-40).map((log, i) => {
              const level = log.level || 'info';
              const colorClass = LEVEL_COLORS[level] || LEVEL_COLORS.info;
              const indicatorClass = LEVEL_INDICATORS[level] || LEVEL_INDICATORS.info;
              const time = log.timestamp
                ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                : '';
              const message = log.message || log.event || JSON.stringify(log);

              return (
                <div
                  key={i}
                  className="font-pixel text-[9px] leading-tight flex items-start gap-1.5 tracking-wide group hover:bg-cyan-500/5 rounded px-1 py-0.5 -mx-1 transition-colors"
                  title={message}
                >
                  <span className={`w-1 h-1 rounded-full ${indicatorClass} shrink-0 mt-1 opacity-70`} />
                  <span className="text-gray-500 shrink-0">{time}</span>
                  <span className={`${colorClass} truncate group-hover:whitespace-normal group-hover:break-all`}>{message}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
