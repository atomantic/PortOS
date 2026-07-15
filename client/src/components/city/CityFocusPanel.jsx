import { useMemo } from 'react';

// Building-detail panel shown while a borough is focused (issue #2593). It REPLACES the Intel pane
// (desktop) / renders as a bottom sheet (compact) — never overlapping it — and surfaces the app's
// live state from data CyberCity already has: status, process summary + unhealthy processes, and the
// agents assigned to the app. Two explicit actions: Open app (routes to /apps/:id) and Close
// (returns to the /city overview). Also renders the stale/deleted-id "not found" fallback.

const STATUS_STYLES = {
  online: { text: 'text-port-success', dot: 'bg-port-success', label: 'ONLINE' },
  stopped: { text: 'text-port-error', dot: 'bg-port-error', label: 'STOPPED' },
  not_started: { text: 'text-violet-400', dot: 'bg-violet-500', label: 'NOT STARTED' },
  not_found: { text: 'text-gray-400', dot: 'bg-gray-500', label: 'NOT FOUND' },
  unknown: { text: 'text-gray-400', dot: 'bg-gray-500', label: 'UNKNOWN' },
};

const UNHEALTHY = new Set(['errored', 'error', 'stopped', 'stopping']);

function StatBlock({ label, value, tone = 'text-cyan-300' }) {
  return (
    <div className="bg-black/40 border border-cyan-500/20 rounded px-2 py-1.5">
      <div className="font-pixel text-[8px] text-cyan-500/50 tracking-wider">{label}</div>
      <div className={`font-pixel text-[13px] tracking-wide ${tone}`}>{value}</div>
    </div>
  );
}

