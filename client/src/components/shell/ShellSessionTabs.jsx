import { Plus, X, Terminal as TerminalIcon, Bot } from 'lucide-react';
import { formatDurationMs } from '../../utils/formatters';
import { clickableProps } from '../../lib/a11yKeyboard.js';

const shortId = (id) => id?.slice(0, 6) ?? '';

// Presentational session-tab strip for the Shell page. External TUI runs get a
// distinct bot icon + accent tint + pulsing dot so they read as "live run you can
// watch and drive"; interactive shells use the terminal icon. All session actions
// are lifted to the parent via callbacks — this component owns no state.
export default function ShellSessionTabs({ sessions, activeSessionId, onSwitch, onKill, onNew }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-3 pb-1">
      {sessions.map((s) => {
        const isActive = s.sessionId === activeSessionId;
        const label = s.label || s.cwd?.split('/').pop() || shortId(s.sessionId);
        const isRun = s.external;
        const TabIcon = isRun ? Bot : TerminalIcon;
        return (
          <div
            key={s.sessionId}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer min-h-[40px] ${
              isActive
                ? 'bg-port-accent/20 text-port-accent border border-port-accent/40'
                : isRun
                  ? 'bg-port-accent/5 hover:bg-port-accent/15 text-port-accent/80 hover:text-port-accent border border-port-accent/20'
                  : 'bg-port-card hover:bg-port-border text-gray-400 hover:text-white border border-port-border'
            }`}
            onClick={() => !isActive && onSwitch(s.sessionId)}
            {...clickableProps(() => !isActive && onSwitch(s.sessionId))}
            title={`${isRun ? 'Live TUI run — ' : ''}${s.label || s.cwd || shortId(s.sessionId)} — ${formatDurationMs(Date.now() - s.createdAt)} old`}
          >
            <TabIcon size={12} className="shrink-0" />
            <span className="min-w-0 break-all">{label}</span>
            {isRun && <span className="w-1.5 h-1.5 rounded-full bg-port-accent animate-pulse shrink-0" title="Live" />}
            <span className="text-[10px] opacity-60 shrink-0">{formatDurationMs(Date.now() - s.createdAt)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onKill(s.sessionId); }}
              className={`shrink-0 ml-0.5 p-0.5 rounded transition-colors ${
                isActive ? 'text-port-accent/60 hover:text-port-error' : 'text-gray-600 hover:text-port-error'
              }`}
              title={isRun ? 'Stop run' : 'Kill session'}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      <button
        onClick={onNew}
        className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-white hover:bg-port-border rounded transition-colors min-h-[40px]"
        title="New session"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
