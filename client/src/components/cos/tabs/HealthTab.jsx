import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';

export default function HealthTab({ health, onCheck }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">System Health</h3>
          {health?.lastCheck && (
            <p className="text-sm text-gray-500">
              Last check: {new Date(health.lastCheck).toLocaleString()}
            </p>
          )}
        </div>
        <button
          onClick={onCheck}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
        >
          <RefreshCw size={14} />
          Run Check
        </button>
      </div>

      {!health?.issues || health.issues.length === 0 ? (
        <div className="bg-port-success/10 border border-port-success/30 rounded-lg p-6 text-center">
          <CheckCircle className="w-12 h-12 text-port-success mx-auto mb-3" />
          <p className="text-port-success font-medium">All Systems Healthy</p>
          <p className="text-gray-500 text-sm mt-1">No issues detected</p>
        </div>
      ) : (
        <div className="space-y-2">
          {health.issues.map((issue, idx) => (
            <div
              key={idx}
              className={`border rounded-lg p-4 ${
                issue.type === 'error'
                  ? 'bg-port-error/10 border-port-error/30'
                  : 'bg-yellow-500/10 border-yellow-500/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={16} className={issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'} />
                <span className={`text-sm font-medium uppercase ${
                  issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'
                }`}>
                  {issue.category}
                </span>
              </div>
              <p className="text-white">{issue.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
