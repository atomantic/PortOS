import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSocket } from './useSocket';
import { useThemeContext } from '../components/ThemeContext';
import { createShellTerminal, readTerminalTheme } from '../components/shell/createShellTerminal';

export const ITERM_SHELL_PATH = '/shell/iterm';

/**
 * useItermSession — socket + terminal state for the Shell page's iTerm2 view
 * (#8114). Sibling of useShellSession, but it speaks ONLY the `iterm:*` events,
 * so an iTerm2 session never enters the PortOS shell tab strip or registry.
 *
 * Differences from a PortOS PTY that shape this hook:
 *   - iTerm2 owns the size. The terminal is sized to the server-reported grid
 *     with `term.resize(cols, rows)` (never fit to the container, never a
 *     resize event back), and the container scrolls when narrower.
 *   - Many viewers may watch one session, so there is no claim/detached dance:
 *     attaching only adds this socket as a viewer.
 *   - PortOS cannot create, stop or restart iTerm2 sessions.
 *
 * The selected session lives in the URL (`/shell/iterm/:itermSessionId`).
 * With no id, the first listed session is selected with a replace navigation;
 * an id the connected bridge no longer lists falls back to the view root.
 * `pendingRef = { target, generation }` gates `iterm:attached` by strict
 * equality so a response for a session the user already left is dropped.
 *
 * @param {object} params
 * @param {string|undefined} params.itermSessionId - selection from the URL
 * @param {boolean} params.enabled - false while the feature is off: no subscription
 */
