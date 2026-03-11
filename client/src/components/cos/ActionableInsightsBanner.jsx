import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import {
  AlertCircle,
  AlertTriangle,
  XCircle,
  Brain,
  Newspaper,
  ListTodo,
  ChevronRight,
  ChevronDown,
  X,
  Zap,
  Unlock
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
  const [expanded, setExpanded] = useState({});
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const loadInsights = async () => {
    const result = await api.getCosActionableInsights().catch(() => null);
    setData(result);
    setLoading(false);
  };

  useEffect(() => {
    loadInsights();
    const interval = setInterval(loadInsights, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleDismiss = (type) => {
    setDismissed(prev => [...prev, type]);
  };

  const handleAction = (insight) => {
    // For blocked insights, toggle expand to show individual tasks
    if (insight.type === 'blocked' && insight.tasks?.length > 0) {
      setExpanded(prev => ({ ...prev, [insight.type]: !prev[insight.type] }));
      return;
    }
    if (insight.action?.route) {
      navigate(insight.action.route);
    }
  };

  const handleUnblockTask = async (taskId) => {
    await api.updateCosTask(taskId, { status: 'pending' }).catch(err => {
      toast.error(err.message);
      return null;
    });
    toast.success('Task unblocked and moved to pending');
    // Refresh insights to reflect change
    await loadInsights();
  };

  if (loading || !data) {
    return null;
  }

  const visibleInsights = data.insights.filter(i => !dismissed.includes(i.type));

  if (visibleInsights.length === 0) {
    return null;
  }

  const primaryInsight = visibleInsights[0];
  const remainingCount = visibleInsights.length - 1;

  const styles = PRIORITY_STYLES[primaryInsight.priority] || PRIORITY_STYLES.info;
  const Icon = ICON_MAP[primaryInsight.icon] || AlertCircle;
  const isExpanded = expanded[primaryInsight.type];
  const hasBlockedTasks = primaryInsight.type === 'blocked' && primaryInsight.tasks?.length > 0;

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
          {primaryInsight.description && !isExpanded && (
            <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">
              {primaryInsight.description}
            </p>
          )}

          {/* Expanded blocked tasks list */}
          {hasBlockedTasks && isExpanded && (
            <div className="mt-2 space-y-1.5">
              {primaryInsight.tasks.map(task => (
                <div key={task.id} className="flex items-center gap-2 bg-black/20 rounded px-2 py-1.5">
                  <span className="flex-1 text-xs text-gray-300 truncate" title={task.description}>
                    {task.description}
                  </span>
                  <button
                    onClick={() => handleUnblockTask(task.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-port-success/20 hover:bg-port-success/30 text-port-success rounded transition-colors shrink-0 min-h-[28px]"
                    title="Unblock and move to pending"
                  >
                    <Unlock size={11} />
                    Unblock
                  </button>
                </div>
              ))}
            </div>
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
              onClick={() => handleAction(primaryInsight)}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-white rounded transition-colors min-h-[32px]"
            >
              {primaryInsight.action.label}
              {hasBlockedTasks
                ? (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
                : <ChevronRight size={12} />
              }
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
