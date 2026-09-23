import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { AppWindow, Maximize2, Minimize2 } from 'lucide-react';
import * as api from '../../services/api';
import { readClipboard } from '../../lib/clipboard';
import { useInstanceFeatures } from '../../hooks/useInstanceFeatures.js';
import { useItermSession } from '../../hooks/useItermSession';
import TerminalHotKeys from './TerminalHotKeys';
import ShellSourceSwitch from './ShellSourceSwitch';
import ItermSessionTabs, { itermLocation } from './ItermSessionTabs';
import ItermStatusHint from './ItermStatusHint';
import { visibleQuickCommands } from './quickCommands';
import Kbd from '../ui/Kbd';

// The Shell page's iTerm2 view (#8114): this Mac's live iTerm2 sessions, shown
// and typed into from PortOS. Kept visibly and structurally apart from PortOS
// shells — its own URL, hook, toolbar and an amber iTerm2 frame — because
// iTerm2 owns these sessions' size and lifecycle: there is no New, Stop,
// Restart, cd picker or provider launcher here, and no resize is ever sent.
export default function ItermShellView() {
  const { itermSessionId } = useParams();
  const { features, isFeatureEnabled } = useInstanceFeatures();
  const enabled = isFeatureEnabled('iterm');
  const featureOff = features !== null && !enabled;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [fetchedStatus, setFetchedStatus] = useState(null);
  const pasteInputRef = useRef(null);

  const {
    terminalRef, sessions, listed, status, activeSession, connected,
    selectSession, emitInput, sendCtrlB, sendCtrlC, sendEsc, sendNavKey,
  } = useItermSession({ itermSessionId, enabled });

  // The static checks (not installed, API disabled, not running) come from the
  // status endpoint; the live socket status wins once it says anything more
  // specific than "disconnected".
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    api.getItermStatus({ silent: true })
      .then((res) => { if (active) setFetchedStatus(res?.state ?? null); })
      .catch(() => {});
    return () => { active = false; };
  }, [enabled]);
  const liveState = status?.state;
  const hintState = liveState && liveState !== 'disconnected' ? liveState : (fetchedStatus ?? liveState ?? 'disconnected');

  const handlePaste = useCallback(async () => {
    const text = await readClipboard();
    if (text == null) { setShowPasteInput(true); return; }
    if (text) emitInput(text);
  }, [emitInput]);

  const handlePasteInputEvent = useCallback((e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text');
    if (text) emitInput(text);
    setShowPasteInput(false);
  }, [emitInput]);

  useEffect(() => {
    if (showPasteInput) pasteInputRef.current?.focus();
  }, [showPasteInput]);

  const hotKeyProps = {
    sendCtrlB, sendCtrlC, sendEsc, handlePaste, sendNavKey,
    showPasteInput, setShowPasteInput, pasteInputRef, handlePasteInputEvent,
  };

  if (featureOff) {
    return (
      <div className="h-full flex flex-col gap-3 p-2 md:p-6">
        <h1 className="text-xl font-semibold text-white">Shell</h1>
        <p className="text-sm text-gray-400">
          iTerm2 sessions are turned off: <Link to="/settings/features" className="text-port-accent underline">Settings &gt; Features</Link>.{' '}
          <Link to="/shell" className="text-port-accent underline">Back to PortOS shells</Link>
        </p>
      </div>
    );
  }

  const geometry = activeSession ? `${activeSession.cols}×${activeSession.rows} · sized by iTerm` : null;

  return (
    <div className={isFullscreen
      ? 'fixed inset-0 z-[70] flex flex-col bg-port-bg p-2'
      : 'h-full flex flex-col gap-2 md:gap-3 p-2 md:p-6'}>
      {!isFullscreen && (
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-white min-w-0 truncate">Shell</h1>
          <ShellSourceSwitch source="iterm" />
          <span className="flex items-center gap-1 shrink-0 text-xs px-2 py-1 rounded bg-port-warning/15 text-port-warning">
            <AppWindow size={12} />
            <span className="hidden sm:inline">{activeSession ? itermLocation(activeSession) : 'iTerm2'}</span>
          </span>
          {geometry && (
            <span data-testid="iterm-geometry" className="hidden sm:inline text-xs text-gray-500 font-mono shrink-0">{geometry}</span>
          )}
          <button
            onClick={() => setIsFullscreen(true)}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-2 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded-lg text-sm transition-colors border border-port-border min-h-[40px] shrink-0"
            title="Fullscreen terminal"
            aria-label="Fullscreen terminal"
          >
            <Maximize2 size={16} />
            <span className="hidden sm:inline">Fullscreen</span>
          </button>
        </div>
      )}

      {!isFullscreen && sessions.length > 0 && (
        <ItermSessionTabs sessions={sessions} activeSessionId={activeSession?.id ?? itermSessionId} onSelect={selectSession} />
      )}

      {!isFullscreen && connected && (
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide touch-pan-x">
          <TerminalHotKeys {...hotKeyProps} />
          <div className="w-px h-6 bg-port-border shrink-0" />
          {visibleQuickCommands(isFeatureEnabled).map(({ label, command }) => (
            <button
              key={label}
              onClick={() => emitInput(`${command}\r`)}
              className="px-3 py-1.5 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded text-xs font-mono transition-colors border border-port-border min-h-[40px] shrink-0"
              title={command}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {!isFullscreen && listed && <ItermStatusHint state={hintState} sessionCount={sessions.length} />}

      {/* iTerm2 owns the grid: the terminal keeps iTerm2's cols/rows and this
          frame scrolls when it is narrower, instead of resizing iTerm2. */}
      <div className={`flex-1 min-h-0 bg-port-bg overflow-auto border-2 border-port-warning/60 ${isFullscreen ? '' : 'rounded-lg'}`}>
        <div ref={terminalRef} data-testid="iterm-terminal" className="inline-block" style={{ padding: '8px' }} />
      </div>

      {!isFullscreen && (
        <p className="shrink-0 px-1 text-xs text-gray-500">
          Typing goes to iTerm2. <Kbd size="sm">Shift+Tab</Kbd> moves focus out of the terminal
        </p>
      )}

      {isFullscreen && (
        <div className="flex items-center gap-1.5 mt-2 overflow-x-auto scrollbar-hide touch-pan-x pb-1">
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
          {connected && <TerminalHotKeys {...hotKeyProps} popoverPlacement="above" />}
        </div>
      )}
    </div>
  );
}
