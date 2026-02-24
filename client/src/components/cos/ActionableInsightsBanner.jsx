import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  AlertTriangle,
  XCircle,
  Brain,
  Newspaper,
  ListTodo,
  ChevronRight,
  X,
  Zap
} from 'lucide-react';
import * as api from '../../services/api';

const ICON_MAP = {
  AlertCircle,
  AlertTriangle,
  XCircle,
  Brain,
  Newspaper,
  ListTodo,
  Zap
};

const PRIORITY_STYLES = {
  critical: {
    bg: 'bg-gradient-to-r from-port-error/20 to-port-error/5',
    border: 'border-port-error/50',
    iconColor: 'text-port-error',
    pulse: true
  },
  high: {
    bg: 'bg-gradient-to-r from-port-warning/20 to-port-warning/5',
    border: 'border-port-warning/50',
    iconColor: 'text-port-warning',
    pulse: false
  },
  medium: {
    bg: 'bg-gradient-to-r from-port-accent/15 to-port-accent/5',
    border: 'border-port-accent/30',
    iconColor: 'text-port-accent',
    pulse: false
  },
  low: {
    bg: 'bg-port-card',
    border: 'border-port-border',
    iconColor: 'text-gray-400',
    pulse: false
  },
  info: {
    bg: 'bg-port-card/50',
    border: 'border-port-border/50',
    iconColor: 'text-gray-500',
    pulse: false
  }
};

export default function ActionableInsightsBanner() {
  const [data, setData] = useState(null);
  const [dismissed, setDismissed] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const loadInsights = async () => {
      const result = await api.getCosActionableInsights().catch(() => null);
      setData(result);
      setLoading(false);
    };

    loadInsights();
    // Refresh every 60 seconds
    const interval = setInterval(loadInsights, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleDismiss = (type) => {
    setDismissed(prev => [...prev, type]);
  };

  const handleAction = (route) => {
    navigate(route);
  };

  if (loading || !data) {
    return null;
  }

  // Filter out dismissed insights
  const visibleInsights = data.insights.filter(i => !dismissed.includes(i.type));

  // Don't render if no insights to show
  if (visibleInsights.length === 0) {
    return null;
  }

  // Show only the top insight if there are many
  const primaryInsight = visibleInsights[0];
  const remainingCount = visibleInsights.length - 1;

  const styles = PRIORITY_STYLES[primaryInsight.priority] || PRIORITY_STYLES.info;
  const Icon = ICON_MAP[primaryInsight.icon] || AlertCircle;

  return (
    <div className={`${styles.bg} border ${styles.border} rounded-lg p-3 mb-4 transition-all`}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`shrink-0 mt-0.5 ${styles.iconColor} ${styles.pulse ? 'animate-pulse' : ''}`}>
          <Icon size={18} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-white text-sm">
              {primaryInsight.title}
            </span>
            {primaryInsight.priority === 'critical' && (
              <span className="px-1.5 py-0.5 text-[10px] font-semibold bg-port-error/30 text-port-error rounded uppercase">
                Urgent
              </span>
            )}
          </div>
          {primaryInsight.description && (
            <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
              {primaryInsight.description}
            </p>
          )}

          {/* Additional insights indicator */}
          {remainingCount > 0 && (
            <div className="flex items-center gap-1 mt-1.5 text-xs text-gray-500">
              <Zap size={10} />
              <span>+{remainingCount} more action{remainingCount > 1 ? 's' : ''} available</span>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {primaryInsight.action && (
            <button
              onClick={() => handleAction(primaryInsight.action.route)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded transition-colors min-h-[32px]"
            >
              {primaryInsight.action.label}
              <ChevronRight size={12} />
            </button>
          )}
          <button
            onClick={() => handleDismiss(primaryInsight.type)}
            className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-white/5 rounded transition-colors min-w-[32px] min-h-[32px] flex items-center justify-center"
            title="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
