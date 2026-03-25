import { memo } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell,
  ChevronRight,
  AlertTriangle,
  AlertOctagon,
  Target,
  TrendingDown,
  Cpu,
  BookOpen,
  CheckCircle
} from 'lucide-react';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

const SEVERITY_STYLES = {
  critical: { bg: 'bg-port-error/10', text: 'text-port-error', border: 'border-port-error/30' },
  high: { bg: 'bg-port-warning/10', text: 'text-port-warning', border: 'border-port-warning/30' },
  medium: { bg: 'bg-port-accent/10', text: 'text-port-accent', border: 'border-port-accent/30' }
};

const TYPE_ICONS = {
  goal_stall: Target,
  success_drop: TrendingDown,
  system_resource: Cpu,
  process_error: AlertOctagon,
  learning_health: BookOpen
};

const ProactiveAlertsWidget = memo(function ProactiveAlertsWidget() {
  const { data, loading } = useAutoRefetch(
    () => api.getAlertsSummary({ silent: true }).catch(() => null),
    120000 // Refresh every 2 minutes
  );

  if (loading) return null;
  if (!data) return null;

  const { alerts, counts } = data;
  const hasAlerts = counts.total > 0;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${hasAlerts ? 'bg-port-warning/10' : 'bg-port-success/10'}`}>
            {hasAlerts ? (
              <Bell className="w-5 h-5 text-port-warning" />
            ) : (
              <CheckCircle className="w-5 h-5 text-port-success" />
            )}
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Proactive Alerts</h3>
            <p className="text-sm text-gray-500">
              {hasAlerts
                ? `${counts.total} alert${counts.total !== 1 ? 's' : ''} detected`
                : 'All systems nominal'}
            </p>
          </div>
        </div>
        {hasAlerts && counts.total > 5 && (
          <Link
            to="/cos"
            className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
          >
            <span className="hidden sm:inline">View All</span>
            <ChevronRight size={16} />
          </Link>
        )}
      </div>

      {/* Severity badges */}
      {hasAlerts && (
        <div className="flex gap-2 mb-3">
          {counts.critical > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-port-error/20 text-port-error">
              <AlertOctagon size={10} />
              {counts.critical} critical
            </span>
          )}
          {counts.high > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-port-warning/20 text-port-warning">
              <AlertTriangle size={10} />
              {counts.high} high
            </span>
          )}
          {counts.medium > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-port-accent/20 text-port-accent">
              {counts.medium} medium
            </span>
          )}
        </div>
      )}

      {/* Alert list */}
      {hasAlerts ? (
        <div className="space-y-2">
          {alerts.map((alert, idx) => {
            const style = SEVERITY_STYLES[alert.severity] || SEVERITY_STYLES.medium;
            const Icon = TYPE_ICONS[alert.type] || AlertTriangle;
            return (
              <Link
                key={idx}
                to={alert.link || '/cos'}
                className={`flex items-start gap-3 p-2.5 rounded-lg border ${style.border} ${style.bg} hover:brightness-110 transition-all group`}
              >
                <Icon size={14} className={`mt-0.5 shrink-0 ${style.text}`} />
                <div className="min-w-0 flex-1">
                  <div className={`text-sm font-medium ${style.text} truncate`}>
                    {alert.title}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {alert.detail}
                  </div>
                </div>
                <ChevronRight size={14} className="mt-0.5 shrink-0 text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-4 text-gray-500 text-sm">
          No issues detected — goals progressing, tasks succeeding, system healthy
        </div>
      )}
    </div>
  );
});

export default ProactiveAlertsWidget;
