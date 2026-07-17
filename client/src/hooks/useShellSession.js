import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, useParams, useNavigate } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSocket } from './useSocket';
import { useThemeContext } from '../components/ThemeContext';
import { buildTerminalTheme, parseCssColorToHex } from '../lib/terminalTheme';

// Must match MAX_TOTAL_SESSIONS in server/services/shell.js
export const MAX_SESSIONS = 20;

// Read the active theme's colors off the document and assemble the xterm palette.
// The day/night mode comes from the `data-port-theme-mode` attribute applyTheme()
// stamps on <html>, so this stays correct without threading React state in.
// Background/foreground prefer the dedicated --port-terminal-* tokens (hand-tuned
// per theme) and fall back to the page bg/text.
const readTerminalTheme = () => {
  const root = document.documentElement;
  const mode = root.dataset.portThemeMode === 'day' ? 'day' : 'night';
  const css = (varName) => getComputedStyle(root).getPropertyValue(varName).trim();
  return buildTerminalTheme({
    bg: parseCssColorToHex(css('--port-terminal-bg') || css('--port-bg'), '#070707'),
    fg: parseCssColorToHex(css('--port-terminal-text') || css('--port-text'), '#e5e5e5'),
    accent: parseCssColorToHex(css('--port-accent')),
    card: parseCssColorToHex(css('--port-card')),
    error: parseCssColorToHex(css('--port-error')),
    success: parseCssColorToHex(css('--port-success')),
    warning: parseCssColorToHex(css('--port-warning')),
  }, mode);
};

/**
 * useShellSession — all socket/session/terminal state and lifecycle for the Shell
 * page, extracted so the route component (`pages/Shell.jsx`) stays thin and purely
 * presentational (the WritersRoom pattern). The hook owns the xterm instance, the
 * Socket.IO shell:* protocol, and every attach/detach/generation guard.
 *
 * ── Attach/detach contract (single-subscriber PTY sessions) ─────────────────────
 * The server (`server/services/shell.js`) stores ONE attached socket per PTY session
 * and fans output to it. This hook implements the client half of that contract:
 *
 *   • pendingAttachRef = { target, generation } tracks the in-flight start/attach.
 *     - `target`: the requested session id, the sentinel 'new' (shell:start, id not
 *       yet known), or null (nothing pending OR the request was cancelled mid-flight).
 *     - `generation`: monotonically bumped on every state change (start, attach,
 *       success-consume, cancel, error). Deferred work (setTimeout fallbacks) captures
 *       the generation and aborts if it advanced — so a user action during the delay
 *       window can't be clobbered by a stale timer.
 *     Response handlers gate on STRICT equality with `target`: a null/stale target
 *     falls through, so a cancelled-during-pending response can never re-activate.
 *
 *   • claim:true on shell:attach → server refuses to displace a DIFFERENT socket.
 *     Auto-pick paths (survivor adoption, exit/error recovery) send claim:true so a
 *     multi-tab broadcast race can't boot another tab via shell:detached. User-intent
 *     paths (tab click, deep-link URL) default to claim:false so explicit intent wins.
 *
 *   • shell:detached — the server tells the previously-attached socket its session was
 *     taken over; we drop the dead local view rather than appear "Connected" forever.
 *
 *   • userIdleRef — set by explicit user-clear paths (Stop, kill-active) and cleared by
 *     every user-initiated start/attach. The passive-idle survivor-adoption branches
 *     skip while it's set, so a transient reconnect can't undo an explicit Stop.
 *
 *   • mountedRef — flipped false on unmount so a deferred (setTimeout) recovery attach
 *     short-circuits instead of claiming a session with no listener left to render it.
 *
 * `clearActiveSession()` clears only the DISPLAYED session — it never touches
 * pendingAttachRef, because clearing the view and cancelling an in-flight request are
 * separate concerns. Explicit cancellation paths call `cancelPendingAttach()` directly.
 *
 * @param {object} params
 * @param {boolean} params.isFullscreen — presentational fullscreen flag; drives a
 *   one-shot refit when the terminal swaps between in-flow and fixed-overlay layout.
 * @returns session state, terminal ref, and the session action callbacks the route
 *   renders against.
 */
