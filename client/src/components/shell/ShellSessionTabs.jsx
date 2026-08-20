import { Plus, X, Terminal as TerminalIcon, Bot } from 'lucide-react';
import { formatDurationMs } from '../../utils/formatters';
import { clickableProps } from '../../lib/a11yKeyboard.js';

const shortId = (id) => id?.slice(0, 6) ?? '';

// Separator-agnostic basename for the tab label. A Windows cwd (`I:\code\example-app`)
// contains no `/`, so a POSIX-only split leaves the whole path in the tab and blows
// out its width. `filter(Boolean)` drops the empty tail a trailing separator leaves,
// and yields undefined for a bare root so the caller falls through to the short id.
const folderName = (cwd) => cwd?.split(/[\\/]/).filter(Boolean).pop();

// Presentational session-tab strip for the Shell page. External TUI runs get a
// distinct bot icon + accent tint + pulsing dot so they read as "live run you can
// watch and drive"; interactive shells use the terminal icon. All session actions
// are lifted to the parent via callbacks — this component owns no state.
//
// The strip scrolls horizontally instead of wrapping: on a phone a single long
// agent label (`Claude Code TUI agent-6827af82`) would otherwise claim a whole
// row per session and push the terminal below the fold. Labels truncate at a
// fixed width for the same reason; the full name stays in the tooltip. The
// scroller follows the repo idiom (`scrollbar-hide touch-pan-x`, as in
// `ui/TabPills.jsx`) — a platform scrollbar gutter would eat back the row this
// is reclaiming, and `touch-pan-x` stops Android resolving the swipe as a
// vertical page scroll. Vertical spacing is the parent's `gap`, not an `mb-*`
// here, so the page owns its own rhythm.
export default function ShellSessionTabs({ sessions, activeSessionId, onSwitch, onKill, onNew }) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide touch-pan-x">
      {sessions.map((s) => {
        const isActive = s.sessionId === activeSessionId;
        const label = s.label || folderName(s.cwd) || shortId(s.sessionId);
        const isRun = s.external;
        const TabIcon = isRun ? Bot : TerminalIcon;
        const age = formatDurationMs(Date.now() - s.createdAt);
        const title = `${isRun ? 'Live TUI run — ' : ''}${s.label || s.cwd || shortId(s.sessionId)} — ${age} old`;
        return (
          <div
            key={s.sessionId}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer min-h-[40px] shrink-0 ${
              isActive
                ? 'bg-port-accent/20 text-port-accent border border-port-accent/40'
                : isRun
                  ? 'bg-port-accent/5 hover:bg-port-accent/15 text-port-accent/80 hover:text-port-accent border border-port-accent/20'
                  : 'bg-port-card hover:bg-port-border text-gray-400 hover:text-white border border-port-border'
            }`}
            onClick={() => !isActive && onSwitch(s.sessionId)}
            {...clickableProps(() => !isActive && onSwitch(s.sessionId))}
            title={title}
          >
            <TabIcon size={12} className="shrink-0" />
            <span className="truncate max-w-[9rem] sm:max-w-[18rem]">{label}</span>
            {isRun && <span className="w-1.5 h-1.5 rounded-full bg-port-accent animate-pulse shrink-0" title="Live" />}
            <span className="text-[10px] opacity-60 shrink-0">{age}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onKill(s.sessionId); }}
              className={`shrink-0 ml-0.5 p-0.5 rounded transition-colors ${
                isActive ? 'text-port-accent/60 hover:text-port-error' : 'text-gray-600 hover:text-port-error'
              }`}
              title={isRun ? 'Stop run' : 'Kill session'} aria-label={isRun ? 'Stop run' : 'Kill session'}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      <button
        onClick={onNew}
        className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-white hover:bg-port-border rounded transition-colors min-h-[40px] shrink-0"
        title="New session" aria-label="New session"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
