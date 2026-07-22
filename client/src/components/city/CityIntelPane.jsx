import { useMemo, useRef, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatClockTime } from '../../utils/formatters';
import { computeActivityDensity, buildTimelineBuckets } from '../../utils/cityTimeline';
import useDrawerTab from '../../hooks/useDrawerTab';
import { CITY_PANE_IDS, CITY_INTEL_PANE_IDS } from './cityPanes';

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const SEVERITY_COLORS = {
  critical: { dot: 'bg-port-error', text: 'text-port-error', border: 'border-port-error/40' },
  warning: { dot: 'bg-port-warning', text: 'text-port-warning', border: 'border-port-warning/30' },
  info: { dot: 'bg-cyan-400', text: 'text-cyan-300', border: 'border-cyan-500/25' },
};

export function buildAttentionItems({ apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts }) {
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
          <div className="font-pixel text-[10px] text-port-success/70 tracking-wider mb-1">ALL CLEAR</div>
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
  warn: 'text-port-warning',
  error: 'text-port-error',
  success: 'text-port-success',
  debug: 'text-gray-500',
};

const LEVEL_INDICATORS = {
  info: 'bg-cyan-400',
  warn: 'bg-port-warning',
  error: 'bg-port-error',
  success: 'bg-port-success',
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

const DENSITY_BAR_COLORS = {
  error: 'bg-port-error',
  warn: 'bg-port-warning',
  success: 'bg-port-success',
  info: 'bg-cyan-400',
  debug: 'bg-gray-600',
};

const relativeAge = (ms) => {
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

// Temporal view of the event stream: a density sparkbar (when did bursts of
// activity happen) over relative-age buckets (what happened, newest first).
// Reads the same `eventLogs` the ACTIVITY tab does — no new data wiring.
function TimelineView({ logs }) {
  const navigate = useNavigate();
  // Tick `now` every 15s so "2m" ages forward without re-fetching anything.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const density = useMemo(() => computeActivityDensity(logs, { now }), [logs, now]);
  const buckets = useMemo(() => buildTimelineBuckets(logs, { now }), [logs, now]);
  const maxCount = useMemo(() => Math.max(1, ...density.map(d => d.count)), [density]);

  if (!logs || logs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-3 py-6">
        <div className="font-pixel text-[8px] text-cyan-500/30 tracking-wide">No recent activity</div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 overflow-y-auto px-3 py-2 space-y-2.5"
      style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(6,182,212,0.2) transparent' }}
    >
      {/* Density sparkbar — last 10 minutes, oldest at left */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="font-pixel text-[8px] text-cyan-500/50 tracking-wider">ACTIVITY · 10 MIN</span>
          <span className="font-pixel text-[8px] text-cyan-500/30 tracking-wider">NOW {'>'}</span>
        </div>
        <div className="flex items-end gap-px h-8" title="Event density over the last 10 minutes">
          {density.map((slot, i) => {
            // Floor non-empty bins at 12% so a single event is still visible.
            const heightPct = slot.count > 0 ? Math.max(12, (slot.count / maxCount) * 100) : 0;
            const colorClass = slot.level ? (DENSITY_BAR_COLORS[slot.level] || DENSITY_BAR_COLORS.info) : 'bg-cyan-500/10';
            return (
              <div key={i} className="flex-1 flex items-end h-full">
                <div
                  className={`w-full rounded-sm ${colorClass} ${slot.count > 0 ? 'opacity-80' : 'opacity-100'}`}
                  style={{ height: slot.count > 0 ? `${heightPct}%` : '2px' }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Time-bucketed event spine, newest first */}
      <div className="space-y-2">
        {buckets.map(bucket => (
          <div key={bucket.id}>
            <div className="font-pixel text-[8px] text-cyan-500/40 tracking-widest mb-1 border-b border-cyan-500/10 pb-0.5">
              {bucket.label}
            </div>
            <div className="space-y-1 pl-1">
              {bucket.events.map(event => {
                const colorClass = LEVEL_COLORS[event.level] || LEVEL_COLORS.info;
                const indicatorClass = LEVEL_INDICATORS[event.level] || LEVEL_INDICATORS.info;
                return (
                  <div
                    key={event.id}
                    className="font-pixel text-[9px] leading-tight flex items-start gap-1.5 tracking-wide group hover:bg-cyan-500/5 rounded px-1 py-0.5 -mx-1"
                    title={event.message}
                  >
                    <span className={`w-1 h-1 rounded-full ${indicatorClass} shrink-0 mt-1 opacity-70`} />
                    <span className="text-gray-500 shrink-0 w-7 text-right">{relativeAge(event.ageMs)}</span>
                    <span className={`${colorClass} truncate group-hover:whitespace-normal group-hover:break-all`}>
                      {event.message || '(event)'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={() => navigate('/cos')}
        className="w-full font-pixel text-[8px] text-cyan-500/40 hover:text-cyan-400 tracking-wider py-1 transition-colors"
      >
        OPEN CHIEF OF STAFF {'>'}
      </button>
    </div>
  );
}

// Intel-pane tabs. `attention`/`timeline`/`activity` line up with the same-named
// `cityPane` values so the desktop tab and the compact disclosure sheet address the
// same surface through one URL param.
export const CITY_INTEL_TABS = [
  { id: 'attention', label: 'ATTENTION', hint: 'Things needing your attention' },
  { id: 'timeline', label: 'TIMELINE', hint: 'Recent-action timeline' },
  { id: 'activity', label: 'ACTIVITY', hint: 'Live event log' },
];

// Renders just the body for a given intel tab — reused by the desktop cockpit pane
// and the compact/phone disclosure sheet so both show identical content. The parent
// must be a bounded `flex flex-col` container (the lists are `flex-1`).
export function CityIntelContent({ tab, items, eventLogs }) {
  if (tab === 'timeline') return <TimelineView logs={eventLogs} />;
  if (tab === 'activity') return <ActivityLogList logs={eventLogs} />;
  return <AttentionList items={items} />;
}

export default function CityIntelPane({ apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts, eventLogs }) {
  // The active tab is URL-addressable via `cityPane` (shared with the compact
  // layout), so a reload / back-forward restores it and a deep link opens it.
  // `vitals`/`map`/etc. aren't intel tabs, so anything outside the intel subset
  // falls back to `attention`.
  const [activePane, setActivePane] = useDrawerTab('cityPane', null, CITY_PANE_IDS);
  const tab = CITY_INTEL_PANE_IDS.includes(activePane) ? activePane : 'attention';
  const [collapsed, setCollapsed] = useState(false);

  const items = useMemo(
    () => buildAttentionItems({ apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts }),
    [apps, cosAgents, reviewCounts, instances, systemHealth, notificationCounts]
  );

  const criticalCount = items.filter(i => i.severity === 'critical').length;
  const selectTab = (id) => { setActivePane(id); setCollapsed(false); };

  // Roving tabindex: only the selected tab is in the sequential tab order, and
  // Left/Right/Home/End move selection *and* focus between tabs (WAI-ARIA
  // automatic-activation tabs pattern).
  const tabRefs = useRef({});
  const onTabKeyDown = (e) => {
    const dir = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    let next = null;
    if (dir) {
      const i = CITY_INTEL_TABS.findIndex(t => t.id === tab);
      next = CITY_INTEL_TABS[(i + dir + CITY_INTEL_TABS.length) % CITY_INTEL_TABS.length].id;
    } else if (e.key === 'Home') next = CITY_INTEL_TABS[0].id;
    else if (e.key === 'End') next = CITY_INTEL_TABS[CITY_INTEL_TABS.length - 1].id;
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  const tabCount = (id) => {
    if (id === 'attention') return items.length;
    if (id === 'activity') return eventLogs?.length || 0;
    return 0;
  };

  return (
    <div className={`absolute top-16 right-3 ${collapsed ? '' : 'bottom-20'} w-72 pointer-events-auto`}>
      <div className={`${collapsed ? '' : 'h-full'} bg-black/85 backdrop-blur-sm border border-cyan-500/30 rounded-lg overflow-hidden flex flex-col`}>
        <div className="flex items-stretch border-b border-cyan-500/20">
          {/* Deliberately NOT `ui/TabPills`: this bar wears the immersive CyberCity
              HUD skin (cyan-on-black, `font-pixel` micro-caps, per-tab severity-tinted
              count chips) that the shared component hardcodes as port-accent, and it
              can only be expressed there by adding a one-off variant that no other
              call site would use. The ARIA/roving-tabindex wiring below mirrors
              TabPills' contract, so audits can skip this divergence. */}
          <div className="flex-1 flex items-stretch min-w-0" role="tablist" aria-label="Intel">
            {CITY_INTEL_TABS.map((t, i) => {
              const active = t.id === tab;
              const count = tabCount(t.id);
              return (
                <button
                  key={t.id}
                  ref={(el) => { tabRefs.current[t.id] = el; }}
                  type="button"
                  role="tab"
                  id={`city-intel-tab-${t.id}`}
                  aria-selected={active}
                  // Only one panel is mounted at a time, so only the selected tab
                  // owns an `aria-controls` — an inactive tab would otherwise point
                  // at an element that doesn't exist.
                  aria-controls={active && !collapsed ? `city-intel-panel-${t.id}` : undefined}
                  tabIndex={active ? 0 : -1}
                  onKeyDown={onTabKeyDown}
                  onClick={() => selectTab(t.id)}
                  className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-2 transition-colors ${
                    i > 0 ? 'border-l border-cyan-500/20' : ''
                  } ${active ? 'bg-cyan-500/10 text-cyan-400' : 'text-cyan-500/50 hover:bg-cyan-500/5'}`}
                  title={t.hint}
                >
                  <span className="font-pixel text-[10px] tracking-wider font-bold">{t.label}</span>
                  {count > 0 && (t.id === 'attention' ? (
                    <span className={`font-pixel text-[9px] px-1 rounded ${
                      criticalCount > 0 ? 'bg-port-error/30 text-port-error' : 'bg-cyan-500/20 text-cyan-300'
                    }`}>
                      {count}
                    </span>
                  ) : (
                    <span className="font-pixel text-[9px] text-cyan-500/40">{count}</span>
                  ))}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(c => !c)}
            className="px-2 py-2 border-l border-cyan-500/20 text-cyan-500/50 hover:bg-cyan-500/5 hover:text-cyan-400 transition-colors"
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : `city-intel-panel-${tab}`}
            aria-label={collapsed ? 'Expand intel pane' : 'Collapse intel pane'}
          >
            <span className="font-pixel text-[11px]">{collapsed ? '[+]' : '[-]'}</span>
          </button>
        </div>
        {!collapsed && (
          <div
            role="tabpanel"
            id={`city-intel-panel-${tab}`}
            aria-labelledby={`city-intel-tab-${tab}`}
            // An empty tab renders no focusable children, so the panel itself has to
            // be a tab stop or keyboard users can't reach its content at all.
            tabIndex={0}
            className="flex-1 min-h-0 flex flex-col focus:outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/60"
          >
            <CityIntelContent tab={tab} items={items} eventLogs={eventLogs} />
          </div>
        )}
      </div>
    </div>
  );
}
