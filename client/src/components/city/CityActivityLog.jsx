import { useRef, useEffect } from 'react';

const LEVEL_COLORS = {
  info: 'text-cyan-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  success: 'text-emerald-400',
  debug: 'text-gray-500',
};

export default function CityActivityLog({ logs }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (logs.length === 0) return null;

  return (
    <div className="absolute top-16 right-3 bottom-20 w-72 pointer-events-auto">
      <div className="h-full bg-black/60 backdrop-blur-sm border border-cyan-500/20 rounded-lg overflow-hidden flex flex-col">
        <div className="px-3 py-2 border-b border-cyan-500/20 text-cyan-400 text-xs font-mono font-bold">
          ACTIVITY LOG
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-1 space-y-0.5">
          {logs.slice(-30).map((log, i) => {
            const level = log.level || 'info';
            const colorClass = LEVEL_COLORS[level] || LEVEL_COLORS.info;
            const time = log.timestamp
              ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
              : '';

            return (
              <div key={i} className="font-mono text-[10px] leading-tight flex gap-1.5">
                <span className="text-gray-600 shrink-0">{time}</span>
                <span className={colorClass}>{log.message || log.event || JSON.stringify(log)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
