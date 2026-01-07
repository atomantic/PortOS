const levelColors = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
  success: 'text-green-400',
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
    <div className="mt-4 w-full max-w-[280px]">
      <div className="text-xs text-gray-500 mb-1 font-mono">Event Log</div>
      <div className="bg-slate-900/80 border border-slate-700/50 rounded-lg p-2 max-h-32 overflow-y-auto">
        {logs.slice(-5).reverse().map((log, i) => (
          <div key={i} className={`text-xs font-mono py-0.5 ${levelColors[log.level] || 'text-gray-400'}`}>
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
