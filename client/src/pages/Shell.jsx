import { useEffect, useRef, useState, useCallback } from 'react';
import { useSearchParams, useParams, useNavigate } from 'react-router-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useSocket } from '../hooks/useSocket';
import { RefreshCw, Power, PowerOff, FolderOpen, ChevronDown, Plus, X, Terminal as TerminalIcon, ClipboardPaste, OctagonX } from 'lucide-react';
import * as api from '../services/api';
import { readClipboard } from '../lib/clipboard';

// Must match MAX_TOTAL_SESSIONS in server/services/shell.js
const MAX_SESSIONS = 5;

const QUICK_COMMANDS = [
  { label: 'claude', command: 'claude --dangerously-skip-permissions' },
  { label: 'codex', command: 'codex' },
  { label: 'gemini', command: 'gemini' },
  { label: 'openclaw', command: 'openclaw tui' },
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
  // In-flight start/attach state: { target, generation }.
  //   - target: the requested session id, the sentinel 'new' for shell:start, or null
  //   - generation: monotonically incremented on every state change (start, attach,
  //     success-consume, cancel, error). Used by deferred work (setTimeout fallbacks)
  //     to detect whether the user changed their mind during the delay window.
  // Strict equality on target is required for stale-response detection — a null target
  // means "no pending OR cancelled mid-flight", so any shell:attached/started arriving
  // after a cancel is rejected (matches !== null only when both sides hold the same id).
  // The sentinel 'new' covers shell:start (id unknown until shell:started arrives).
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
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [appFolders, setAppFolders] = useState([]);
  const [folderDropdownOpen, setFolderDropdownOpen] = useState(false);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const pasteInputRef = useRef(null);
  const dropdownRef = useRef(null);
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const emitShellInput = useCallback((data) => {
    if (!socket || !sessionIdRef.current) return;
    // Don't fire quick-commands into the prior session while a switch/start is mid-flight.
    if (pendingAttachRef.current.target) return;
    socket.emit('shell:input', { sessionId: sessionIdRef.current, data });
    termInstanceRef.current?.focus();
  }, [socket]);

  const sendCommand = useCallback((cmd) => emitShellInput(cmd + '\n'), [emitShellInput]);
  const sendCtrlC = useCallback(() => emitShellInput('\x03'), [emitShellInput]);
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
      termInstanceRef.current.clear();
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
      termInstanceRef.current.clear();
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
      // steal them via the shell:detached takeover. Manual tab clicks bypass this.
      const pickUnattachedSurvivor = (list) => {
        const free = list.filter(s => !s.attached);
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
          } else if (sessionList.length < MAX_SESSIONS) {
            // Every live session is attached elsewhere but we have capacity. The user
            // landed here (probably via a now-dead deep link) intending to get a
            // shell — start a fresh one rather than leaving them at bare /shell.
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
        // Auto-attach to a survivor not already driving another tab (don't steal).
        const free = sessionsRef.current.filter(s => s.sessionId !== sid && !s.attached);
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
        const free = live.filter(s => !s.attached && s.sessionId !== failedTarget);
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
        const free = live.filter(s => !s.attached && s.sessionId !== failedTarget);
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
            onClick={startNewSession}
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
            const label = s.label || s.cwd?.split('/').pop() || shortId(s.sessionId);
            return (
              <div
                key={s.sessionId}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-mono transition-colors cursor-pointer min-h-[40px] ${
                  isActive
                    ? 'bg-port-accent/20 text-port-accent border border-port-accent/40'
                    : 'bg-port-card hover:bg-port-border text-gray-400 hover:text-white border border-port-border'
                }`}
                onClick={() => !isActive && switchToSession(s.sessionId)}
                title={`${s.label || s.cwd || shortId(s.sessionId)} — ${formatAge(s.createdAt)} old`}
              >
                <TerminalIcon size={12} className="shrink-0" />
                <span className="truncate max-w-[140px]">{label}</span>
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
            onClick={startNewSession}
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
          <button
            onClick={sendCtrlC}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/15 hover:bg-red-500/25 text-red-400 hover:text-red-300 rounded text-xs font-mono transition-colors border border-red-500/30 min-h-[40px]"
            title="Send Ctrl+C interrupt"
          >
            <OctagonX size={14} />
            Ctrl+C
          </button>
          <button
            onClick={handlePaste}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent hover:text-blue-300 rounded text-xs font-mono transition-colors border border-port-accent/30 min-h-[40px]"
            title="Paste clipboard contents"
          >
            <ClipboardPaste size={14} />
            Paste
          </button>
          {showPasteInput && (
            <input
              ref={pasteInputRef}
              type="text"
              className="w-32 px-2 py-1.5 bg-port-card text-white text-xs font-mono rounded border border-port-accent/50 focus:outline-none focus:border-port-accent min-h-[40px] placeholder-gray-500"
              placeholder="Tap & paste here"
              onPaste={handlePasteInputEvent}
              onBlur={() => setShowPasteInput(false)}
            />
          )}
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