export function useItermSession({ itermSessionId, enabled = true } = {}) {
  const socket = useSocket();
  const navigate = useNavigate();
  // navigate's identity can change per location; keep it out of the socket
  // effect's deps so a selection never tears down the list subscription.
  const navigateRef = useRef(navigate);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);
  const { themeId, theme: activeTheme } = useThemeContext();
  const themeMode = activeTheme?.mode ?? 'night';
  const terminalRef = useRef(null);
  const termRef = useRef(null);
  const attachedIdRef = useRef(null);
  const pendingRef = useRef({ target: null, generation: 0 });
  const [sessions, setSessions] = useState(null); // null = not listed yet
  const [status, setStatus] = useState(null);
  const [attachedId, setAttachedId] = useState(null);

  const setPending = useCallback((target) => {
    pendingRef.current = { target, generation: pendingRef.current.generation + 1 };
  }, []);

  // Terminal lifetime = component lifetime.
  useEffect(() => {
    if (!enabled || !terminalRef.current || termRef.current) return undefined;
    termRef.current = createShellTerminal(terminalRef.current, { scrollback: 0, cursorBlink: false });
    return () => {
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTerminalTheme();
  }, [themeId, themeMode]);

  const sizeTo = useCallback((cols, rows) => {
    const term = termRef.current;
    if (!term || !(cols > 0) || !(rows > 0)) return;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
  }, []);

  const emitInput = useCallback((data, { focus = true } = {}) => {
    const id = attachedIdRef.current;
    if (!socket || !id || pendingRef.current.target) return false;
    socket.emit('iterm:input', { id, data });
    if (focus) termRef.current?.focus();
    return true;
  }, [socket]);

  // Keystrokes typed into the terminal go to the viewed iTerm2 session verbatim.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return undefined;
    const disposable = term.onData((data) => emitInput(data, { focus: false }));
    return () => disposable.dispose();
  }, [emitInput, enabled]);

  // List subscription + event wiring.
  useEffect(() => {
    if (!socket || !enabled) return undefined;

    const handleConnect = () => socket.emit('iterm:list');
    // The server drops a disconnected socket's views, so forget ours too; the
    // null list makes the URL effect re-attach once the reconnect re-lists.
    const handleDisconnect = () => {
      attachedIdRef.current = null;
      setAttachedId(null);
      setPending(null);
      setSessions(null);
    };
    const handleSessions = ({ sessions: list, status: nextStatus } = {}) => {
      setSessions(Array.isArray(list) ? list : []);
      setStatus(nextStatus ?? null);
      const active = list?.find?.((s) => s.id === attachedIdRef.current);
      if (active) sizeTo(active.cols, active.rows);
    };
    const handleAttached = ({ id, cols, rows, bufferedOutput }) => {
      if (pendingRef.current.target !== id) return;
      setPending(null);
      attachedIdRef.current = id;
      setAttachedId(id);
      const term = termRef.current;
      if (!term) return;
      term.reset();
      sizeTo(cols, rows);
      if (bufferedOutput) term.write(bufferedOutput);
    };
    const handleOutput = ({ id, data }) => {
      if (id === attachedIdRef.current && !pendingRef.current.target) termRef.current?.write(data);
    };
    const handleExit = ({ id }) => {
      if (id !== attachedIdRef.current) return;
      attachedIdRef.current = null;
      setAttachedId(null);
      termRef.current?.writeln('\r\n\x1b[33m[iTerm2 session closed]\x1b[0m');
      // No navigation here: the bridge also sends this when its iTerm2
      // connection drops, and the URL must survive that. The next list
      // decides — re-attach if it is back, fall back if it is really gone.
    };
    const handleError = ({ id, error }) => {
      if (id !== pendingRef.current.target && id !== attachedIdRef.current) return;
      if (id === pendingRef.current.target) setPending(null);
      termRef.current?.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('iterm:sessions', handleSessions);
    socket.on('iterm:attached', handleAttached);
    socket.on('iterm:output', handleOutput);
    socket.on('iterm:exit', handleExit);
    socket.on('iterm:error', handleError);
    if (socket.connected) handleConnect();

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('iterm:sessions', handleSessions);
      socket.off('iterm:attached', handleAttached);
      socket.off('iterm:output', handleOutput);
      socket.off('iterm:exit', handleExit);
      socket.off('iterm:error', handleError);
      if (socket.connected) {
        const viewing = attachedIdRef.current ?? pendingRef.current.target;
        if (viewing) socket.emit('iterm:detach', { id: viewing });
        socket.emit('iterm:unlist');
      }
      attachedIdRef.current = null;
    };
  }, [socket, enabled, setPending, sizeTo]);

  const sessionIds = sessions?.map((s) => s.id).join('\n') ?? null;
  // Only a connected bridge's list is authoritative about what exists; while
  // iTerm2 is reconnecting the list is empty and the URL must stay put.
  const listAuthoritative = status?.state === 'connected';

  // URL → attachment. No id: select the first session. Unknown id once the
  // list is in: fall back to the view root rather than a dead deep link.
  useEffect(() => {
    if (!socket || !enabled || sessionIds === null) return;
    const ids = sessionIds ? sessionIds.split('\n') : [];
    if (!itermSessionId) {
      if (ids.length > 0) navigateRef.current(`${ITERM_SHELL_PATH}/${ids[0]}`, { replace: true });
      return;
    }
    if (!ids.includes(itermSessionId)) {
      if (listAuthoritative) navigateRef.current(ITERM_SHELL_PATH, { replace: true });
      return;
    }
    if (attachedIdRef.current === itermSessionId || pendingRef.current.target === itermSessionId) return;
    // Stop viewing whatever this replaces — including an attach still in
    // flight, whose late reply the pending guard will drop.
    const superseded = attachedIdRef.current ?? pendingRef.current.target;
    if (superseded) socket.emit('iterm:detach', { id: superseded });
    attachedIdRef.current = null;
    setAttachedId(null);
    setPending(itermSessionId);
    const term = termRef.current;
    if (term) {
      term.reset();
      term.writeln('\x1b[36mAttaching to iTerm2 session...\x1b[0m');
    }
    socket.emit('iterm:attach', { id: itermSessionId });
  }, [socket, enabled, itermSessionId, sessionIds, listAuthoritative, setPending]);

  const selectSession = useCallback((id) => {
    if (id !== itermSessionId) navigateRef.current(`${ITERM_SHELL_PATH}/${id}`);
  }, [itermSessionId]);

  const sendNavKey = useCallback((key) => {
    // The frames carry no DECCKM state, so arrows always go out in CSI form,
    // which shells, vim and Claude Code all accept.
    emitInput(key.seq ?? `\x1b[${key.code}`, { focus: false });
  }, [emitInput]);

  const activeSession = sessions?.find((s) => s.id === attachedId) ?? null;

  return {
    terminalRef,
    sessions: sessions ?? [],
    listed: sessions !== null,
    status,
    activeSession,
    connected: Boolean(attachedId),
    selectSession,
    emitInput,
    sendCtrlB: () => emitInput('\x02'),
    sendCtrlC: () => emitInput('\x03'),
    sendEsc: () => emitInput('\x1b'),
    sendNavKey,
  };
}
