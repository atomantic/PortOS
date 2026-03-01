import BrailleSpinner from '../BrailleSpinner';
import { Check, AlertTriangle, X, SkipForward } from 'lucide-react';

const STATUS_CONFIG = {
  running: { icon: null, color: 'text-port-accent', bg: 'bg-port-accent/10' },
  done:    { icon: Check, color: 'text-port-success', bg: 'bg-port-success/10' },
  warning: { icon: AlertTriangle, color: 'text-port-warning', bg: 'bg-port-warning/10' },
  error:   { icon: X, color: 'text-port-error', bg: 'bg-port-error/10' },
  skipped: { icon: SkipForward, color: 'text-gray-500', bg: 'bg-gray-500/10' },
};

export default function ActivityLog({ steps, error, completed }) {
  if (!steps.length && !error) return null;

  return (
    <div className="mt-3 bg-port-card border border-port-border rounded-lg p-3 space-y-1.5">
      {steps.map((s) => {
        const cfg = STATUS_CONFIG[s.status] || STATUS_CONFIG.running;
        const Icon = cfg.icon;
        return (
          <div key={s.step} className={`flex items-start gap-2 px-2 py-1 rounded ${cfg.bg}`}>
            <span className={`flex-shrink-0 mt-0.5 ${cfg.color}`}>
              {s.status === 'running' ? <BrailleSpinner text="" className="text-xs" /> : Icon && <Icon size={14} />}
            </span>
            <span className="text-xs text-gray-300">
              <span className="font-mono text-white">{s.step}</span>
              {s.message && <span className="ml-2 text-gray-400">{s.message}</span>}
            </span>
          </div>
        );
      })}
      {error && (
        <div className="flex items-start gap-2 px-2 py-1 rounded bg-port-error/10">
          <X size={14} className="text-port-error flex-shrink-0 mt-0.5" />
          <span className="text-xs text-port-error">{error}</span>
        </div>
      )}
      {completed && !error && (
        <div className="flex items-start gap-2 px-2 py-1 rounded bg-port-success/10">
          <Check size={14} className="text-port-success flex-shrink-0 mt-0.5" />
          <span className="text-xs text-port-success">Operation complete</span>
        </div>
      )}
    </div>
  );
}
