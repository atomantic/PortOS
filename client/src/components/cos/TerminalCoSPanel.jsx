import { Play, Square } from 'lucide-react';
import { AGENT_STATES } from './constants';

export default function TerminalCoSPanel({ state, speaking, statusMessage, eventLogs, running, onStart, onStop, stats }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;

  // Terminal-style ASCII art for the character - alien design
  const terminalAscii = {
    sleeping: [
      '   ◊   ◊   ',
      '  ▐▛███▜▌  ',
      '  ▝▜█z█▛▘  ',
      '   /|  |\\  ',
      '    |  |   ',
      '   ◇   ◇   ',
    ],
    thinking: [
      '   ?   ?   ',
      '  ▐▛███▜▌  ',
      '  ▝▜█?█▛▘  ',
      '   /|  |\\  ',
      '    |  |   ',
      '   ◇   ◇   ',
    ],
    coding: [
      '   ⟨   ⟩   ',
      '  ▐▛███▜▌  ',
      '  ▝▜█=█▛▘  ',
      '   /|  |\\  ',
      '    |  |   ',
      '   ◈   ◈   ',
    ],
    investigating: [
      '   ◎   ◎   ',
      '  ▐▛███▜▌  ',
      '  ▝▜█◉█▛▘  ',
      '   /|  |\\  ',
      '    |  |   ',
      '   ◇   ◇   ',
    ],
    reviewing: [
      '   ✓   ✓   ',
      '  ▐▛███▜▌  ',
      '  ▝▜█✓█▛▘  ',
      '   /|  |\\  ',
      '    |  |   ',
      '   ◈   ◈   ',
    ],
    planning: [
      '   ▪   ▪   ',
      '  ▐▛███▜▌  ',
      '  ▝▜█▪█▛▘  ',
      '   /|  |\\  ',
      '    |  |   ',
      '   ◇   ◇   ',
    ],
    ideating: [
      '   ✧   ✧   ',
      '  ▐▛███▜▌  ',
      '  ▝▜█•█▛▘  ',
      '   /|  |\\  ',
      '    |  |   ',
      '   ◈   ◈   ',
    ]
  };

  const ascii = terminalAscii[state] || terminalAscii.sleeping;

  // Muted/secondary terminal text is a blend of the theme's --port-terminal-text
  // into --port-terminal-bg (via opacity) rather than a fixed gray, so it stays
  // legible whether the active theme's terminal surface is dark or light. Each
  // tier is written as a full literal class string (not built via concatenation)
  // so Tailwind's source scanner can find and generate it.
  const termText = 'text-[var(--port-terminal-text)]';
  const termTextDim = 'text-[var(--port-terminal-text)]/75';
  const termTextMuted = 'text-[var(--port-terminal-text)]/55';
  const termTextFaint = 'text-[var(--port-terminal-text)]/40';

  const levelColors = {
    info: 'text-port-accent',
    warn: 'text-port-warning',
    error: 'text-port-error',
    success: 'text-port-success',
    debug: termTextMuted
  };

  const levelPrefixes = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
    success: '✅',
    debug: '🔍'
  };

  return (
    // Background + foreground are re-themed together onto the dedicated
    // --port-terminal-bg/--port-terminal-text tokens (tuned per-theme in
    // portosThemes.js) so the panel stays readable in light day themes
    // instead of rendering light-on-light. See #1909.
    <div className={`relative flex flex-col p-3 lg:p-4 font-mono text-sm bg-[var(--port-terminal-bg)] ${termText} border-b lg:border-b-0 lg:border-r border-port-border shrink-0 lg:h-full overflow-hidden lg:overflow-y-auto scrollbar-hide max-h-[50vh] lg:max-h-none`}>
      {/* Scanline effect */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.02]"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)'
        }}
      />

      {/* Terminal header */}
      <div className="flex items-center gap-3 mb-2 lg:mb-4 pb-2 border-b border-port-border">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full bg-port-error/80"></span>
          <span className="w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full bg-port-warning/80"></span>
          <span className="w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full bg-port-success/80"></span>
        </div>
        <span className={`${termTextMuted} text-xs`}>cos-terminal</span>
        {/* Mobile-only status indicator */}
        <div className="flex items-center gap-2 ml-auto lg:hidden">
          <span className={`w-2 h-2 rounded-full ${running ? 'bg-port-success animate-pulse' : 'bg-[var(--port-terminal-text)]/30'}`}></span>
          <span className={`text-xs ${running ? 'text-port-success' : termTextMuted}`}>
            {running ? 'ACTIVE' : 'IDLE'}
          </span>
        </div>
      </div>

      {/* ASCII Art + Info + Controls in row on mobile */}
      <div className="flex items-center lg:items-start gap-3 lg:gap-4 mb-1 lg:mb-4">
        {/* ASCII Art - smaller on mobile */}
        <div className="shrink-0 scale-75 lg:scale-100 origin-top-left -mr-3 lg:mr-0">
          {ascii.map((line, i) => (
            <div
              key={i}
              className={`whitespace-pre leading-tight text-xs lg:text-sm ${speaking && [0, 1].includes(i) ? 'animate-pulse' : ''}`}
              style={{ color: stateConfig.color }}
            >
              {line}
            </div>
          ))}
        </div>
        <div className="flex flex-col text-xs pt-0 lg:pt-1 flex-1 min-w-0">
          <span className={`${termText} font-bold text-xs lg:text-sm`}>CoS Agent v1.0</span>
          <span className={`${termTextDim} truncate`}>PortOS · {stateConfig.label}</span>
          <span className={`${termTextMuted} hidden lg:block`}>~/portos/cos</span>
        </div>
        {/* Mobile control buttons */}
        <div className="flex lg:hidden gap-2 shrink-0">
          {running ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-1 bg-port-error/20 hover:bg-port-error/30 text-port-error rounded border border-port-error/40 text-xs transition-colors"
              aria-label="Stop CoS agent"
            >
              <Square size={10} aria-hidden="true" />
              stop
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center gap-1 px-2 py-1 bg-port-success/20 hover:bg-port-success/30 text-port-success rounded border border-port-success/40 text-xs transition-colors"
              aria-label="Start CoS agent"
            >
              <Play size={10} aria-hidden="true" />
              start
            </button>
          )}
        </div>
      </div>

      {/* Status line - desktop only */}
      <div className="hidden lg:flex items-center gap-2 mb-3 text-xs">
        <span className={`w-2 h-2 rounded-full ${running ? 'bg-port-success animate-pulse' : 'bg-[var(--port-terminal-text)]/30'}`}></span>
        <span className={running ? 'text-port-success' : termTextMuted}>
          {running ? 'ACTIVE' : 'IDLE'}
        </span>
        <span className={termTextFaint}>│</span>
        <span className={termTextDim}>{stateConfig.icon}</span>
      </div>

      {/* Message bubble as terminal output - compact two-line layout */}
      <div className="mb-1 lg:mb-2 px-2 py-1 bg-[var(--port-terminal-text)]/10 rounded border-l-2 border-port-accent/50 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-port-accent">$</span>
          <span className={`${termTextDim} truncate`}>{statusMessage}</span>
        </div>
      </div>

      {/* Stats as terminal output - desktop only */}
      {stats && (
        <div className="hidden lg:block mb-4 text-xs space-y-1">
          <div className={termTextMuted}>┌─ stats ──────────────────┐</div>
          <div className={`${termTextDim} pl-2`}>│ tasks_completed: <span className="text-port-success">{stats.tasksCompleted || 0}</span></div>
          <div className={`${termTextDim} pl-2`}>│ agents_spawned:  <span className="text-port-accent">{stats.agentsSpawned || 0}</span></div>
          <div className={`${termTextDim} pl-2`}>│ errors:          <span className="text-port-error">{stats.errors || 0}</span></div>
          <div className={termTextMuted}>└──────────────────────────┘</div>
        </div>
      )}

      {/* Event logs as terminal output - desktop only */}
      <div className="hidden lg:flex flex-1 min-w-0 mb-4 flex-col min-h-0">
        <div className={`${termTextMuted} text-xs mb-1`}>// event_log</div>
        <div className="flex-1 min-w-0 bg-[var(--port-terminal-text)]/5 rounded p-2 overflow-y-auto scrollbar-hide">
          {(!eventLogs || eventLogs.length === 0) ? (
            <div className={`${termTextFaint} text-xs`}>waiting for events...</div>
          ) : (
            eventLogs.slice(-20).reverse().map((log, i) => (
              <div key={i} className={`text-xs break-all ${levelColors[log.level] || termTextDim} leading-relaxed`}>
                <span className={termTextFaint}>{new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false })}</span>
                {' '}
                <span className={levelColors[log.level]}>{levelPrefixes[log.level] || '[LOG]'}</span>
                {' '}
                <span className={termTextDim}>{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Control buttons as terminal commands - desktop only */}
      <div className="hidden lg:block mt-auto pt-3 border-t border-port-border">
        <div className="flex gap-2">
          {running ? (
            <button
              onClick={onStop}
              className="flex items-center gap-2 px-3 py-1.5 bg-port-error/20 hover:bg-port-error/30 text-port-error rounded border border-port-error/40 text-xs transition-colors"
              aria-label="Stop CoS agent"
            >
              <Square size={12} aria-hidden="true" />
              ./stop
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center gap-2 px-3 py-1.5 bg-port-success/20 hover:bg-port-success/30 text-port-success rounded border border-port-success/40 text-xs transition-colors"
              aria-label="Start CoS agent"
            >
              <Play size={12} aria-hidden="true" />
              ./start
            </button>
          )}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs ${
            running ? 'text-port-success bg-port-success/20' : `${termTextMuted} bg-[var(--port-terminal-text)]/10`
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-port-success' : 'bg-[var(--port-terminal-text)]/30'}`}></span>
            {running ? 'running' : 'stopped'}
          </div>
        </div>
      </div>
    </div>
  );
}
