import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSocket } from '../hooks/useSocket';
import { RefreshCw, Power, PowerOff, FolderOpen, ChevronDown, Plus, X, Terminal as TerminalIcon } from 'lucide-react';

// Must match MAX_TOTAL_SESSIONS in server/services/shell.js
const MAX_SESSIONS = 5;

const QUICK_COMMANDS = [
  { label: 'claude', command: 'claude --dangerously-skip-permissions' },
  { label: 'git status', command: 'git status' },
  { label: 'git pull', command: 'git pull --rebase --autostash' },
  { label: 'npm test', command: 'npm test' },
  { label: 'npm run dev', command: 'npm run dev' },
];

// Read a CSS custom property as hex (e.g., '--port-bg' → '#0f0f0f')
const getThemeHex = (varName) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return '#000000';
  const parts = raw.split(' ').map(Number);
  if (parts.length !== 3) return '#000000';
  return '#' + parts.map(n => n.toString(16).padStart(2, '0')).join('');
};

const formatAge = (createdAt) => {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
};

const shortId = (id) => id?.slice(0, 6) ?? '';

export default function Shell() {
  const [searchParams, setSearchParams] = useSearchParams();
  const terminalRef = useRef(null);
  const termInstanceRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const initialOptsRef = useRef(null);
  const hasInitializedRef = useRef(false);
  const socket = useSocket();
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [appFolders, setAppFolders] = useState([]);
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Read query params once on mount for initial session options
  useEffect(() => {
    if (initialOptsRef.current) return;
    const cwd = searchParams.get('cwd');
    const cmd = searchParams.get('cmd');
    if (cwd || cmd) {
      initialOptsRef.current = { cwd, cmd };
      setSearchParams({}, { replace: true });
    } else {
      initialOptsRef.current = {};
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch app folders from the managed apps list
  useEffect(() => {
    fetch('/api/apps')
      .then(res => res.ok ? res.json() : Promise.reject())
      .then(apps => setAppFolders(
        (apps || [])
          .filter(a => a.repoPath)
          .map(a => ({ name: a.name, path: a.repoPath }))
          .sort((a, b) => a.name.localeCompare(b.name))
      ))
      .catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setFolderDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Send a command string to the active shell session
  const sendCommand = useCallback((cmd) => {
    if (!socket || !sessionIdRef.current) return;
    socket.emit('shell:input', { sessionId: sessionIdRef.current, data: cmd + '\n' });
    termInstanceRef.current?.focus();
  }, [socket]);

  // Initialize terminal once
  useEffect(() => {
    if (!terminalRef.current || termInstanceRef.current) return;

    const bg = getThemeHex('--port-bg');
    const fg = getThemeHex('--port-text');
    const accent = getThemeHex('--port-accent');
    const card = getThemeHex('--port-card');
    const error = getThemeHex('--port-error');
    const success = getThemeHex('--port-success');
    const warning = getThemeHex('--port-warning');

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: '"Roboto Mono for Powerline", "MesloLGS NF", "MesloLGS Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: bg,
        foreground: fg,
        cursor: accent,
        cursorAccent: bg,
        selectionBackground: accent + '40',
        black: card,
        red: error,
        green: success,
        yellow: warning,
        blue: accent,
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: fg,
        brightBlack: '#404040',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#c084fc',
        brightCyan: '#22d3ee',
        brightWhite: '#ffffff'
      },
      scrollback: 5000,
      allowProposedApi: true
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    termInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    return () => {
      term.dispose();
      termInstanceRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      if (fitAddonRef.current && termInstanceRef.current) {
        fitAddonRef.current.fit();
        if (socket && sessionIdRef.current) {
          socket.emit('shell:resize', {
            sessionId: sessionIdRef.current,
            cols: termInstanceRef.current.cols,
            rows: termInstanceRef.current.rows
          });
        }
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [socket]);

  // Handle terminal input
  useEffect(() => {
    if (!termInstanceRef.current || !socket) return;

    const disposable = termInstanceRef.current.onData((data) => {
      if (sessionIdRef.current) {
        socket.emit('shell:input', { sessionId: sessionIdRef.current, data });
      }
    });

    return () => disposable.dispose();
  }, [socket]);

  const activateSession = useCallback((sessionId) => {
    sessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setConnected(true);
  }, []);

  const startSession = useCallback(() => {
    if (!socket?.connected) return;
    if (termInstanceRef.current) {
      termInstanceRef.current.clear();
      termInstanceRef.current.writeln('\x1b[36mStarting shell session...\x1b[0m');
    }
    const opts = initialOptsRef.current || {};
    const startOpts = {};
    if (opts.cwd) startOpts.cwd = opts.cwd;
    if (opts.cmd) startOpts.initialCommand = opts.cmd;
    initialOptsRef.current = {};
    socket.emit('shell:start', Object.keys(startOpts).length > 0 ? startOpts : undefined);
  }, [socket]);

  const attachToSession = useCallback((sessionId) => {
    if (!socket?.connected) return;
    if (termInstanceRef.current) {
      termInstanceRef.current.clear();
      termInstanceRef.current.writeln('\x1b[36mAttaching to session...\x1b[0m');
    }
    socket.emit('shell:attach', { sessionId });
  }, [socket]);

  const stopSession = useCallback(() => {
    if (socket && sessionIdRef.current) {
      socket.emit('shell:stop', { sessionId: sessionIdRef.current });
      sessionIdRef.current = null;
      setActiveSessionId(null);
      setConnected(false);
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln('\r\n\x1b[33m[Session killed]\x1b[0m');
      }
    }
  }, [socket]);

  const killOtherSession = useCallback((sessionId) => {
    if (!socket) return;
    socket.emit('shell:stop', { sessionId });
    // If killing the active session via tab X, clean up local state too
    if (sessionId === sessionIdRef.current) {
      sessionIdRef.current = null;
      setActiveSessionId(null);
      setConnected(false);
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln('\r\n\x1b[33m[Session killed]\x1b[0m');
      }
    }
  }, [socket]);

  const switchToSession = useCallback((sessionId) => {
    if (sessionId === sessionIdRef.current) return;
    // Detach current display (don't kill)
    sessionIdRef.current = null;
    setActiveSessionId(null);
    setConnected(false);
    attachToSession(sessionId);
  }, [attachToSession]);

  // Handle socket connection and shell session events
  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      // Request session list first — decide what to do in handleSessions
      hasInitializedRef.current = false;
      socket.emit('shell:list');
    };

    const handleDisconnect = () => {
      // Clear session state so reconnect auto-reattaches
      sessionIdRef.current = null;
      setActiveSessionId(null);
      setConnected(false);
    };

    const handleSessions = (sessionList) => {
      setSessions(sessionList);
      // On first load, auto-attach to existing session or create new
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        const opts = initialOptsRef.current || {};
        // If we have initial opts (cwd/cmd), always create a new session
        if (opts.cwd || opts.cmd) {
          startSession();
        } else if (sessionList.length > 0 && !sessionIdRef.current) {
          // Attach to most recent existing session
          const latest = sessionList[sessionList.length - 1];
          attachToSession(latest.sessionId);
        } else if (sessionList.length === 0) {
          startSession();
        }
      }
    };

    const handleShellStarted = ({ sessionId: sid }) => {
      activateSession(sid);
      if (termInstanceRef.current) {
        socket.emit('shell:resize', {
          sessionId: sid,
          cols: termInstanceRef.current.cols,
          rows: termInstanceRef.current.rows
        });
      }
    };

    const handleShellAttached = ({ sessionId: sid, bufferedOutput }) => {
      activateSession(sid);
      if (termInstanceRef.current) {
        termInstanceRef.current.clear();
        if (bufferedOutput) {
          termInstanceRef.current.write(bufferedOutput);
        }
        socket.emit('shell:resize', {
          sessionId: sid,
          cols: termInstanceRef.current.cols,
          rows: termInstanceRef.current.rows
        });
      }
    };

    const handleShellOutput = ({ sessionId: sid, data }) => {
      // Only render output for the currently viewed session
      if (sid === sessionIdRef.current && termInstanceRef.current) {
        termInstanceRef.current.write(data);
      }
    };

    const handleShellExit = ({ sessionId: sid, code }) => {
      if (sid === sessionIdRef.current) {
        setConnected(false);
        sessionIdRef.current = null;
        setActiveSessionId(null);
        if (termInstanceRef.current) {
          termInstanceRef.current.writeln(`\r\n\x1b[33m[Shell exited with code ${code}]\x1b[0m`);
        }
        // Auto-attach to next available session if any remain
        setSessions(prev => {
          const remaining = prev.filter(s => s.sessionId !== sid);
          if (remaining.length > 0) {
            setTimeout(() => attachToSession(remaining[remaining.length - 1].sessionId), 100);
          }
          return prev; // actual list update comes from server broadcast
        });
      }
    };

    const handleShellError = ({ error }) => {
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('shell:sessions', handleSessions);
    socket.on('shell:started', handleShellStarted);
    socket.on('shell:attached', handleShellAttached);
    socket.on('shell:output', handleShellOutput);
    socket.on('shell:exit', handleShellExit);
    socket.on('shell:error', handleShellError);

    if (socket.connected) {
      handleConnect();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('shell:sessions', handleSessions);
      socket.off('shell:started', handleShellStarted);
      socket.off('shell:attached', handleShellAttached);
      socket.off('shell:output', handleShellOutput);
      socket.off('shell:exit', handleShellExit);
      socket.off('shell:error', handleShellError);
      // Don't kill session on unmount — it persists server-side
      sessionIdRef.current = null;
    };
  }, [socket, startSession, attachToSession, activateSession]);

  return (
    <div className="h-full flex flex-col p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-xl font-semibold text-white">Shell</h1>
        <div className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${
          connected ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
        }`}>
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-500'}`} />
          {connected ? 'Connected' : 'Disconnected'}
        </div>
        {sessions.length > 0 && (
          <span className="text-xs text-gray-500 font-mono">{sessions.length}/{MAX_SESSIONS}</span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          {connected && (
            <button
              onClick={() => { stopSession(); setTimeout(startSession, 1000); }}
              className="flex items-center gap-1.5 px-2.5 py-2 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded-lg text-sm transition-colors border border-port-border min-h-[40px]"
              title="Restart session (kill + new)"
            >
              <RefreshCw size={16} />
              <span className="hidden sm:inline">Restart</span>
            </button>
          )}
          {connected && (
            <button
              onClick={stopSession}
              className="flex items-center gap-1.5 px-2.5 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm transition-colors min-h-[40px]"
              title="Kill current session"
            >
              <PowerOff size={16} />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}
          <button
            onClick={startSession}
            className="flex items-center gap-1.5 px-2.5 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm transition-colors min-h-[40px]"
            title="Start new session"
          >
            <Power size={16} />
            <span className="hidden sm:inline">New</span>
          </button>
        </div>
      </div>

      {/* Session tabs */}
      {sessions.length > 0 && (
        <div className="flex items-center gap-1.5 mb-3 overflow-x-auto pb-1">
          {sessions.map((s) => {
            const isActive = s.sessionId === activeSessionId;
            const label = s.cwd?.split('/').pop() || shortId(s.sessionId);
            return (
              <div
                key={s.sessionId}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer min-h-[40px] ${
                  isActive
                    ? 'bg-port-accent/20 text-port-accent border border-port-accent/40'
                    : 'bg-port-card hover:bg-port-border text-gray-400 hover:text-white border border-port-border'
                }`}
                onClick={() => !isActive && switchToSession(s.sessionId)}
                title={`${s.cwd || shortId(s.sessionId)} — ${formatAge(s.createdAt)} old`}
              >
                <TerminalIcon size={12} className="shrink-0" />
                <span className="truncate max-w-[100px]">{label}</span>
                <span className="text-[10px] opacity-60 shrink-0">{formatAge(s.createdAt)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); killOtherSession(s.sessionId); }}
                  className={`shrink-0 ml-0.5 p-0.5 rounded transition-colors ${
                    isActive ? 'text-port-accent/60 hover:text-red-400' : 'text-gray-600 hover:text-red-400'
                  }`}
                  title="Kill session"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          <button
            onClick={startSession}
            className="flex items-center gap-1 px-2 py-1.5 text-xs text-gray-500 hover:text-white hover:bg-port-border rounded transition-colors min-h-[40px]"
            title="New session"
          >
            <Plus size={14} />
          </button>
        </div>
      )}

      {/* Quick commands toolbar */}
      {connected && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {QUICK_COMMANDS.map(({ label, command }) => (
            <button
              key={label}
              onClick={() => sendCommand(command)}
              className="px-3 py-1.5 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded text-xs font-mono transition-colors border border-port-border min-h-[40px]"
              title={command}
            >
              {label}
            </button>
          ))}

          {/* App folder cd selector */}
          <div className="relative ml-auto" ref={dropdownRef}>
            <button
              onClick={() => setFolderDropdownOpen(prev => !prev)}
              className="flex items-center gap-2 px-3 py-1.5 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded text-xs transition-colors border border-port-border min-h-[40px]"
            >
              <FolderOpen size={14} />
              cd to app
              <ChevronDown size={12} className={`transition-transform ${folderDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            {folderDropdownOpen && (
              <div className="absolute right-0 top-full mt-1 w-64 max-h-80 overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-xl z-50">
                {appFolders.map(({ name, path }) => (
                  <button
                    key={name}
                    onClick={() => {
                      sendCommand(`cd "${path}"`);
                      setFolderDropdownOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-xs font-mono text-gray-300 hover:bg-port-border hover:text-white transition-colors"
                  >
                    {name}
                  </button>
                ))}
                {appFolders.length === 0 && (
                  <div className="px-3 py-2 text-xs text-gray-500">No folders found</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Terminal container */}
      <div className="flex-1 bg-port-bg rounded-lg border border-port-border overflow-hidden">
        <div
          ref={terminalRef}
          className="w-full h-full"
          style={{ padding: '8px' }}
        />
      </div>
    </div>
  );
}
