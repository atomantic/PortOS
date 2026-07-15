import { useEffect, useRef, useState, useCallback } from 'react';
import { RefreshCw, Power, PowerOff, FolderOpen, ChevronDown, Bot, Maximize2, Minimize2 } from 'lucide-react';
import * as api from '../services/api';
import { readClipboard } from '../lib/clipboard';
import { useShellSession, MAX_SESSIONS } from '../hooks/useShellSession';
import TerminalHotKeys from '../components/shell/TerminalHotKeys';
import ShellSessionTabs from '../components/shell/ShellSessionTabs';

const QUICK_COMMANDS = [
  { label: 'claude', command: 'claude --dangerously-skip-permissions' },
  { label: 'codex', command: 'codex --dangerously-bypass-approvals-and-sandbox' },
  { label: 'agy', command: 'agy' },
  { label: 'grok', command: 'grok' },
  { label: 'openclaw', command: 'openclaw tui' },
  // Claude Code slash-command shortcuts — typed + submitted into an interactive
  // `claude` session. The flags are double-dash (`--`); keep them verbatim.
  { label: '/do:next', command: '/do:next --issues --self --review-with=claude,codex --merge' },
  { label: '/remote-control', command: '/remote-control' },
];

export default function Shell() {
  // Fullscreen promotes the terminal to a fixed overlay above the sidebar, hiding
  // the stacked toolbars so the TUI gets the whole viewport — the key mobile win
  // where the header/tabs/quick-commands otherwise eat most of the screen.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [appFolders, setAppFolders] = useState([]);
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const pasteInputRef = useRef(null);
  const dropdownRef = useRef(null);

  // All socket/session/terminal state + the attach/detach lifecycle live in the hook.
  const {
    terminalRef,
    connected,
    sessions,
    activeSessionId,
    activeSession,
    interactiveCount,
    liveRunCount,
    isLiveRun,
    emitShellInput,
    sendCommand,
    sendCtrlC,
    sendNavKey,
    restartSession,
    stopSession,
    startNewSession,
    switchToSession,
    killOtherSession,
  } = useShellSession({ isFullscreen });

  // Fetch app folders from the managed apps list
  useEffect(() => {
    api.getApps()
      .then(apps => setAppFolders(
        (apps || [])
          .filter(a => a.repoPath)
          .map(a => ({ name: a.name, path: a.repoPath }))
          .sort((a, b) => a.name.localeCompare(b.name))
      ))
      .catch(err => console.warn('fetch app folders:', err?.message ?? String(err)));
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

  const handlePaste = useCallback(async () => {
    const text = await readClipboard();
    if (text == null) { setShowPasteInput(true); return; }
    if (text) emitShellInput(text);
  }, [emitShellInput]);

  const handlePasteInputEvent = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text');
    if (text) emitShellInput(text);
    setShowPasteInput(false);
  }, [emitShellInput]);

  useEffect(() => {
    if (showPasteInput) pasteInputRef.current?.focus();
  }, [showPasteInput]);

  return (
    <div className={isFullscreen
      ? 'fixed inset-0 z-[70] flex flex-col bg-port-bg p-2'
      : 'h-full flex flex-col p-4 md:p-6'}>
      {/* Header (hidden in fullscreen — the compact bottom bar takes over) */}
      {!isFullscreen && (
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-xl font-semibold text-white">Shell</h1>
        <div className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${
          connected ? 'bg-port-success/20 text-port-success' : 'bg-gray-500/20 text-gray-400'
        }`}>
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-port-success' : 'bg-gray-500'}`} />
          {connected ? 'Connected' : 'Disconnected'}
        </div>
        {interactiveCount > 0 && (
          <span className="text-xs text-gray-500 font-mono">{interactiveCount}/{MAX_SESSIONS}</span>
        )}
        {liveRunCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-port-accent font-mono" title={`${liveRunCount} live TUI run${liveRunCount > 1 ? 's' : ''}`}>
            <Bot size={12} />
            {liveRunCount} live
          </span>
        )}
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => setIsFullscreen(true)}
            className="flex items-center gap-1.5 px-2.5 py-2 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded-lg text-sm transition-colors border border-port-border min-h-[40px]"
            title="Fullscreen terminal"
            aria-label="Fullscreen terminal"
          >
            <Maximize2 size={16} />
            <span className="hidden sm:inline">Fullscreen</span>
          </button>
          {/* Restart (kill + new shell) is meaningless for a TUI-run view. */}
          {connected && !isLiveRun && (
            <button
              onClick={restartSession}
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
              className="flex items-center gap-1.5 px-2.5 py-2 bg-port-error/20 hover:bg-port-error/30 text-port-error rounded-lg text-sm transition-colors min-h-[40px]"
              title={isLiveRun ? 'Stop this TUI run' : 'Kill current session'}
            >
              <PowerOff size={16} />
              <span className="hidden sm:inline">Stop</span>
            </button>
          )}
          <button
            onClick={startNewSession}
            className="flex items-center gap-1.5 px-2.5 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg text-sm transition-colors min-h-[40px]"
            title="Start new session"
          >
            <Power size={16} />
            <span className="hidden sm:inline">New</span>
          </button>
        </div>
      </div>
      )}

      {/* Session tabs */}
      {!isFullscreen && sessions.length > 0 && (
        <ShellSessionTabs
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSwitch={switchToSession}
          onKill={killOtherSession}
          onNew={startNewSession}
        />
      )}

      {/* Live TUI run banner — these views are interactive: type to answer or
          correct the model, or Stop to end it. It won't auto-close while open. */}
      {!isFullscreen && connected && isLiveRun && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded bg-port-accent/10 border border-port-accent/30 text-port-accent text-xs">
          <Bot size={14} className="shrink-0" />
          <span>
            Live run <span className="font-mono">{activeSession?.label || 'TUI'}</span> — you can type to answer or correct it,
            or <span className="font-semibold">Stop</span> to end it. It won't idle-close while you have it open.
          </span>
        </div>
      )}

      {/* Quick commands toolbar */}
      {!isFullscreen && connected && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <TerminalHotKeys
            sendCtrlC={sendCtrlC}
            handlePaste={handlePaste}
            sendNavKey={sendNavKey}
            showPasteInput={showPasteInput}
            setShowPasteInput={setShowPasteInput}
            pasteInputRef={pasteInputRef}
            handlePasteInputEvent={handlePasteInputEvent}
          />
          <div className="w-px h-6 bg-port-border" />
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
                      sendCommand(`cd '${path.replace(/'/g, "'\\''")}'`);
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

      {/* Terminal container — drops the rounded border in fullscreen so it sits flush */}
      <div className={`flex-1 bg-port-bg overflow-hidden ${isFullscreen ? '' : 'rounded-lg border border-port-border'}`}>
        <div
          ref={terminalRef}
          className="w-full h-full"
          style={{ padding: '8px' }}
        />
      </div>

      {/* Fullscreen control bar — compact, single-row, horizontally scrollable so
          the TUI-driving keys stay reachable by thumb without the stacked toolbars. */}
      {isFullscreen && (
        <div className="flex items-center gap-1.5 mt-2 overflow-x-auto pb-1">
          <button
            onClick={() => setIsFullscreen(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded text-xs transition-colors border border-port-border min-h-[40px] shrink-0"
            title="Exit fullscreen"
            aria-label="Exit fullscreen"
          >
            <Minimize2 size={14} />
            <span className="hidden sm:inline">Exit</span>
          </button>
          <div className="w-px h-6 bg-port-border shrink-0" />
          {connected && (
            <TerminalHotKeys
              sendCtrlC={sendCtrlC}
              handlePaste={handlePaste}
              sendNavKey={sendNavKey}
              showPasteInput={showPasteInput}
              setShowPasteInput={setShowPasteInput}
              pasteInputRef={pasteInputRef}
              handlePasteInputEvent={handlePasteInputEvent}
            />
          )}
        </div>
      )}
    </div>
  );
}
