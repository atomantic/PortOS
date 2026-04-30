import { useMemo, useRef, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatClockTime } from '../../utils/formatters';

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const SEVERITY_COLORS = {
  critical: { dot: 'bg-red-400', text: 'text-red-300', border: 'border-red-500/40' },
  warning: { dot: 'bg-amber-400', text: 'text-amber-300', border: 'border-amber-500/30' },
  info: { dot: 'bg-cyan-400', text: 'text-cyan-300', border: 'border-cyan-500/25' },
};

function buildAttentionItems({ apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts }) {
  const items = [];

  (apps || []).forEach(app => {
    if (app.archived) return;
    if (app.overallStatus === 'stopped') {
      items.push({
        id: `app-stopped-${app.id}`,
        severity: 'critical',
        label: `${app.name || app.id}`,
        detail: 'Stopped',
        to: `/apps/${app.id}`,
        category: 'app',
      });
    }
    const pm2 = app.pm2Status || {};
    Object.entries(pm2).forEach(([procName, s]) => {
      if (s?.status === 'errored' || s?.status === 'error') {
        items.push({
          id: `proc-err-${app.id}-${procName}`,
          severity: 'critical',
          label: `${app.name || app.id} · ${procName}`,
          detail: 'Process errored',
          to: `/apps/${app.id}`,
          category: 'app',
        });
      }
    });
  });

  if (systemHealth?.warnings?.length) {
    systemHealth.warnings.forEach((w, i) => {
      const sev = systemHealth.overallHealth === 'critical' ? 'critical' : 'warning';
      items.push({
        id: `sys-warn-${i}-${w.type}`,
        severity: sev,
        label: w.message || `System: ${w.type}`,
        detail: 'System health',
        to: '/',
        category: 'system',
      });
    });
  }

  if (reviewCounts?.alert > 0) {
    items.push({
      id: 'review-alerts',
      severity: 'critical',
      label: `${reviewCounts.alert} alert${reviewCounts.alert === 1 ? '' : 's'}`,
      detail: 'Review hub',
      to: '/review',
      category: 'review',
    });
  }
  if (reviewCounts?.total > 0) {
    items.push({
      id: 'review-pending',
      severity: 'warning',
      label: `${reviewCounts.total} pending review${reviewCounts.total === 1 ? '' : 's'}`,
      detail: 'Review hub',
      to: '/review',
      category: 'review',
    });
  }

  const peers = instances?.peers || [];
  const offlinePeers = peers.filter(p => p.status !== 'online');
  if (offlinePeers.length > 0) {
    items.push({
      id: 'peers-offline',
      severity: 'warning',
      label: `${offlinePeers.length} of ${peers.length} peer${peers.length === 1 ? '' : 's'} offline`,
      detail: 'Federation',
      to: '/instances',
      category: 'federation',
    });
  }

  const erroredAgents = (cosAgents || []).filter(a =>
    a.status === 'failed' || a.state === 'error' || a.error
  );
  erroredAgents.forEach(agent => {
    items.push({
      id: `agent-err-${agent.agentId || agent.id}`,
      severity: 'warning',
      label: agent.task || agent.taskTitle || `Agent ${agent.agentId?.slice(0, 8) || ''}`,
      detail: 'Agent failed',
      to: '/cos',
      category: 'agent',
    });
  });

  const unread = notificationCounts?.unread ?? 0;
  if (unread > 0) {
    items.push({
      id: 'notifs-unread',
      severity: 'info',
      label: `${unread} unread notification${unread === 1 ? '' : 's'}`,
      detail: 'Open dashboard alerts',
      to: '/',
      category: 'notifications',
    });
  }

  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function AttentionList({ items }) {
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-3 py-6">
        <div className="text-center">
          <div className="font-pixel text-[10px] text-emerald-400/70 tracking-wider mb-1">ALL CLEAR</div>
          <div className="font-pixel text-[8px] text-cyan-500/30 tracking-wide">No items need attention</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1.5 space-y-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(6,182,212,0.2) transparent' }}>
      {items.map(item => {
        const colors = SEVERITY_COLORS[item.severity] || SEVERITY_COLORS.info;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => item.to && navigate(item.to)}
            className={`w-full text-left flex items-start gap-2 px-2 py-1.5 rounded border ${colors.border} bg-black/40 hover:bg-cyan-500/10 transition-colors`}
            title={`${item.label} — ${item.detail}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${colors.dot} shrink-0 mt-1.5 shadow-[0_0_4px_currentColor]`} />
            <div className="flex-1 min-w-0">
              <div className={`font-pixel text-[10px] tracking-wide truncate ${colors.text}`}>
                {item.label}
              </div>
              <div className="font-pixel text-[8px] text-gray-500 tracking-wide truncate mt-0.5">
                {item.detail}
              </div>
            </div>
            <span className="font-pixel text-[8px] text-cyan-500/40 tracking-wide self-center">{'>'}</span>
          </button>
        );
      })}
    </div>
  );
}

