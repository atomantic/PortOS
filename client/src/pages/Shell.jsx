import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSocket } from '../hooks/useSocket';
import { RefreshCw, Power, PowerOff } from 'lucide-react';

export default function Shell() {
  const terminalRef = useRef(null);
  const termInstanceRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const socket = useSocket();
  const [connected, setConnected] = useState(false);

  // Initialize terminal once
  useEffect(() => {
    if (!terminalRef.current || termInstanceRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0f0f0f',
        foreground: '#e5e5e5',
        cursor: '#3b82f6',
        cursorAccent: '#0f0f0f',
        selectionBackground: '#3b82f640',
        black: '#1a1a1a',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e5e5e5',
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

    // Defer initial fit to next frame for proper sizing
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
        // Notify server of resize if we have an active session
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

  const startSession = useCallback(() => {
    if (!socket) return;
    if (termInstanceRef.current) {
      termInstanceRef.current.clear();
      termInstanceRef.current.writeln('\x1b[36mStarting shell session...\x1b[0m');
    }
    socket.emit('shell:start');
  }, [socket]);

  const stopSession = useCallback(() => {
    if (socket && sessionIdRef.current) {
      socket.emit('shell:stop', { sessionId: sessionIdRef.current });
      sessionIdRef.current = null;
      setConnected(false);
    }
  }, [socket]);

  const restartSession = useCallback(() => {
    if (sessionIdRef.current && socket) {
      socket.emit('shell:stop', { sessionId: sessionIdRef.current });
    }
    sessionIdRef.current = null;
    setConnected(false);
    startSession();
  }, [socket, startSession]);

  // Handle socket connection and shell session events
  useEffect(() => {
    if (!socket) return;

    const handleConnect = () => {
      startSession();
    };

    const handleShellStarted = ({ sessionId: sid }) => {
      sessionIdRef.current = sid;
      setConnected(true);
      // Send initial size
      if (termInstanceRef.current) {
        socket.emit('shell:resize', {
          sessionId: sid,
          cols: termInstanceRef.current.cols,
          rows: termInstanceRef.current.rows
        });
      }
    };

    const handleShellOutput = ({ data }) => {
      if (termInstanceRef.current) {
        termInstanceRef.current.write(data);
      }
    };

    const handleShellExit = ({ code }) => {
      setConnected(false);
      sessionIdRef.current = null;
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln(`\r\n\x1b[33m[Shell exited with code ${code}]\x1b[0m`);
        termInstanceRef.current.writeln('\x1b[90mPress the restart button to start a new session\x1b[0m');
      }
    };

    const handleShellError = ({ error }) => {
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
      }
    };

    socket.on('connect', handleConnect);
    socket.on('shell:started', handleShellStarted);
    socket.on('shell:output', handleShellOutput);
    socket.on('shell:exit', handleShellExit);
    socket.on('shell:error', handleShellError);

    // Start session if already connected
    if (socket.connected) {
      startSession();
    }

    return () => {
      socket.off('connect', handleConnect);
      socket.off('shell:started', handleShellStarted);
      socket.off('shell:output', handleShellOutput);
      socket.off('shell:exit', handleShellExit);
      socket.off('shell:error', handleShellError);

      // Stop shell session on unmount
      if (sessionIdRef.current) {
        socket.emit('shell:stop', { sessionId: sessionIdRef.current });
        sessionIdRef.current = null;
      }
    };
  }, [socket, startSession]);

  return (
    <div className="h-full flex flex-col p-4 md:p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-white">Shell</h1>
          <div className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${
            connected ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-400'
          }`}>
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-500'}`} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <button
                onClick={restartSession}
                className="flex items-center gap-2 px-3 py-2 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-sm transition-colors min-h-[40px]"
                title="Restart session"
              >
                <RefreshCw size={16} />
                Restart
              </button>
              <button
                onClick={stopSession}
                className="flex items-center gap-2 px-3 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg text-sm transition-colors min-h-[40px]"
                title="Stop session"
              >
                <PowerOff size={16} />
                Stop
              </button>
            </>
          ) : (
            <button
              onClick={startSession}
              className="flex items-center gap-2 px-3 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm transition-colors min-h-[40px]"
              title="Start session"
            >
              <Power size={16} />
              Start
            </button>
          )}
        </div>
      </div>

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
