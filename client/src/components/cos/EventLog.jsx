const levelColors = {
  info: 'text-port-accent',
  warn: 'text-port-warning',
  error: 'text-port-error',
  success: 'text-port-success',
  debug: 'text-gray-500'
};

const levelIcons = {
  info: 'i',
  warn: '!',
  error: 'x',
  success: '+',
  debug: '?'
};

export default function EventLog({ logs }) {
  if (!logs || logs.length === 0) return null;

  return (
    <div className="mt-4 w-full min-w-0 flex-1 min-h-0 flex flex-col">
      <div className="text-xs text-gray-500 mb-1 font-mono">Event Log</div>
      <div className="bg-port-bg/80 border border-port-border/50 rounded-lg p-2 flex-1 min-w-0 min-h-[8rem] max-h-[32rem] overflow-y-auto">
        {logs.slice(-25).reverse().map((log, i) => (
          <div key={i} className={`text-xs font-mono py-0.5 break-all ${levelColors[log.level] || 'text-gray-400'}`}>
            <span className="mr-1">[{levelIcons[log.level] || '*'}]</span>
            <span className="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
            {' '}
            <span>{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
