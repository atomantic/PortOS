import { useState, memo } from 'react';
import { Link } from 'react-router-dom';
import {
  Eye,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  CheckCircle,
  ArrowRight,
  Clock,
  RefreshCw,
  Zap,
  Users,
  Pause,
  Moon
} from 'lucide-react';
import * as api from '../services/api';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

/**
 * DecisionLogWidget - Shows transparency into CoS decision-making
 * Displays why tasks were skipped, intervals adjusted, or alternatives chosen.
 * Surfaces rich context for each decision type so the user can understand
 * exactly why the CoS took (or didn't take) action.
 */
const DecisionLogWidget = memo(function DecisionLogWidget() {
  const { data: summary, loading } = useAutoRefetch(
    () => api.getCosDecisionSummary({ silent: true }).catch(() => null),
    60000
  );
  const [expanded, setExpanded] = useState(false);

  // Don't render while loading or if no data
  if (loading || !summary) {
    return null;
  }

  // Only show if there are impactful decisions to display
  if (!summary.hasImpactfulDecisions && summary.last24Hours.total === 0) {
    return null;
  }

  const { last24Hours, impactfulDecisions, transparencyScore } = summary;

  // Get icon and color for decision type
  const getDecisionStyle = (type) => {
    switch (type) {
      case 'task_skipped':
        return { icon: AlertCircle, color: 'text-port-warning', bg: 'bg-port-warning/10' };
      case 'task_switched':
        return { icon: ArrowRight, color: 'text-purple-400', bg: 'bg-purple-400/10' };
      case 'interval_adjusted':
        return { icon: Clock, color: 'text-blue-400', bg: 'bg-blue-400/10' };
      case 'rehabilitation':
        return { icon: RefreshCw, color: 'text-port-success', bg: 'bg-port-success/10' };
      case 'task_selected':
        return { icon: CheckCircle, color: 'text-port-success', bg: 'bg-port-success/10' };
      case 'capacity_full':
        return { icon: Users, color: 'text-orange-400', bg: 'bg-orange-400/10' };
      case 'cooldown_active':
        return { icon: Pause, color: 'text-cyan-400', bg: 'bg-cyan-400/10' };
      case 'idle':
        return { icon: Moon, color: 'text-gray-400', bg: 'bg-gray-400/10' };
      default:
        return { icon: Eye, color: 'text-gray-400', bg: 'bg-gray-400/10' };
    }
  };

  // Format decision type for display
  const formatDecisionType = (type) => {
    const labels = {
      task_skipped: 'Skipped',
      task_switched: 'Switched',
      interval_adjusted: 'Adjusted',
      cooldown_active: 'Cooldown',
      not_due: 'Not Due',
      queue_full: 'Queue Full',
      capacity_full: 'At Capacity',
      task_selected: 'Selected',
      rehabilitation: 'Retried',
      idle: 'Idle'
    };
    return labels[type] || type;
  };

  // Format relative time
  const formatRelativeTime = (timestamp) => {
    const now = Date.now();
    const then = new Date(timestamp).getTime();
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return 'yesterday';
  };

  // Render context-specific detail pills for a decision
  const renderContextDetails = (decision) => {
    const ctx = decision.context;
    if (!ctx) return null;

    const pills = [];

    switch (decision.type) {
      case 'capacity_full':
        if (ctx.running !== undefined && ctx.max !== undefined) {
          pills.push(
            <span key="slots" className="text-xs px-1.5 py-0.5 rounded bg-orange-400/15 text-orange-300">
              {ctx.running}/{ctx.max} agents
            </span>
          );
        }
        if (ctx.project && ctx.project !== '_self') {
          pills.push(
            <span key="project" className="text-xs px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-300">
              {ctx.project}
            </span>
          );
        }
        if (ctx.limit) {
          pills.push(
            <span key="limit" className="text-xs px-1.5 py-0.5 rounded bg-orange-400/15 text-orange-300">
              limit: {ctx.limit}/project
            </span>
          );
        }
        break;

      case 'cooldown_active':
        if (ctx.appId) {
          pills.push(
            <span key="app" className="text-xs px-1.5 py-0.5 rounded bg-cyan-400/15 text-cyan-300">
              {ctx.appId}
            </span>
          );
        }
        if (ctx.cooldownMs) {
          pills.push(
            <span key="cooldown" className="text-xs px-1.5 py-0.5 rounded bg-cyan-400/15 text-cyan-300">
              {Math.round(ctx.cooldownMs / 60000)}min window
            </span>
          );
        }
        break;

      case 'task_switched':
        if (ctx.fromTask && ctx.toTask) {
          pills.push(
            <span key="switch" className="text-xs px-1.5 py-0.5 rounded bg-purple-400/15 text-purple-300 inline-flex items-center gap-1">
              {ctx.fromTask} <ArrowRight size={10} /> {ctx.toTask}
            </span>
          );
        }
        break;

      case 'task_skipped':
        if (ctx.attempts) {
          pills.push(
            <span key="attempts" className="text-xs px-1.5 py-0.5 rounded bg-port-warning/15 text-yellow-300">
              {ctx.attempts} attempts
            </span>
          );
        }
        break;

      case 'idle':
        if (ctx.runningAgents !== undefined) {
          pills.push(
            <span key="running" className="text-xs px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-300">
              {ctx.runningAgents} running
            </span>
          );
        }
        if (ctx.awaitingApproval > 0) {
          pills.push(
            <span key="approval" className="text-xs px-1.5 py-0.5 rounded bg-port-warning/15 text-yellow-300">
              {ctx.awaitingApproval} awaiting approval
            </span>
          );
        }
        break;

      default:
        break;
    }

    // Always show taskType if present and not already shown by type-specific pills
    if (ctx.taskType && decision.type !== 'task_switched') {
      pills.unshift(
        <span key="taskType" className="text-xs text-gray-400">
          {ctx.taskType}
        </span>
      );
    }

    if (pills.length === 0) return null;

    return <div className="flex flex-wrap items-center gap-1.5 mt-1">{pills}</div>;
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl" aria-hidden="true">
            <Eye className="w-6 h-6 text-purple-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Decision Log</h3>
            <p className="text-sm text-gray-500">
              {last24Hours.total > 0
                ? `${last24Hours.total} decisions in last 24h`
                : 'No recent decisions'}
            </p>
          </div>
        </div>
        <Link
          to="/cos/learning"
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="hidden sm:inline">Details</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      {/* Quick Stats Row */}
      <div className="flex flex-wrap gap-3 mb-4">
        {last24Hours.skipped > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-port-warning/10 text-port-warning text-xs">
            <AlertCircle size={12} />
            <span>{last24Hours.skipped} skipped</span>
          </div>
        )}
        {last24Hours.switched > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-purple-400/10 text-purple-400 text-xs">
            <ArrowRight size={12} />
            <span>{last24Hours.switched} switched</span>
          </div>
        )}
        {last24Hours.capacityFull > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-orange-400/10 text-orange-400 text-xs">
            <Users size={12} />
            <span>{last24Hours.capacityFull} deferred</span>
          </div>
        )}
        {last24Hours.cooldownActive > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-cyan-400/10 text-cyan-400 text-xs">
            <Pause size={12} />
            <span>{last24Hours.cooldownActive} cooldowns</span>
          </div>
        )}
        {last24Hours.selected > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-port-success/10 text-port-success text-xs">
            <CheckCircle size={12} />
            <span>{last24Hours.selected} selected</span>
          </div>
        )}
        {last24Hours.adjusted > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-blue-400/10 text-blue-400 text-xs">
            <Clock size={12} />
            <span>{last24Hours.adjusted} adjusted</span>
          </div>
        )}
      </div>

      {/* Impactful Decisions Section */}
      {impactfulDecisions.length > 0 && (
        <div className="border-t border-port-border pt-4">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center justify-between w-full text-left mb-2 group"
          >
            <div className="flex items-center gap-2">
              <Zap size={14} className="text-purple-400" />
              <span className="text-sm font-medium text-gray-300">Recent Decisions</span>
              <span className="text-xs text-gray-500">
                (why tasks were skipped or changed)
              </span>
            </div>
            <ChevronDown
              size={16}
              className={`text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>

          {expanded && (
            <div className="space-y-2">
              {impactfulDecisions.map((decision) => {
                const style = getDecisionStyle(decision.type);
                const Icon = style.icon;

                return (
                  <div
                    key={decision.id}
                    className={`flex items-start gap-2 p-2 rounded-lg ${style.bg}`}
                  >
                    <Icon size={14} className={`${style.color} mt-0.5 shrink-0`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs font-medium ${style.color}`}>
                          {formatDecisionType(decision.type)}
                        </span>
                      </div>
                      <p className="text-sm text-gray-300 truncate" title={decision.reason}>
                        {decision.reason}
                      </p>
                      {renderContextDetails(decision)}
                      <div className="text-xs text-gray-500 mt-0.5">
                        {formatRelativeTime(decision.lastTimestamp || decision.timestamp)}
                        {(decision.count || 1) > 1 && (
                          <span className="ml-2 text-gray-400">
                            ({decision.count}x)
                          </span>
                        )}
                        {decision.context?.successRate !== undefined && (
                          <span className={`ml-2 ${
                            decision.context.successRate < 30 ? 'text-port-error' :
                            decision.context.successRate < 60 ? 'text-port-warning' : 'text-port-success'
                          }`}>
                            {decision.context.successRate}% success
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!expanded && (
            <div className="flex gap-1">
              {impactfulDecisions.slice(0, 5).map((decision) => {
                const style = getDecisionStyle(decision.type);
                return (
                  <div
                    key={decision.id}
                    className={`w-2 h-2 rounded-full ${style.color.replace('text-', 'bg-')}`}
                    title={`${formatDecisionType(decision.type)}: ${decision.reason}`}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Transparency Score */}
      {transparencyScore !== undefined && (
        <div className="mt-3 pt-3 border-t border-port-border flex items-center justify-between text-xs">
          <span className="text-gray-500">Transparency score</span>
          <span className={`font-medium ${
            transparencyScore >= 90 ? 'text-port-success' :
            transparencyScore >= 70 ? 'text-port-warning' : 'text-port-error'
          }`}>
            {transparencyScore}%
          </span>
        </div>
      )}
    </div>
  );
});

export default DecisionLogWidget;