const LEVEL_COLORS = {
  info: 'text-cyan-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
  success: 'text-emerald-400',
  debug: 'text-gray-500',
};

const LEVEL_INDICATORS = {
  info: 'bg-cyan-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
  success: 'bg-emerald-400',
  debug: 'bg-gray-600',
};

function ActivityLogList({ logs }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  if (!logs || logs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-3 py-6">
        <div className="font-pixel text-[8px] text-cyan-500/30 tracking-wide">No activity yet</div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-3 py-1.5 space-y-1"
      style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(6,182,212,0.2) transparent' }}
    >
      {logs.slice(-40).map((log) => {
        const level = log.level || 'info';
        const colorClass = LEVEL_COLORS[level] || LEVEL_COLORS.info;
        const indicatorClass = LEVEL_INDICATORS[level] || LEVEL_INDICATORS.info;
        const time = log.timestamp ? formatClockTime(new Date(log.timestamp)) : '';
        const message = log.message || log.event || JSON.stringify(log);
        const key = log._localId ?? `${log.timestamp}-${message}`;

        return (
          <div
            key={key}
            className="font-pixel text-[9px] leading-tight flex items-start gap-1.5 tracking-wide group hover:bg-cyan-500/5 rounded px-1 py-0.5 -mx-1 transition-colors"
            title={message}
          >
            <span className={`w-1 h-1 rounded-full ${indicatorClass} shrink-0 mt-1 opacity-70`} />
            <span className="text-gray-500 shrink-0">{time}</span>
            <span className={`${colorClass} truncate group-hover:whitespace-normal group-hover:break-all`}>{message}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function CityIntelPane({ apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts, eventLogs }) {
  const [tab, setTab] = useState('attention');
  const [collapsed, setCollapsed] = useState(false);

  const items = useMemo(
    () => buildAttentionItems({ apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts }),
    [apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts]
  );

  const criticalCount = items.filter(i => i.severity === 'critical').length;

  return (
    <div className={`absolute top-16 right-3 ${collapsed ? '' : 'bottom-20'} w-72 pointer-events-auto`}>
      <div className={`${collapsed ? '' : 'h-full'} bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg overflow-hidden flex flex-col`}>
        <div className="flex items-stretch border-b border-cyan-500/20">
          <button
            type="button"
            onClick={() => { setTab('attention'); setCollapsed(false); }}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 transition-colors ${
              tab === 'attention' && !collapsed
                ? 'bg-cyan-500/10 text-cyan-400'
                : 'text-cyan-500/50 hover:bg-cyan-500/5'
            }`}
            title="Things needing your attention"
          >
            <span className="font-pixel text-[10px] tracking-wider font-bold">ATTENTION</span>
            {items.length > 0 && (
              <span className={`font-pixel text-[9px] px-1 rounded ${
                criticalCount > 0 ? 'bg-red-500/30 text-red-300' : 'bg-cyan-500/20 text-cyan-300'
              }`}>
                {items.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => { setTab('activity'); setCollapsed(false); }}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 border-l border-cyan-500/20 transition-colors ${
              tab === 'activity' && !collapsed
                ? 'bg-cyan-500/10 text-cyan-400'
                : 'text-cyan-500/50 hover:bg-cyan-500/5'
            }`}
            title="Live event log"
          >
            <span className="font-pixel text-[10px] tracking-wider font-bold">ACTIVITY</span>
            {eventLogs?.length > 0 && (
              <span className="font-pixel text-[9px] text-cyan-500/40">{eventLogs.length}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(c => !c)}
            className="px-2 py-2 border-l border-cyan-500/20 text-cyan-500/50 hover:bg-cyan-500/5 hover:text-cyan-400 transition-colors"
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            <span className="font-pixel text-[11px]">{collapsed ? '[+]' : '[-]'}</span>
          </button>
        </div>
        {!collapsed && (
          tab === 'attention'
            ? <AttentionList items={items} />
            : <ActivityLogList logs={eventLogs} />
        )}
      </div>
    </div>
  );
}
