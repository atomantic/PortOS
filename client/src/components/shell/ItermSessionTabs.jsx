import { AppWindow } from 'lucide-react';
import { clickableProps } from '../../lib/a11yKeyboard.js';

// Separator-agnostic basename, as in ShellSessionTabs.
const folderName = (cwd) => cwd?.split(/[\\/]/).filter(Boolean).pop();

// Where a session sits in iTerm2: `Window 1 › Tab 2 › Pane 1/2` (the pane
// segment only when the tab is split).
export const itermLocation = (s) => [
  `Window ${s.windowIndex}`,
  `Tab ${s.tabIndex}`,
  ...(s.paneCount > 1 ? [`Pane ${s.paneIndex}/${s.paneCount}`] : []),
].join(' › ');

// Session strip for the Shell page's iTerm2 view (#8114), grouped by iTerm2
// window → tab with panes as their own entries. Deliberately NOT
// ShellSessionTabs: there is no kill or new-session control, because PortOS
// cannot close or create iTerm2 sessions. Each entry carries the iTerm2 badge
// so it never reads as a PortOS shell.
export default function ItermSessionTabs({ sessions, activeSessionId, onSelect }) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide touch-pan-x" aria-label="iTerm2 sessions">
      {sessions.map((s, idx) => {
        const isActive = s.id === activeSessionId;
        const newWindow = idx === 0 || sessions[idx - 1].windowIndex !== s.windowIndex;
        const label = s.label || s.jobName || 'session';
        const folder = folderName(s.cwd);
        const where = itermLocation(s);
        return (
          <div key={s.id} className="flex items-center gap-1.5 shrink-0">
            {newWindow && (
              <span className="text-[10px] uppercase tracking-wide text-port-warning/80 font-semibold shrink-0 pl-1">
                W{s.windowIndex}
              </span>
            )}
            <div
              data-testid="iterm-session-tab"
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer min-h-[40px] ${
                isActive
                  ? 'bg-port-warning/20 text-port-warning border border-port-warning/50'
                  : 'bg-port-card hover:bg-port-border text-gray-400 hover:text-white border border-port-border'
              }`}
              onClick={() => !isActive && onSelect(s.id)}
              {...clickableProps(() => !isActive && onSelect(s.id))}
              aria-current={isActive ? 'true' : undefined}
              title={`iTerm2 — ${where} — ${label}${s.cwd ? ` — ${s.cwd}` : ''}`}
            >
              <AppWindow size={12} className="shrink-0 text-port-warning" aria-label="iTerm2" />
              <span className="text-[10px] opacity-70 shrink-0">
                T{s.tabIndex}{s.paneCount > 1 ? ` · P${s.paneIndex}/${s.paneCount}` : ''}
              </span>
              <span className="truncate max-w-[9rem] sm:max-w-[16rem]">{label}</span>
              {folder && <span className="hidden sm:inline text-[10px] opacity-60 truncate max-w-[8rem]">{folder}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
