import { useEffect, useRef, useState, useCallback } from 'react';
import useMounted from './useMounted';
import { useSearchParams, useParams, useNavigate } from 'react-router';
import { Terminal } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSocket } from './useSocket';
import { useThemeContext } from '../components/ThemeContext';
import { buildTerminalTheme, parseCssColorToHex } from '../lib/terminalTheme';
import { attachDictationBridge } from '../lib/terminalDictation';
import { fitTerminal } from '../lib/terminalFit';
import {
  attachTerminalTouchScroll,
  attachTerminalWheelScroll,
  resetTerminalWheelScroll,
  scrollTerminalPage,
} from '../lib/terminalScroll';
import { readFileAsBase64 } from '../utils/fileUpload';
import * as api from '../services/api';
import toast from '../components/ui/Toast';

// Must match MAX_TOTAL_SESSIONS in server/services/shell.js
export const MAX_SESSIONS = 20;

// recoverToSurvivor's no-op fallback, for the one caller already sitting at bare
// /shell and content to stay there when nothing is free to adopt.
const STAY_PUT = () => {};

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
 *   • recoverToSurvivor(excludeId, onNothing) — the ONE recovery path. Every way the
 *     displayed session can go away (it exited, another tab took it over, it was
 *     killed externally, an attach failed, the user closed it) ends here, so a policy
 *     change lands once instead of in five near-copies. Callers vary only in what to
 *     do when nothing is free, which is the single knob.
 *
 *   • suppressAutoStartRef — set when a user close leaves nothing to hand over, and
 *     cleared by every user-initiated start/attach. It suppresses only the paths that
 *     SPAWN a session: without it, stopping your last shell would immediately respawn
 *     one and make Stop a no-op. It deliberately does NOT suppress adopting an already
 *     live free session — being handed a working shell is never the thing we're
 *     suppressing, and sitting on "Disconnected" while one is free is precisely the
 *     broken state these recovery paths exist to prevent.
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
  const mountedRef = useMounted();
  // useCallback for stable identity so consumers can list these in dep arrays without
  // causing useEffect re-binds on every render. They only touch a ref, so empty deps is correct.
  const setPendingAttach = useCallback((target) => {
    pendingAttachRef.current = { target, generation: pendingAttachRef.current.generation + 1 };
  }, []);
  const cancelPendingAttach = useCallback(() => setPendingAttach(null), [setPendingAttach]);
  // Suppresses the session-SPAWNING branches only — see the module doc comment above
  // for why adoption of an already-live free session is deliberately left enabled.
  const suppressAutoStartRef = useRef(false);
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
    // `provider` is the AI Providers page's "Launch in Shell" hand-off. It sends
    // an ID rather than a command line because the server has to pair the
    // command with the provider's own env (its backend/auth live in secret
    // `envVars` the client never sees) — see socket.js's shell:start handler.
    const provider = searchParams.get('provider');
    if (cwd || cmd || session || provider) {
      initialOptsRef.current = { cwd, cmd, session, provider };
      setSearchParams({}, { replace: true });
    } else {
      initialOptsRef.current = {};
    }
  }, []);

  // The one place a shell:* event addressed at the ACTIVE session goes out, so the
  // mid-attach guard can't be applied to one sender and forgotten on the next.
  // focus:false skips returning keyboard focus to the terminal after sending — used by
  // the nav-key hot buttons so repeated arrow taps on touch devices don't keep re-summoning
  // the on-screen keyboard (input is delivered over the socket regardless of focus).
  // Returns whether the payload actually went out — the dictation bridge needs to know,
  // since it tracks what the PTY has received to compute its next correction.
  const emitToSession = useCallback((event, payload, { focus = true } = {}) => {
    if (!socket || !sessionIdRef.current) return false;
    // Don't fire quick-commands into the prior session while a switch/start is mid-flight.
    if (pendingAttachRef.current.target) return false;
    socket.emit(event, { sessionId: sessionIdRef.current, ...payload });
    if (focus) termInstanceRef.current?.focus();
    return true;
  }, [socket]);

  const emitShellInput = useCallback(
    (data, opts) => emitToSession('shell:input', { data }, opts),
    [emitToSession]
  );

  // Send a photo (plus an optional message) to whatever is running in the active
  // session — the point being a live `claude`/`codex` TUI, which reads images off
  // disk. This one goes over HTTP, not the `shell:*` socket protocol: socket.io's
  // 1MB frame limit can't carry a photo, and it's a one-shot request that needs a
  // result. The server saves the bytes and bracket-pastes `<message>\n<path>` into
  // the PTY; the path never comes back, so nothing here can leak the install layout.
  //
  // Resolves true only on success, so the caller can keep its composer open (with
  // the user's message intact) to retry. Errors are toasted here — the guard
  // refusals have no other error surface, so this owns all of them and the API call
  // is `silent`.
  const sendImage = useCallback(async (file, message = '') => {
    if (!sessionIdRef.current) {
      toast.error('No active shell session');
      return false;
    }
    // Same guard as emitShellInput: a mid-switch send would land in the session
    // the user is leaving.
    if (pendingAttachRef.current.target) {
      toast.error('Session is still attaching — try again in a moment');
      return false;
    }
    // Capture the target BEFORE the read: a big photo takes a moment to encode, and
    // the send belongs to the session the user was looking at when they hit Send —
    // not to whichever one happens to be active by the time the bytes are ready.
    const sessionId = sessionIdRef.current;
    const data = await readFileAsBase64(file).catch(() => null);
    if (!data) {
      toast.error(`Failed to read ${file.name}`);
      return false;
    }
    const sent = await api.sendShellImage(sessionId, { data, filename: file.name, message }, { silent: true })
      .catch((err) => {
        toast.error(`Failed to send image: ${err.message}`);
        return null;
      });
    if (!sent) return false;
    toast.success('Image sent to session');
    return true;
  }, []);

  // CR, not LF — see SUBMIT_KEY in server/lib/tuiHandshake.js for why. Same byte as
  // TerminalHotKeys' Enter key.
  const sendCommand = useCallback((cmd) => emitShellInput(cmd + '\r'), [emitShellInput]);
  // cd is the one "command" the client does NOT compose itself: it sends the folder and
  // the server renders the `cd` for the session's actual shell (server/lib/shellCd.js).
  const sendCd = useCallback((path) => emitToSession('shell:cd', { path }), [emitToSession]);
  const sendCtrlB = useCallback(() => emitShellInput('\x02'), [emitShellInput]);
  const sendCtrlC = useCallback(() => emitShellInput('\x03'), [emitShellInput]);
  // Arrow keys send CSI or SS3 based on the terminal's DECCKM state (see NAV_KEYS);
  // Enter and any other literal-`seq` keys pass through unchanged. focus:false keeps the
  // soft keyboard down on touch — these buttons exist to replace it, not trigger it.
  const sendNavKey = useCallback((key) => {
    if (key.seq != null) { emitShellInput(key.seq, { focus: false }); return; }
    const appCursor = termInstanceRef.current?.modes?.applicationCursorKeysMode;
    emitShellInput(`\x1b${appCursor ? 'O' : '['}${key.code}`, { focus: false });
  }, [emitShellInput]);

  // Scroll the VIEW by one screenful — distinct from the arrow keys above, which
  // drive whatever the TUI does with a cursor key. `direction` is -1 for up, 1 for
  // down; lib/terminalScroll.js owns why this can't just be term.scrollPages().
  const scrollPage = useCallback((direction) => {
    scrollTerminalPage(termInstanceRef.current, direction);
  }, []);

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

    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);

    // xterm binds no touch handlers of its own, so without this a swipe over the
    // terminal does nothing. Alternate-screen TUIs need the matching wheel capture so
    // OpenCode's supported PageUp/PageDown bindings receive scroll gestures instead
    // of unsupported mouse reports. See lib/terminalScroll.js. Attached here rather
    // than in its own effect: neither handler has reactive deps, so both lifetimes are
    // exactly the terminal instance's (unlike the dictation bridge, which needs
    // emitShellInput).
    const detachTouchScroll = attachTerminalTouchScroll(term);
    const detachWheelScroll = attachTerminalWheelScroll(term);

    requestAnimationFrame(() => {
      fitTerminal(term);
    });

    termInstanceRef.current = term;

    return () => {
      detachTouchScroll();
      detachWheelScroll();
      term.dispose();
      termInstanceRef.current = null;
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
    const term = termInstanceRef.current;
    if (!term) return;
    fitTerminal(term);
    if (socket && sessionIdRef.current) {
      socket.emit('shell:resize', {
        sessionId: sessionIdRef.current,
        cols: term.cols,
        rows: term.rows
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

  // Handle terminal input. emitShellInput already owns the "don't land keystrokes in
  // the session we're leaving" guard (the terminal has been cleared and "Attaching…"
  // is showing), so both input paths go through it rather than re-deriving it.
  // focus:false — typing is already focused, and the bridge must not steal focus.
  useEffect(() => {
    if (!termInstanceRef.current) return;
    const send = (data) => emitShellInput(data, { focus: false });

    const disposable = termInstanceRef.current.onData(send);

    // Voice dictation (iOS mic key, macOS Fn Fn) streams progressively refined
    // guesses and rewrites what it already typed. xterm forwards each insertion
    // and ignores the matching deletions, so the PTY accumulates the garble
    // ("determin" + "determine" + "determines"…). The bridge intercepts the
    // hidden textarea and forwards a diff (DELs + additions) instead. It sends
    // straight to `send` rather than looping back through `terminal.input()`:
    // onData's only consumer IS this emit, and the round trip would throw away
    // the delivered/dropped signal the bridge needs to track the PTY.
    const detachDictation = attachDictationBridge(termInstanceRef.current, send);

    // Detach the DOM listeners first — at unmount the terminal-init effect's
    // cleanup has already disposed the terminal, so nothing here should depend
    // on xterm's disposable running successfully.
    return () => {
      detachDictation();
      disposable.dispose();
    };
  }, [emitShellInput]);

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

  // The single auto-pick rule: the newest session that is neither already attached to
  // another socket — adopting one would boot that tab via shell:detached — nor an
  // external TUI run, which is an opt-in view the user clicks into rather than a
  // default landing session. `excludeId` drops the session that just died, which is
  // often still listed in the snapshot we're reconciling against. The displayed
  // session is excluded unconditionally: `attached` is recipient-relative (the server
  // reports the session bound to THIS socket as unattached), so without it a caller
  // that picks before clearing the view would re-attach the tab to itself.
  const pickFreeSurvivor = useCallback((excludeId = null) => {
    const survivor = sessionsRef.current.findLast(s => (
      !s.attached && !s.external && s.sessionId !== excludeId && s.sessionId !== sessionIdRef.current
    ));
    return survivor?.sessionId ?? null;
  }, []);

  const goToShellRoot = useCallback(() => {
    navigateRef.current('/shell', { replace: true });
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
  //
  // `launch` ({ cwd?, cmd?, provider? }) is the in-page caller's version of what
  // initialOptsRef carries for a `?cwd=/?cmd=/?provider=` deep link. Passing it
  // as an argument rather than parking it in the ref is what keeps a start that
  // never fires from arming the NEXT one with someone else's provider.
  const startSession = useCallback(({ intent, launch } = {}) => {
    if (!socket?.connected) return;
    if (intent === 'push') pendingNavIntentRef.current = 'push';
    setPendingAttach('new');
    suppressAutoStartRef.current = false;
    if (termInstanceRef.current) {
      // reset() not clear(): the xterm instance is reused across every session,
      // and a full-screen TUI (a watched agent-tui claude/codex run) leaves DEC
      // private modes ON — mouse-motion tracking, focus reporting, bracketed
      // paste, alt-screen. clear() only wipes the viewport, so those modes would
      // persist into this fresh shell and make xterm inject escape-sequence
      // reports (mouse/focus events) as INPUT, echoing as accumulating garbage
      // at the prompt. reset() restores the terminal to a clean initial state.
      resetTerminalWheelScroll(termInstanceRef.current);
      termInstanceRef.current.reset();
      termInstanceRef.current.writeln('\x1b[36mStarting shell session...\x1b[0m');
    }
    const opts = launch || initialOptsRef.current || {};
    const startOpts = {};
    if (opts.cwd) startOpts.cwd = opts.cwd;
    if (opts.cmd) startOpts.initialCommand = opts.cmd;
    if (opts.provider) startOpts.providerId = opts.provider;
    initialOptsRef.current = {};
    socket.emit('shell:start', Object.keys(startOpts).length > 0 ? startOpts : undefined);
  }, [socket, setPendingAttach]);

  const attachToSession = useCallback((sessionId, { intent, claim = false } = {}) => {
    if (!socket?.connected) return;
    if (intent === 'push') pendingNavIntentRef.current = 'push';
    setPendingAttach(sessionId);
    suppressAutoStartRef.current = false;
    if (termInstanceRef.current) {
      // reset() not clear() — drop any DEC private modes (mouse/focus tracking,
      // alt-screen) the previously-viewed session left active so they can't
      // bleed into this one as injected escape-sequence input. See startSession.
      resetTerminalWheelScroll(termInstanceRef.current);
      termInstanceRef.current.reset();
      termInstanceRef.current.writeln('\x1b[36mAttaching to session...\x1b[0m');
    }
    // claim:true → server refuses to displace a different socket. Used by auto-pick
    // paths so multi-tab broadcast races don't cause one tab's auto-adopt to boot
    // another tab via shell:detached. User intent paths default to claim:false.
    socket.emit('shell:attach', claim ? { sessionId, claim: true } : { sessionId });
  }, [socket, setPendingAttach]);

  // The one recovery path — see the module doc comment. Hands the user the next free
  // shell, or runs `onNothing` (default: fall back to bare /shell) when there is none.
  const recoverToSurvivor = useCallback((excludeId = null, onNothing = goToShellRoot) => {
    const survivor = pickFreeSurvivor(excludeId);
    if (!survivor) {
      onNothing();
      return;
    }
    // claim:true — an auto-pick must never boot another tab off a session it is
    // already driving, however the broadcast race falls out.
    attachToSession(survivor, { claim: true });
  }, [pickFreeSurvivor, attachToSession, goToShellRoot]);

  // The session the user is looking at just went away by their own action (Stop
  // button, or X on the active tab). Reading "Disconnected" at bare /shell while other
  // live sessions sit one click away in the tab strip is the broken state this avoids.
  const closeActiveSession = useCallback(() => {
    const closedId = sessionIdRef.current;
    clearActiveSession();
    cancelPendingAttach();
    // Disarm the nav intent — if the cancelled request was a user-initiated tab
    // click that had set 'push', a later automatic activation must not push a
    // history entry the user no longer wanted.
    pendingNavIntentRef.current = 'replace';
    recoverToSurvivor(closedId, () => {
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln('\r\n\x1b[33m[Session killed]\x1b[0m');
      }
      // Nothing to hand over, so don't spawn a replacement either — that would make
      // Stop a no-op. Adoption stays armed, so a session freed later still lands.
      suppressAutoStartRef.current = true;
      goToShellRoot();
    });
  }, [clearActiveSession, cancelPendingAttach, recoverToSurvivor, goToShellRoot]);

  const stopSession = useCallback(() => {
    if (!socket || !sessionIdRef.current) return;
    socket.emit('shell:stop', { sessionId: sessionIdRef.current });
    closeActiveSession();
  }, [socket, closeActiveSession]);

  const killOtherSession = useCallback((sessionId) => {
    if (!socket) return;
    socket.emit('shell:stop', { sessionId });
    if (sessionId === sessionIdRef.current) closeActiveSession();
  }, [socket, closeActiveSession]);

  // Restart = kill the current session, then start a fresh one after a short delay
  // (gives the server time to tear down the old PTY). Deliberately NOT built on
  // stopSession: the user asked for a replacement shell here, not for the next one
  // in the strip, so this must not run the survivor-adoption path.
  //
  // Reserving the pending slot as 'new' up front does three jobs across the delay
  // window: it blocks input to the dead PTY, it stops the shell:sessions broadcast
  // that follows the stop from adopting a survivor into the gap, and its generation
  // is the staleness guard — a user action inside the window (tab click, New) bumps
  // it and aborts our delayed start rather than letting it clobber their switch.
  const restartSession = useCallback(() => {
    if (!socket || !sessionIdRef.current) return;
    socket.emit('shell:stop', { sessionId: sessionIdRef.current });
    clearActiveSession();
    pendingNavIntentRef.current = 'replace';
    setPendingAttach('new');
    if (termInstanceRef.current) {
      termInstanceRef.current.writeln('\r\n\x1b[33m[Restarting session...]\x1b[0m');
    }
    goToShellRoot();
    const gen = pendingAttachRef.current.generation;
    setTimeout(() => {
      if (!mountedRef.current) return;
      if (pendingAttachRef.current.generation !== gen) return;
      startSession();
    }, 1000);
  }, [socket, clearActiveSession, setPendingAttach, startSession, goToShellRoot]);

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

  // Launch a configured TUI provider from the Shell page's provider menu — the
  // in-page twin of the AI Providers page's `?provider=` deep link. Always a NEW
  // session, and always by ID rather than by command line; the reason is in
  // `components/shell/ShellProviderLauncher.jsx`. The displayed session's cwd
  // rides along so a launch lands in the folder the user already cd'd to rather
  // than back at $HOME.
  const launchProvider = useCallback((providerId) => {
    if (!providerId) return;
    const cwd = sessionsRef.current.find(s => s.sessionId === sessionIdRef.current)?.cwd;
    startSession({ intent: 'push', launch: { provider: providerId, cwd } });
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
      // On first load, auto-attach to existing session or create new
      if (!hasInitializedRef.current) {
        hasInitializedRef.current = true;
        const opts = initialOptsRef.current || {};
        const urlSid = urlSessionIdRef.current;
        // If we have initial opts (cwd/cmd), always create a new session
        if (opts.session && sessionList.some(s => s.sessionId === opts.session)) {
          attachToSession(opts.session);
          initialOptsRef.current = {};
        } else if (opts.cwd || opts.cmd || opts.provider) {
          startSession();
        } else if (urlSid && sessionList.some(s => s.sessionId === urlSid)) {
          // URL points at a live session — attach to that one (deep-link intent
          // overrides the "don't steal" guard; the prior tab gets shell:detached).
          attachToSession(urlSid);
        } else if (sessionList.length > 0 && !sessionIdRef.current) {
          // Attach to the most recent existing session that isn't already driving
          // another tab. handleConnect resets hasInitializedRef, so this also runs on
          // every reconnect — adoption is safe there, spawning is not.
          recoverToSurvivor(null, () => {
            // Every live session is attached elsewhere. If the user hasn't just closed
            // one, they landed here (probably via a now-dead deep link) intending to
            // get a shell — start a fresh one rather than leaving them at bare /shell.
            // Capacity counts only interactive shells: external TUI runs are exempt
            // from the cap server-side, so they must not block a new shell here.
            const atCap = sessionList.filter(s => !s.external).length >= MAX_SESSIONS;
            if (suppressAutoStartRef.current || atCap) goToShellRoot();
            else startSession();
          });
        } else if (sessionList.length === 0 && !suppressAutoStartRef.current) {
          // Auto-start on empty list — skipped after a user close so a transient
          // reconnect (which resets hasInitializedRef and re-enters this branch)
          // doesn't spawn a new session over an explicit Stop.
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
        recoverToSurvivor(displayed);
        return;
      }
      // Tab is sitting on bare /shell with no displayed session — it arrived when every
      // live session was attached elsewhere, or the user closed their last free one. If
      // another tab later disconnects and frees a session, adopt it so the user doesn't
      // have to click to recover. Gated only on there being no in-flight start/attach to
      // race; STAY_PUT because bare /shell is already where we are.
      if (!displayed && !pendingAttachRef.current.target) {
        recoverToSurvivor(null, STAY_PUT);
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
        resetTerminalWheelScroll(termInstanceRef.current);
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
      if (sid !== sessionIdRef.current) return;
      clearActiveSession();
      if (termInstanceRef.current) {
        termInstanceRef.current.writeln(`\r\n\x1b[33m[Shell exited with code ${code}]\x1b[0m`);
      }
      // If the user has an in-flight start/attach to a different session, let it
      // complete instead of overriding it with our fallback. The handleShellAttached
      // response will install the new session and the user's intent wins.
      if (pendingAttachRef.current.target) return;
      // Recovering synchronously (rather than behind a timer) is what keeps the
      // shell:sessions broadcast that follows shell:exit from adopting a different
      // survivor into the gap — attachToSession sets the pending target before the
      // broadcast can arrive, and the adoption branch skips while it's set.
      recoverToSurvivor(sid);
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
      // If the user already has an attach in flight to a different session, let the
      // pending request complete (its handleShellAttached will navigate appropriately).
      if (pendingAttachRef.current.target) return;
      // Recover explicitly rather than relying on the shell:sessions broadcast the
      // server happens to send after a takeover: this is the path the user is least
      // responsible for, so it must not be the one whose recovery is incidental.
      recoverToSurvivor(sid);
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
        recoverToSurvivor(failedTarget);
        return;
      }
      if (!live.some(s => s.sessionId === active)) {
        // The session we were displaying is also gone — recover the same way.
        clearActiveSession();
        recoverToSurvivor(failedTarget);
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
  }, [socket, startSession, attachToSession, activateSession, clearActiveSession, cancelPendingAttach, setPendingAttach, recoverToSurvivor, goToShellRoot]);

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
    // address bar — but only when there's nothing in flight, since a pending attach
    // will navigate via activateSession on success. handleSessions handles survivor
    // adoption and the deep-link new-session fallback when initial-load runs.
    if (urlSessionId && !pendingAttachRef.current.target) {
      goToShellRoot();
    }
  }, [urlSessionId, switchToSession, goToShellRoot]);

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
    sendImage,
    sendCommand,
    sendCd,
    sendCtrlB,
    sendCtrlC,
    sendNavKey,
    scrollPage,
    restartSession,
    stopSession,
    startNewSession,
    launchProvider,
    switchToSession,
    killOtherSession,
  };
}
