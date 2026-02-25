import { useState, useEffect, memo } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Server,
  Cpu,
  HardDrive,
  ChevronRight,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Clock,
  Zap
} from 'lucide-react';
import * as api from '../services/api';

/**
 * SystemHealthWidget - Compact system health overview for the Dashboard
 * Shows server uptime, memory/CPU usage, process status, and warnings
 */
const SystemHealthWidget = memo(function SystemHealthWidget() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      const data = await api.getSystemHealth({ silent: true }).catch(() => null);
      setHealth(data);
      setLoading(false);
    };

    loadData();
  }, []);

  // Don't render while loading
  if (loading) {
    return null;
  }

  // Don't render if no data
  if (!health) {
    return null;
  }

  const { overallHealth, warnings, system, processes, apps, cos } = health;

  // Get status color and icon
  const getHealthStyle = () => {
    switch (overallHealth) {
      case 'healthy':
        return { color: 'text-port-success', bg: 'bg-port-success/10', icon: CheckCircle };
      case 'warning':
        return { color: 'text-port-warning', bg: 'bg-port-warning/10', icon: AlertTriangle };
      case 'critical':
        return { color: 'text-port-error', bg: 'bg-port-error/10', icon: XCircle };
      default:
        return { color: 'text-gray-400', bg: 'bg-gray-400/10', icon: Activity };
    }
  };

  const healthStyle = getHealthStyle();
  const HealthIcon = healthStyle.icon;

  // Get color for usage percentage
  const getUsageColor = (percent) => {
    if (percent >= 90) return 'text-port-error';
    if (percent >= 75) return 'text-port-warning';
    return 'text-port-success';
  };

  // Get progress bar color
  const getBarColor = (percent) => {
    if (percent >= 90) return 'bg-port-error';
    if (percent >= 75) return 'bg-port-warning';
    return 'bg-port-success';
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${healthStyle.bg}`}>
            <Server className={`w-5 h-5 ${healthStyle.color}`} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">System Health</h3>
            <div className="flex items-center gap-2 text-sm">
              <HealthIcon size={14} className={healthStyle.color} />
              <span className={healthStyle.color}>
                {overallHealth.charAt(0).toUpperCase() + overallHealth.slice(1)}
              </span>
              <span className="text-gray-500">•</span>
              <Clock size={12} className="text-gray-400" />
              <span className="text-gray-400">{system.uptimeFormatted}</span>
            </div>
          </div>
        </div>
        <Link
          to="/apps"
          className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors min-h-[40px] px-2"
        >
          <span className="hidden sm:inline">Details</span>
          <ChevronRight size={16} />
        </Link>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mb-4 space-y-2">
          {warnings.map((warning, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-port-warning/10 text-port-warning text-sm"
            >
              <AlertTriangle size={14} />
              <span>{warning.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Memory Usage */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <HardDrive size={14} className="text-purple-400" />
            <span className="text-xs text-gray-500">Memory</span>
          </div>
          <div className={`text-lg sm:text-xl font-bold ${getUsageColor(system.memory.usagePercent)}`}>
            {system.memory.usagePercent}%
          </div>
          <div className="text-xs text-gray-500">
            {system.memory.usedFormatted} / {system.memory.totalFormatted}
          </div>
          <div className="mt-2 h-1.5 bg-port-border rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${getBarColor(system.memory.usagePercent)}`}
              style={{ width: `${system.memory.usagePercent}%` }}
            />
          </div>
        </div>

        {/* CPU Usage */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Cpu size={14} className="text-blue-400" />
            <span className="text-xs text-gray-500">CPU</span>
          </div>
          <div className={`text-lg sm:text-xl font-bold ${getUsageColor(system.cpu.usagePercent)}`}>
            {system.cpu.usagePercent}%
          </div>
          <div className="text-xs text-gray-500">
            {system.cpu.cores} cores
          </div>
          <div className="mt-2 h-1.5 bg-port-border rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${getBarColor(Math.min(100, system.cpu.usagePercent))}`}
              style={{ width: `${Math.min(100, system.cpu.usagePercent)}%` }}
            />
          </div>
        </div>

        {/* Processes */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Activity size={14} className="text-emerald-400" />
            <span className="text-xs text-gray-500">Processes</span>
          </div>
          <div className="text-lg sm:text-xl font-bold text-white">
            {processes.online}
            <span className="text-sm font-normal text-gray-500">/{processes.total}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-500">
            {processes.errored > 0 ? (
              <span className="text-port-error">{processes.errored} errored</span>
            ) : processes.stopped > 0 ? (
              <span>{processes.stopped} stopped</span>
            ) : (
              <span className="text-port-success">All running</span>
            )}
          </div>
        </div>

        {/* Apps */}
        <div className="bg-port-bg/50 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-1">
            <Zap size={14} className="text-amber-400" />
            <span className="text-xs text-gray-500">Apps</span>
          </div>
          <div className="text-lg sm:text-xl font-bold text-white">
            {apps.online}
            <span className="text-sm font-normal text-gray-500">/{apps.total}</span>
          </div>
          <div className="flex items-center gap-1 text-xs text-gray-500">
            {apps.stopped > 0 ? (
              <span>{apps.stopped} stopped</span>
            ) : apps.notStarted > 0 ? (
              <span>{apps.notStarted} offline</span>
            ) : apps.online === apps.total ? (
              <span className="text-port-success">All online</span>
            ) : (
              <span>Ready</span>
            )}
          </div>
        </div>
      </div>

      {/* CoS Status (if running) */}
      {cos && (
        <div className="mt-4 pt-4 border-t border-port-border">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${cos.running ? (cos.paused ? 'bg-port-warning' : 'bg-port-success animate-pulse') : 'bg-gray-500'}`} />
              <span className="text-gray-300">Chief of Staff</span>
              <span className="text-gray-500">
                {cos.running ? (cos.paused ? 'Paused' : 'Active') : 'Stopped'}
              </span>
            </div>
            {cos.running && (
              <div className="flex items-center gap-3 text-xs text-gray-500">
                {cos.activeAgents > 0 && (
                  <span className="text-port-accent">{cos.activeAgents} agent{cos.activeAgents !== 1 ? 's' : ''}</span>
                )}
                {cos.queuedTasks > 0 && (
                  <span>{cos.queuedTasks} queued</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default SystemHealthWidget;
