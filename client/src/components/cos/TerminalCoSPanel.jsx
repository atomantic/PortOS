import { Play, Square } from 'lucide-react';
import { AGENT_STATES } from './constants';

export default function TerminalCoSPanel({ state, speaking, statusMessage, eventLogs, running, onStart, onStop, stats, evalCountdown }) {
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

  const levelColors = {
    info: 'text-cyan-400',
    warn: 'text-yellow-400',
    error: 'text-red-400',
    success: 'text-green-400',
    debug: 'text-gray-500'
  };

  const levelPrefixes = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
    success: '✅',
    debug: '🔍'
  };

  return (
    <div className="relative flex flex-col p-3 lg:p-4 font-mono text-sm bg-[#0d1117] border-b lg:border-b-0 lg:border-r border-gray-700/50 shrink-0 lg:h-full overflow-hidden lg:overflow-y-auto scrollbar-hide max-h-[50vh] lg:max-h-none">
      {/* Scanline effect */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.02]"
        style={{
          background: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)'
        }}
      />

      {/* Terminal header */}
      <div className="flex items-center gap-3 mb-2 lg:mb-4 pb-2 border-b border-gray-700/50">
        <div className="flex gap-1.5">
          <span className="w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full bg-red-500/80"></span>
          <span className="w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full bg-yellow-500/80"></span>
          <span className="w-2.5 h-2.5 lg:w-3 lg:h-3 rounded-full bg-green-500/80"></span>
        </div>
        <span className="text-gray-500 text-xs">cos-terminal</span>
        {/* Mobile-only status indicator */}
        <div className="flex items-center gap-2 ml-auto lg:hidden">
          <span className={`w-2 h-2 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`}></span>
          <span className={`text-xs ${running ? 'text-green-400' : 'text-gray-500'}`}>
            {running ? 'ACTIVE' : 'IDLE'}
          </span>
        </div>
      </div>

      {/* ASCII Art + Info + Controls in row on mobile */}
      <div className="flex items-center lg:items-start gap-3 lg:gap-4 mb-1 lg:mb-4">
        {/* ASCII Art - smaller on mobile */}
        <div className="flex-shrink-0 scale-75 lg:scale-100 origin-top-left -mr-3 lg:mr-0">
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
          <span className="text-white font-bold text-xs lg:text-sm">CoS Agent v1.0</span>
          <span className="text-gray-400 truncate">PortOS · {stateConfig.label}</span>
          <span className="text-gray-500 hidden lg:block">~/portos/cos</span>
        </div>
        {/* Mobile control buttons */}
        <div className="flex lg:hidden gap-2 shrink-0">
          {running ? (
            <button
              onClick={onStop}
              className="flex items-center gap-1 px-2 py-1 bg-red-900/30 hover:bg-red-900/50 text-red-400 rounded border border-red-700/50 text-xs transition-colors"
              aria-label="Stop CoS agent"
            >
              <Square size={10} aria-hidden="true" />
              stop
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center gap-1 px-2 py-1 bg-green-900/30 hover:bg-green-900/50 text-green-400 rounded border border-green-700/50 text-xs transition-colors"
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
        <span className={`w-2 h-2 rounded-full ${running ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`}></span>
        <span className={running ? 'text-green-400' : 'text-gray-500'}>
          {running ? 'ACTIVE' : 'IDLE'}
        </span>
        <span className="text-gray-600">│</span>
        <span className="text-gray-400">{stateConfig.icon}</span>
      </div>

      {/* Message bubble as terminal output - compact two-line layout */}
      <div className="mb-1 lg:mb-2 px-2 py-1 bg-gray-800/50 rounded border-l-2 border-cyan-500/50 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-cyan-400">$</span>
          <span className="text-gray-300 truncate">{statusMessage}</span>
        </div>
        {evalCountdown && (
          <div className="text-cyan-500/60 font-mono mt-0.5">
            # next: ({evalCountdown.formatted})
          </div>
        )}
      </div>

      {/* Stats as terminal output - desktop only */}
      {stats && (
        <div className="hidden lg:block mb-4 text-xs space-y-1">
          <div className="text-gray-500">┌─ stats ──────────────────┐</div>
          <div className="text-gray-400 pl-2">│ tasks_completed: <span className="text-green-400">{stats.tasksCompleted || 0}</span></div>
          <div className="text-gray-400 pl-2">│ agents_spawned:  <span className="text-cyan-400">{stats.agentsSpawned || 0}</span></div>
          <div className="text-gray-400 pl-2">│ errors:          <span className="text-red-400">{stats.errors || 0}</span></div>
          <div className="text-gray-500">└──────────────────────────┘</div>
        </div>
      )}

      {/* Event logs as terminal output - desktop only */}
      <div className="hidden lg:flex flex-1 mb-4 flex-col min-h-0">
        <div className="text-gray-500 text-xs mb-1">// event_log</div>
        <div className="flex-1 bg-black/30 rounded p-2 overflow-y-auto scrollbar-hide">
          {(!eventLogs || eventLogs.length === 0) ? (
            <div className="text-gray-600 text-xs">waiting for events...</div>
          ) : (
            eventLogs.slice(-20).reverse().map((log, i) => (
              <div key={i} className={`text-xs ${levelColors[log.level] || 'text-gray-400'} leading-relaxed`}>
                <span className="text-gray-600">{new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false })}</span>
                {' '}
                <span className={levelColors[log.level]}>{levelPrefixes[log.level] || '[LOG]'}</span>
                {' '}
                <span className="text-gray-300">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Control buttons as terminal commands - desktop only */}
      <div className="hidden lg:block mt-auto pt-3 border-t border-gray-700/50">
        <div className="flex gap-2">
          {running ? (
            <button
              onClick={onStop}
              className="flex items-center gap-2 px-3 py-1.5 bg-red-900/30 hover:bg-red-900/50 text-red-400 rounded border border-red-700/50 text-xs transition-colors"
              aria-label="Stop CoS agent"
            >
              <Square size={12} aria-hidden="true" />
              ./stop
            </button>
          ) : (
            <button
              onClick={onStart}
              className="flex items-center gap-2 px-3 py-1.5 bg-green-900/30 hover:bg-green-900/50 text-green-400 rounded border border-green-700/50 text-xs transition-colors"
              aria-label="Start CoS agent"
            >
              <Play size={12} aria-hidden="true" />
              ./start
            </button>
          )}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs ${
            running ? 'text-green-400 bg-green-900/20' : 'text-gray-500 bg-gray-800/50'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${running ? 'bg-green-400' : 'bg-gray-600'}`}></span>
            {running ? 'running' : 'stopped'}
          </div>
        </div>
      </div>
    </div>
  );
}