export function useShellSession({ isFullscreen } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { sessionId: urlSessionId } = useParams();
  const navigate = useNavigate();
  const terminalRef = useRef(null);
  const termInstanceRef = useRef(null);
  const fitAddonRef = useRef(null);
  const sessionIdRef = useRef(null);
  const initialOptsRef = useRef(null);
  const hasInitializedRef = useRef(false);
  // Mirror urlSessionId into a ref so callbacks (activateSession, handleSessions) can read the
  // latest URL without forcing the heavy socket-listener effect to re-bind on every URL change.
  const urlSessionIdRef = useRef(urlSessionId);
  // Keep navigate in a ref so callbacks don't list it in deps — guarantees the socket-listener
  // effect can't tear down on URL change even if router internals ever start returning a fresh
  // navigate identity per render.
  const navigateRef = useRef(navigate);
  // Set to 'push' before any user-initiated switch (tab click, "New" button) so the next
  // activateSession pushes a history entry; auto/URL-driven switches keep the 'replace' default.
  const pendingNavIntentRef = useRef('replace');
  // In-flight start/attach state: { target, generation }. See the attach/detach
  // contract in the module doc comment above for the full semantics.
  const pendingAttachRef = useRef({ target: null, generation: 0 });
  // Flipped on unmount so deferred work (setTimeout-scheduled recovery attaches)
  // can short-circuit instead of firing shell:attach from a teardown component —
  // which would claim a session with no listener left to render it.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  // useCallback for stable identity so consumers can list these in dep arrays without
  // causing useEffect re-binds on every render. They only touch a ref, so empty deps is correct.
  const setPendingAttach = useCallback((target) => {
    pendingAttachRef.current = { target, generation: pendingAttachRef.current.generation + 1 };
  }, []);
  const cancelPendingAttach = useCallback(() => setPendingAttach(null), [setPendingAttach]);
  // True when the user explicitly cleared the active session (Stop button or X on the
  // active tab) and is intentionally sitting at /shell. The passive-idle adoption branch
  // in handleSessions must skip while this is set, otherwise the next broadcast would
  // immediately attach a free survivor and undo the user's explicit "leave at /shell".
  // Cleared by any user-initiated start/attach action.
  const userIdleRef = useRef(false);
  const socket = useSocket();
  const { themeId, theme: activeTheme } = useThemeContext();
  const themeMode = activeTheme?.mode ?? 'night';
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const sessionsRef = useRef([]);

  useEffect(() => { urlSessionIdRef.current = urlSessionId; }, [urlSessionId]);
  useEffect(() => { navigateRef.current = navigate; }, [navigate]);

  // Read query params once on mount for initial session options
  useEffect(() => {
    if (initialOptsRef.current) return;
    const cwd = searchParams.get('cwd');
    const cmd = searchParams.get('cmd');
    const session = searchParams.get('session');
    if (cwd || cmd || session) {
      initialOptsRef.current = { cwd, cmd, session };
      setSearchParams({}, { replace: true });
    } else {
      initialOptsRef.current = {};
    }
  }, []);

  // focus:false skips returning keyboard focus to the terminal after sending — used by
  // the nav-key hot buttons so repeated arrow taps on touch devices don't keep re-summoning
  // the on-screen keyboard (input is delivered over the socket regardless of focus).
  const emitShellInput = useCallback((data, { focus = true } = {}) => {
    if (!socket || !sessionIdRef.current) return;
    // Don't fire quick-commands into the prior session while a switch/start is mid-flight.
    if (pendingAttachRef.current.target) return;
    socket.emit('shell:input', { sessionId: sessionIdRef.current, data });
    if (focus) termInstanceRef.current?.focus();
  }, [socket]);

  const sendCommand = useCallback((cmd) => emitShellInput(cmd + '\n'), [emitShellInput]);
  const sendCtrlC = useCallback(() => emitShellInput('\x03'), [emitShellInput]);
  // Arrow keys send CSI or SS3 based on the terminal's DECCKM state (see NAV_KEYS);
  // Enter and any other literal-`seq` keys pass through unchanged. focus:false keeps the
  // soft keyboard down on touch — these buttons exist to replace it, not trigger it.
  const sendNavKey = useCallback((key) => {
    if (key.seq != null) { emitShellInput(key.seq, { focus: false }); return; }
    const appCursor = termInstanceRef.current?.modes?.applicationCursorKeysMode;
    emitShellInput(`\x1b${appCursor ? 'O' : '['}${key.code}`, { focus: false });
  }, [emitShellInput]);

  // Initialize terminal once
  useEffect(() => {
    if (!terminalRef.current || termInstanceRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 14,
      fontFamily: '"Roboto Mono for Powerline", "MesloLGS NF", "MesloLGS Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "JetBrainsMono Nerd Font", Menlo, Monaco, "Courier New", monospace',
      theme: readTerminalTheme(),
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

  // Re-skin the live terminal when the user switches themes. The terminal is
  // created once (above), so without this the xterm palette would stay frozen at
  // whatever theme was active on mount — most visibly, a dark terminal stranded in
  // a daytime theme. Depends on themeId (catches sibling day↔day / night↔night
  // swaps that change accent/bg) and themeMode (catches the day/night palette flip).
  useEffect(() => {
    if (termInstanceRef.current) {
      termInstanceRef.current.options.theme = readTerminalTheme();
    }
  }, [themeId, themeMode]);

  // Refit the terminal to its container and tell the PTY about the new size.
  const refitTerminal = useCallback(() => {
    if (!fitAddonRef.current || !termInstanceRef.current) return;
    fitAddonRef.current.fit();
    if (socket && sessionIdRef.current) {
      socket.emit('shell:resize', {
        sessionId: sessionIdRef.current,
        cols: termInstanceRef.current.cols,
        rows: termInstanceRef.current.rows
      });
    }
  }, [socket]);

  // Handle window resize
  useEffect(() => {
    window.addEventListener('resize', refitTerminal);
    return () => window.removeEventListener('resize', refitTerminal);
  }, [refitTerminal]);

  // Entering/leaving fullscreen swaps the terminal between the in-flow flex box and
  // the fixed overlay — a big size change. The ResizeObserver below catches it too,
  // but refit on the next frame so the new cols/rows reach the PTY immediately
  // instead of waiting for the observer to settle.
  useEffect(() => {
    const frame = requestAnimationFrame(() => refitTerminal());
    return () => cancelAnimationFrame(frame);
  }, [isFullscreen, refitTerminal]);

  // Refit whenever the terminal *container* changes size — not just the window.
  // The toolbars (session tabs, live-run banner, quick-commands bar) mount
  // conditionally on `connected`, which shrinks the flex-1 terminal box after the
  // one-shot mount fit() has already run. Without re-fitting, xterm keeps its
  // taller row count and overflows below the fold, hiding the prompt and breaking
  // scrollback. A ResizeObserver catches every such reflow (the user's "resize the
  // window and it appears" glitch). rAF-guarded so fit()'s own DOM mutation can't
  // re-enter the observer in a tight loop.
  useEffect(() => {
    const el = terminalRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame = null;
    const observer = new ResizeObserver(() => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        refitTerminal();
      });
    });
    observer.observe(el);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [refitTerminal]);

  // Handle terminal input
  useEffect(() => {
    if (!termInstanceRef.current || !socket) return;

    const disposable = termInstanceRef.current.onData((data) => {
      // Drop keystrokes during a pending start/attach so they don't land in the previous
      // session — the terminal has already been cleared and "Attaching…" is showing.
      if (sessionIdRef.current && !pendingAttachRef.current.target) {
        socket.emit('shell:input', { sessionId: sessionIdRef.current, data });
      }
    });

    return () => disposable.dispose();
  }, [socket]);

  const clearActiveSession = useCallback(() => {
    sessionIdRef.current = null;
    setActiveSessionId(null);
    setConnected(false);
    // Don't touch pendingAttachRef here — clearing the displayed session is a separate
    // concern from cancelling an in-flight user request. handleShellExit / Detached /
    // external-kill reconciliation all call this, but the user may have a switch in
    // flight to a different session that we want to land successfully. Explicit user
    // cancellation paths (Stop button, X on active tab) call cancelPendingAttach
    // themselves.
  }, []);

  const activateSession = useCallback((sessionId) => {
    sessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setConnected(true);
    if (urlSessionIdRef.current !== sessionId) {
      const intent = pendingNavIntentRef.current;
      pendingNavIntentRef.current = 'replace';
      navigateRef.current(`/shell/${sessionId}`, { replace: intent === 'replace' });
    }
  }, []);

  // intent: 'push' arms the next activateSession to push a history entry. Only set AFTER the
  // socket-connected guard so a disconnected call doesn't leak the intent into a later auto-activation.
  const startSession = useCallback(({ intent } = {}) => {
    if (!socket?.connected) return;
    if (intent === 'push') pendingNavIntentRef.current = 'push';
    setPendingAttach('new');
    userIdleRef.current = false;
    if (termInstanceRef.current) {
      // reset() not clear(): the xterm instance is reused across every session,
      // and a full-screen TUI (a watched agent-tui claude/codex run) leaves DEC
      // private modes ON — mouse-motion tracking, focus reporting, bracketed
      // paste, alt-screen. clear() only wipes the viewport, so those modes would
      // persist into this fresh shell and make xterm inject escape-sequence
      // reports (mouse/focus events) as INPUT, echoing as accumulating garbage
      // at the prompt. reset() restores the terminal to a clean initial state.
      termInstanceRef.current.reset();
      termInstanceRef.current.writeln('\x1b[36mStarting shell session...\x1b[0m');
    }
    const opts = initialOptsRef.current || {};
    const startOpts = {};
    if (opts.cwd) startOpts.cwd = opts.cwd;
    if (opts.cmd) startOpts.initialCommand = opts.cmd;
    initialOptsRef.current = {};
    socket.emit('shell:start', Object.keys(startOpts).length > 0 ? startOpts : undefined);
  }, [socket, setPendingAttach]);

  const attachToSession = useCallback((sessionId, { intent, claim = false } = {}) => {
    if (!socket?.connected) return;
    if (intent === 'push') pendingNavIntentRef.current = 'push';
    setPendingAttach(sessionId);
    userIdleRef.current = false;
    if (termInstanceRef.current) {
      // reset() not clear() — drop any DEC private modes (mouse/focus tracking,
      // alt-screen) the previously-viewed session left active so they can't
      // bleed into this one as injected escape-sequence input. See startSession.
      termInstanceRef.current.reset();
      termInstanceRef.current.writeln('\x1b[36mAttaching to session...\x1b[0m');
    }
    // claim:true → server refuses to displace a different socket. Used by auto-pick
    // paths so multi-tab broadcast races don't cause one tab's auto-adopt to boot
    // another tab via shell:detached. User intent paths default to claim:false.
    socket.emit('shell:attach', claim ? { sessionId, claim: true } : { sessionId });
  }, [socket, setPendingAttach]);

  const stopSession = useCallback(() => {
    if (socket && sessionIdRef.current) {
      socket.emit('shell:stop', { sessionId: sessionIdRef.current });
      clearActiveSession();
      cancelPendingAttach();
      // Disarm the nav intent — if the cancelled request was a user-initiated tab
      // click that had set 'push', a later automatic activation must not push a
      // history entry the user no longer wanted.
      pendingNavIntentRef.current = 'replace';
      userIdleRef.current = true;
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln('\r\n\x1b[33m[Session killed]\x1b[0m');
      }
      navigateRef.current('/shell', { replace: true });
    }
  }, [socket, clearActiveSession, cancelPendingAttach]);

  const killOtherSession = useCallback((sessionId) => {
    if (!socket) return;
    socket.emit('shell:stop', { sessionId });
    if (sessionId === sessionIdRef.current) {
      clearActiveSession();
      cancelPendingAttach();
      pendingNavIntentRef.current = 'replace';
      userIdleRef.current = true;
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln('\r\n\x1b[33m[Session killed]\x1b[0m');
      }
      navigateRef.current('/shell', { replace: true });
    }
  }, [socket, clearActiveSession, cancelPendingAttach]);

  // Restart = kill the current session, then start a fresh one after a short delay
  // (gives the server time to tear down the old PTY). The deferred startSession must
  // respect both staleness and unmount: stopSession() bumps the pending generation,
  // so capture it and abort the delayed start if the user switched sessions (which
  // bumps the generation again) or navigated away within the 1s window. Without the
  // generation guard, a tab click inside the window would fire startSession() and
  // clobber the in-flight switch.
  const restartSession = useCallback(() => {
    stopSession();
    const gen = pendingAttachRef.current.generation;
    setTimeout(() => {
      if (!mountedRef.current) return;
      if (pendingAttachRef.current.generation !== gen) return;
      startSession();
    }, 1000);
  }, [stopSession, startSession]);

  const switchToSession = useCallback((sessionId, { fromUrl = false } = {}) => {
    // Compare against the in-flight attach target if there is one, falling back to the
    // currently-displayed session. Without this, a back→forward race (B→A while attach
    // to A is pending, then forward back to B) would short-circuit on `sessionId ===
    // sessionIdRef.current` and leave the pending attach to overwrite the user's forward.
    const pendingTarget = pendingAttachRef.current.target;
    const currentTarget = (pendingTarget && pendingTarget !== 'new') ? pendingTarget : sessionIdRef.current;
    if (sessionId === currentTarget) return;
    // Don't pre-clear — keep the previously displayed session in sessionIdRef until
    // shell:attached lands (handleShellAttached → activateSession swaps atomically).
    // If shell:error fires instead, handleShellError can restore URL/terminal to the
    // session we were already showing rather than leaving the UI stranded on a dead URL.
    attachToSession(sessionId, { intent: fromUrl ? undefined : 'push' });
  }, [attachToSession]);

  // User clicked "New" button — push intent so back/forward can return to the prior session.
  const startNewSession = useCallback(() => {
    startSession({ intent: 'push' });
  }, [startSession]);

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
      clearActiveSession();
    };

    const handleSessions = (sessionList) => {
      sessionsRef.current = sessionList;
      setSessions(sessionList);
      // Auto-pick helper: skip sessions already attached to another socket so we don't
      // steal them via the shell:detached takeover. Also skip external TUI runs —
      // those are opt-in views the user clicks into, never the default landing
      // session. Manual tab clicks bypass this.
      const pickUnattachedSurvivor = (list) => {
        const free = list.filter(s => !s.attached && !s.external);
        return free.length > 0 ? free[free.length - 1] : null;
      };
      // On first load, auto-attach to existing session or create new
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        const opts = initialOptsRef.current || {};
        const urlSid = urlSessionIdRef.current;
        // If we have initial opts (cwd/cmd), always create a new session
        if (opts.session && sessionList.some(s => s.sessionId === opts.session)) {
          attachToSession(opts.session);
          initialOptsRef.current = {};
        } else if (opts.cwd || opts.cmd) {
          startSession();
        } else if (urlSid && sessionList.some(s => s.sessionId === urlSid)) {
          // URL points at a live session — attach to that one (deep-link intent
          // overrides the "don't steal" guard; the prior tab gets shell:detached).
          attachToSession(urlSid);
        } else if (sessionList.length > 0 && !sessionIdRef.current && !userIdleRef.current) {
          // Attach to most recent existing session that isn't already driving another tab.
          // Skipped when the user is intentionally idle — handleConnect resets
          // hasInitializedRef so this branch runs on every reconnect, and a transient
          // disconnect shouldn't re-adopt a session the user explicitly stopped.
          const survivor = pickUnattachedSurvivor(sessionList);
          if (survivor) {
            attachToSession(survivor.sessionId, { claim: true });
          } else if (sessionList.filter(s => !s.external).length < MAX_SESSIONS) {
            // Every live session is attached elsewhere but we have capacity. The user
            // landed here (probably via a now-dead deep link) intending to get a
            // shell — start a fresh one rather than leaving them at bare /shell.
            // Capacity counts only interactive shells: external TUI runs are exempt
            // from the cap server-side, so they must not block a new shell here.
            startSession();
          } else {
            // At session cap with all attached elsewhere — nothing safe to do here.
            navigateRef.current('/shell', { replace: true });
          }
        } else if (sessionList.length === 0 && !userIdleRef.current) {
          // Auto-start on empty list — skipped when the user is intentionally idle so
          // a transient reconnect (which resets hasInitializedRef and re-enters this
          // branch) doesn't spawn a new session over an explicit Stop.
          startSession();
        }
        return;
      }
      // Post-init: the session we're displaying may have been killed externally (another tab,
      // direct server kill). Server sends a fresh sessions list without a shell:exit to this
      // socket if it wasn't the attached one. Reconcile by auto-attaching to a survivor that
      // isn't already attached elsewhere (otherwise we'd boot the other tab via shell:detached).
      const displayed = sessionIdRef.current;
      if (displayed && !sessionList.some(s => s.sessionId === displayed)) {
        clearActiveSession();
        if (termInstanceRef.current) {
          termInstanceRef.current.writeln('\r\n\x1b[33m[Session removed externally]\x1b[0m');
        }
        // Let any user-initiated pending attach complete instead of overriding it.
        if (pendingAttachRef.current.target) return;
        const survivor = pickUnattachedSurvivor(sessionList);
        if (survivor) {
          attachToSession(survivor.sessionId, { claim: true });
        } else {
          navigateRef.current('/shell', { replace: true });
        }
        return;
      }
      // Tab is sitting on bare /shell with no displayed session (e.g. arrived when
      // every live session was already attached elsewhere). If another tab later
      // disconnects and frees one of those sessions, adopt it so the user doesn't have
      // to manually click to recover. Gated on (1) no in-flight start/attach so we
      // don't race a user-initiated request, and (2) `!userIdleRef.current` so we
      // don't undo an explicit Stop/kill-active: the user just chose to be at /shell.
      if (!displayed && !pendingAttachRef.current.target && !userIdleRef.current) {
        const survivor = pickUnattachedSurvivor(sessionList);
        if (survivor) attachToSession(survivor.sessionId, { claim: true });
      }
    };

    const handleShellStarted = ({ sessionId: sid }) => {
      // Only consume the response when we're still waiting on a start. If the user
      // initiated an attach after the start emit, pendingAttachRef now holds that
      // attach target — this stale start response must not steal the activation
      // away from the in-flight attach. (The just-spawned session stays alive
      // server-side; it'll show up in the next shell:sessions broadcast and the
      // user can switch to it manually.)
      if (pendingAttachRef.current.target !== 'new') return;
      cancelPendingAttach();
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
      // Strict equality: only consume the response if it matches the current pending
      // target exactly. A null target (no pending OR user-cancelled mid-flight) and
      // a stale target (user moved on to a different attach) both fall through here.
      // This is the only guard between a cancelled-during-pending response and an
      // erroneous activation that would navigate back to a session the user just left.
      if (pendingAttachRef.current.target !== sid) return;
      cancelPendingAttach();
      activateSession(sid);
      if (termInstanceRef.current) {
        // reset() not clear(): wipe modes/parser state from the prior session
        // before repainting this one's buffer, so a previously-viewed full-screen
        // TUI's lingering mouse/focus tracking can't inject garbage here. The
        // freshly-painted bufferedOutput re-establishes whatever modes THIS
        // session legitimately uses. See startSession for the full rationale.
        termInstanceRef.current.reset();
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
      // Suppress old-session output during a pending switch — the terminal has been
      // cleared and is waiting for the new session's buffer; bleeding old output here
      // produces confusing partial paint.
      if (pendingAttachRef.current.target) return;
      if (sid === sessionIdRef.current && termInstanceRef.current) {
        termInstanceRef.current.write(data);
      }
    };

    const handleShellExit = ({ sessionId: sid, code }) => {
      if (sid === sessionIdRef.current) {
        clearActiveSession();
        if (termInstanceRef.current) {
          termInstanceRef.current.writeln(`\r\n\x1b[33m[Shell exited with code ${code}]\x1b[0m`);
        }
        // If the user has an in-flight start/attach to a different session, let it
        // complete instead of overriding it with our fallback. The handleShellAttached
        // response will install the new session and the user's intent wins.
        if (pendingAttachRef.current.target) return;
        // Auto-attach to a survivor not already driving another tab (don't steal,
        // and don't auto-adopt a TUI-run view).
        const free = sessionsRef.current.filter(s => s.sessionId !== sid && !s.attached && !s.external);
        if (free.length > 0) {
          // Claim pending immediately so the shell:sessions broadcast that follows
          // shell:exit doesn't race the timeout — the bare-/shell adoption branch
          // sees pendingAttachRef set and skips. Capture generation so a user action
          // during the 100ms window aborts our delayed attach. claim:true protects
          // against multi-tab adopt races.
          const target = free[free.length - 1].sessionId;
          setPendingAttach(target);
          const gen = pendingAttachRef.current.generation;
          setTimeout(() => {
            if (!mountedRef.current) return;
            if (pendingAttachRef.current.generation !== gen) return;
            attachToSession(target, { claim: true });
          }, 100);
        } else {
          navigateRef.current('/shell', { replace: true });
        }
      }
    };

    const handleShellDetached = ({ sessionId: sid, reason }) => {
      // Server notified us this session was taken over by another socket
      // (typically the same user opening the deep link in another tab). The PTY
      // stream now goes there; locally we drop the dead view rather than appear
      // "Connected" forever with no output.
      if (sid !== sessionIdRef.current) return;
      clearActiveSession();
      if (termInstanceRef.current) {
        const note = reason === 'attached-elsewhere'
          ? 'Session attached in another tab — disconnected here'
          : 'Session detached';
        termInstanceRef.current.writeln(`\r\n\x1b[33m[${note}]\x1b[0m`);
      }
      // If the user already has an attach in flight to a different session, don't
      // navigate to bare /shell — let the pending request complete (its
      // handleShellAttached will navigate appropriately).
      if (pendingAttachRef.current.target) return;
      navigateRef.current('/shell', { replace: true });
    };

    const handleShellError = ({ error, sessionId: errSid }) => {
      // Correlate this error to our current pending request before deciding whether
      // to display it. Four cases:
      //   1) start failure: server-side errSid omitted, our pending is 'new'. Show + recover.
      //   2) attach failure (server-correlated): errSid present and matches pending. Show + recover.
      //   3) legacy attach failure (older server emit without errSid): pending is a
      //      session id (not 'new', not null). Tolerated for back-compat. Show + recover.
      //   4) passive error on the currently displayed session (e.g. shell:input to a
      //      session that died): errSid matches sessionIdRef. Show, but don't mutate
      //      pending state — the user's switch (if any) is unrelated.
      // Everything else — stale errors from requests the user has moved past, or
      // expected claim:true race rejections from auto-pick — drop silently to avoid
      // flashing red noise in the terminal for requests the UI no longer cares about.
      const pending = pendingAttachRef.current.target;
      const isStartFailure = !errSid && pending === 'new';
      const isAttachFailure = pending && pending !== 'new' && (!errSid || errSid === pending);
      const isPassiveOnActive = errSid && !isAttachFailure && errSid === sessionIdRef.current;
      if (!isStartFailure && !isAttachFailure && !isPassiveOnActive) return;

      if (termInstanceRef.current) {
        termInstanceRef.current.writeln(`\r\n\x1b[31m[Error: ${error}]\x1b[0m`);
      }
      if (isPassiveOnActive && !isStartFailure && !isAttachFailure) {
        // Passive error displayed; do not touch pending state.
        return;
      }

      // This error corresponds to our current request — reset pending state and run recovery.
      pendingNavIntentRef.current = 'replace';
      const failedTarget = isAttachFailure ? pending : null;
      cancelPendingAttach();

      const live = sessionsRef.current;
      const active = sessionIdRef.current;
      if (!active) {
        // No previously-displayed session to restore (e.g. initial deep-link attach
        // failed before any session was active). Fall back to a free survivor so the
        // user isn't stranded on /shell/<dead-id> with only the error message visible.
        const free = live.filter(s => !s.attached && s.sessionId !== failedTarget && !s.external);
        if (free.length > 0) {
          attachToSession(free[free.length - 1].sessionId, { claim: true });
        } else if (urlSessionIdRef.current) {
          navigateRef.current('/shell', { replace: true });
        }
        return;
      }
      if (!live.some(s => s.sessionId === active)) {
        // The session we were displaying is also gone. Fall back to a survivor that
        // isn't already attached elsewhere; claim:true protects against multi-tab
        // adopt races. activateSession will update the URL on success.
        clearActiveSession();
        const free = live.filter(s => !s.attached && s.sessionId !== failedTarget && !s.external);
        if (free.length > 0) {
          attachToSession(free[free.length - 1].sessionId, { claim: true });
        } else {
          navigateRef.current('/shell', { replace: true });
        }
        return;
      }
      // Active session is still alive. Distinguish a switch failure (re-attach so the
      // terminal that attachToSession just cleared gets repainted) from a start
      // failure with an existing session (leave the terminal as-is so the error
      // message stays readable). Two switch-failure paths:
      //   • Tab-click switch: failedTarget is a session id != active. URL didn't move
      //     because activateSession never fired.
      //   • URL-nav switch: urlSessionIdRef diverged from active.
      const switchAttempt = failedTarget && failedTarget !== active;
      const urlDiverged = urlSessionIdRef.current && urlSessionIdRef.current !== active;
      if (switchAttempt || urlDiverged) {
        if (urlDiverged) {
          navigateRef.current(`/shell/${active}`, { replace: true });
        }
        // Capture generation so a user action during the 100ms window aborts our
        // deferred recovery attach.
        setPendingAttach(active);
        const gen = pendingAttachRef.current.generation;
        setTimeout(() => {
          if (!mountedRef.current) return;
          if (pendingAttachRef.current.generation !== gen) return;
          // The setPendingAttach we just did is consumed here — clear and emit.
          cancelPendingAttach();
          attachToSession(active);
        }, 100);
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('shell:sessions', handleSessions);
    socket.on('shell:started', handleShellStarted);
    socket.on('shell:attached', handleShellAttached);
    socket.on('shell:output', handleShellOutput);
    socket.on('shell:exit', handleShellExit);
    socket.on('shell:detached', handleShellDetached);
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
      socket.off('shell:detached', handleShellDetached);
      socket.off('shell:error', handleShellError);
      // Leaving the Shell page: tell the server we've stopped viewing so any
      // watched TUI run resumes normal idle completion instead of staying
      // paused for a page we've left (the singleton socket stays connected
      // across navigations, so `disconnect` won't fire). This effect only
      // re-binds on socket identity change, so this runs on real unmount.
      if (socket.connected) socket.emit('shell:release-views');
      // Don't kill session on unmount — it persists server-side
      sessionIdRef.current = null;
    };
  }, [socket, startSession, attachToSession, activateSession, clearActiveSession, cancelPendingAttach, setPendingAttach]);

  // React to URL changes after init (browser back/forward, manual URL paste, sidebar click).
  // fromUrl: true keeps the next activateSession in 'replace' mode — the browser already
  // owns this history entry, so we don't want to double-push.
  useEffect(() => {
    if (!hasInitializedRef.current) return;
    // URL points at a known live session — switch the display if it isn't already there.
    if (urlSessionId && sessionsRef.current.some(s => s.sessionId === urlSessionId)) {
      switchToSession(urlSessionId, { fromUrl: true });
      return;
    }
    // URL points at bare /shell or a dead/unknown session.
    if (sessionIdRef.current) {
      // Have an active session — mirror its id back into the URL so reload restores it.
      navigateRef.current(`/shell/${sessionIdRef.current}`, { replace: true });
      return;
    }
    // No active session, no live target for the URL. Clear the stale id from the
    // address bar — but only when there's nothing in flight (a pending attach will
    // navigate via activateSession on success) and the user isn't intentionally idle
    // (then bare /shell is what they want). handleSessions handles survivor adoption
    // and the deep-link new-session fallback when initial-load runs.
    if (urlSessionId && !pendingAttachRef.current.target && !userIdleRef.current) {
      navigateRef.current('/shell', { replace: true });
    }
  }, [urlSessionId, switchToSession]);

  // External TUI runs (editorial review, pipeline stages, etc.) are surfaced as
  // opt-in, fully-interactive tabs — you can watch and step in. They're labelled
  // distinctly and don't count toward the shell cap.
  const interactiveCount = sessions.filter(s => !s.external).length;
  const liveRunCount = sessions.filter(s => s.external).length;
  const activeSession = sessions.find(s => s.sessionId === activeSessionId);
  const isLiveRun = !!activeSession?.external;

  return {
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
  };
}
