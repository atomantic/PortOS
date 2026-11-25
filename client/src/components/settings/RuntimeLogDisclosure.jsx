import { useState } from 'react';
import { Terminal } from 'lucide-react';

export default function RuntimeLogDisclosure({ logs }) {
  const [showLogs, setShowLogs] = useState(false);
  if (!logs?.length) return null;
  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setShowLogs((prev) => !prev)}
        className="text-[11px] text-gray-500 hover:text-gray-300 flex items-center gap-1"
      >
        <Terminal size={11} />
        {showLogs ? 'Hide server logs' : `View server logs (${logs.length} lines)`}
      </button>
      {showLogs && (
        <pre className="text-[10px] text-gray-400 bg-port-bg border border-port-border/60 p-2.5 rounded max-h-40 overflow-y-auto font-mono whitespace-pre-wrap break-all">
          {logs.join('\n')}
        </pre>
      )}
    </div>
  );
}
