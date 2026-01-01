import { useEffect, useRef } from 'react';

export default function LogViewer({ logs, autoScroll = true, maxHeight = '500px' }) {
  const containerRef = useRef(null);
  const shouldScrollRef = useRef(true);

  useEffect(() => {
    if (autoScroll && shouldScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // Auto-scroll if user is near bottom (within 50px)
    shouldScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  const getLineClass = (type) => {
    switch (type) {
      case 'stderr':
        return 'text-port-warning';
      case 'connected':
        return 'text-port-success';
      case 'error':
        return 'text-port-error';
      default:
        return 'text-gray-300';
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="bg-port-bg border border-port-border rounded-lg overflow-auto font-mono text-sm"
      style={{ maxHeight }}
    >
      {logs.length === 0 ? (
        <div className="p-4 text-gray-500 text-center">
          No logs available. Select a process and click "Start Streaming" to begin.
        </div>
      ) : (
        <div className="p-3 space-y-0.5">
          {logs.map((log, index) => (
            <div key={index} className={`${getLineClass(log.type)} break-all`}>
              {log.timestamp && (
                <span className="text-gray-600 mr-2">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
              )}
              <span>{log.line || log.message || JSON.stringify(log)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