export default function CityFocusPanel({ app, notFound = false, agents = [], onClose, onOpenApp, isDesktop = true }) {
  // Desktop: occupy the Intel-pane slot. Compact: a bottom sheet above the dock.
  const containerClass = isDesktop
    ? 'absolute top-16 right-3 bottom-20 w-72 pointer-events-auto'
    : 'absolute inset-x-2 bottom-16 pointer-events-auto';

  const procSummary = useMemo(() => {
    const status = app?.pm2Status || {};
    const processes = Array.isArray(app?.processes) ? app.processes : [];
    const total = processes.length || Object.keys(status).length;
    const unhealthy = Object.entries(status)
      .filter(([, s]) => UNHEALTHY.has(s?.status))
      .map(([name, s]) => ({ name, status: s?.status }));
    const online = Object.values(status).filter((s) => s?.status === 'online' || s?.status === 'running').length;
    return { total, unhealthy, online };
  }, [app?.pm2Status, app?.processes]);

  const activeAgents = useMemo(
    () => (Array.isArray(agents) ? agents : []).filter(
      (a) => a && (a.status === 'running' || a.state === 'coding' || a.state === 'thinking' || a.state === 'investigating' || a.status === 'failed' || a.error)
    ),
    [agents]
  );

  if (notFound || !app) {
    return (
      <div className={containerClass}>
        <div
          className="bg-black/85 backdrop-blur-sm border border-port-warning/40 rounded-lg overflow-hidden flex flex-col"
          role="region"
          aria-label="Building not found"
        >
          <div className="px-3 py-6 text-center">
            <div className="font-pixel text-[11px] text-port-warning tracking-wider mb-1">BUILDING NOT FOUND</div>
            <div className="font-pixel text-[8px] text-gray-500 tracking-wide mb-4">
              This app may have been archived or removed.
            </div>
            <button
              type="button"
              onClick={onClose}
              className="pointer-events-auto font-pixel text-[10px] text-cyan-400 tracking-wider border border-cyan-500/40 rounded px-3 py-2 hover:bg-cyan-500/10 transition-colors"
            >
              {'<'} RETURN TO OVERVIEW
            </button>
          </div>
        </div>
      </div>
    );
  }

  const statusKey = app.archived ? 'not_found' : (app.overallStatus || 'unknown');
  const statusStyle = STATUS_STYLES[statusKey] || STATUS_STYLES.unknown;
  const title = app.name || app.id;

  return (
    <div className={containerClass}>
      <div
        className={`${isDesktop ? 'h-full' : 'max-h-[55vh]'} bg-black/85 backdrop-blur-sm border border-cyan-500/40 rounded-lg overflow-hidden flex flex-col`}
        role="region"
        aria-label={`Focused building: ${title}`}
      >
        {/* Header: name + status + close */}
        <div className="flex items-start gap-2 px-3 py-2 border-b border-cyan-500/20 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="font-pixel text-[12px] text-cyan-300 tracking-wide truncate" title={title}>{title}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${statusStyle.dot} shadow-[0_0_4px_currentColor]`} aria-hidden="true" />
              <span className={`font-pixel text-[9px] tracking-wider ${statusStyle.text}`}>{app.archived ? 'ARCHIVED' : statusStyle.label}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close focus and return to overview"
            title="Close (return to overview)"
            className="shrink-0 w-8 h-8 flex items-center justify-center text-gray-400 hover:text-cyan-400 transition-colors font-pixel text-[13px]"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-3" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(6,182,212,0.2) transparent' }}>
          {/* Process summary */}
          <div>
            <div className="font-pixel text-[8px] text-cyan-500/50 tracking-wider mb-1.5">PROCESSES</div>
            <div className="grid grid-cols-3 gap-1.5">
              <StatBlock label="TOTAL" value={procSummary.total} />
              <StatBlock label="RUNNING" value={procSummary.online} tone="text-port-success" />
              <StatBlock label="ISSUES" value={procSummary.unhealthy.length} tone={procSummary.unhealthy.length ? 'text-port-error' : 'text-cyan-300'} />
            </div>
            {procSummary.unhealthy.length > 0 && (
              <ul className="mt-1.5 space-y-1">
                {procSummary.unhealthy.map((p) => (
                  <li key={p.name} className="flex items-center gap-1.5 font-pixel text-[9px] tracking-wide text-port-error">
                    <span className="w-1.5 h-1.5 rounded-full bg-port-error shrink-0" aria-hidden="true" />
                    <span className="truncate" title={`${p.name} — ${p.status}`}>{p.name}</span>
                    <span className="text-gray-500 ml-auto shrink-0">{p.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Active agents */}
          <div>
            <div className="font-pixel text-[8px] text-cyan-500/50 tracking-wider mb-1.5">
              AGENTS {activeAgents.length > 0 && <span className="text-cyan-400">· {activeAgents.length}</span>}
            </div>
            {activeAgents.length === 0 ? (
              <div className="font-pixel text-[9px] text-gray-500 tracking-wide">No agents assigned</div>
            ) : (
              <ul className="space-y-1">
                {activeAgents.map((agent) => {
                  const id = agent.agentId || agent.id;
                  const failed = agent.status === 'failed' || agent.state === 'error' || agent.error;
                  const label = agent.task || agent.taskTitle || `Agent ${String(id || '').slice(0, 8)}`;
                  return (
                    <li key={id || label} className="flex items-center gap-1.5 font-pixel text-[9px] tracking-wide">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${failed ? 'bg-port-error' : 'bg-cyan-400 animate-pulse'}`} aria-hidden="true" />
                      <span className={`truncate ${failed ? 'text-port-error' : 'text-cyan-300'}`} title={label}>{label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-cyan-500/20 shrink-0">
          <button
            type="button"
            onClick={() => onOpenApp?.(app.id)}
            className="flex-1 font-pixel text-[10px] text-cyan-400 tracking-wider border border-cyan-500/40 rounded px-2 py-2 hover:bg-cyan-500/10 transition-colors"
            title="Open the app detail page"
          >
            OPEN APP {'>'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="font-pixel text-[10px] text-gray-400 tracking-wider border border-cyan-500/20 rounded px-2 py-2 hover:text-cyan-400 hover:border-cyan-500/40 transition-colors"
            title="Return to the city overview"
          >
            BACK
          </button>
        </div>
      </div>
    </div>
  );
}
