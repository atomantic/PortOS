/**
 * Sanitize the re-attach replay buffer a PTY session hands a newly attached
 * client (`attachSession` in `services/shell.js`).
 *
 * ── The bug this fixes ─────────────────────────────────────────────────────────
 * The 50KB ring buffer stores raw PTY output verbatim, and full-screen TUIs
 * (Claude Code / Ink, vim, htop) pepper that output with terminal QUERIES —
 * `ESC[6n` "where is the cursor?" most of all, emitted on essentially every
 * render. A query is not history: it is a question whose answer the terminal
 * emulator sends back as INPUT.
 *
 * So when a second tab attaches (deep link, reload, session switch, socket
 * reconnect) and the client writes the replay buffer into xterm, xterm cannot
 * tell a replayed historical query from a live one. It dutifully answers every
 * one of them — hundreds, for a buffer that caught a TUI mid-render — and each
 * reply is emitted through `onData` → `shell:input` → straight into the PTY.
 *
 * The TUI that asked is long gone by then, so those replies land on the SHELL
 * PROMPT. zsh's line editor eats the `ESC[` as an unmatched key-binding prefix
 * and self-inserts the remainder as literal text, so the user watches
 * `56;3R56;3R56;3R…` (a cursor-position report for row 56, column 3) pour into
 * their command line. Worse, that echoed garbage is itself PTY output, so it is
 * appended to the same ring buffer — which still holds the queries — and every
 * later attach re-fires the burst and adds more.
 *
 * ── The fix ────────────────────────────────────────────────────────────────────
 * Strip the response-soliciting sequences on the way OUT, at attach time, over
 * the joined (contiguous) buffer — so a sequence split across two stored chunks
 * is still matched, and no state has to be carried between chunks. LIVE output
 * is deliberately untouched: a TUI that is actually running must still get its
 * answers.
 *
 * Removing them is visually lossless. Every sequence below renders nothing; it
 * only asks a question. Stateful sequences that the replay legitimately needs to
 * re-establish (mouse tracking, bracketed paste, alternate screen, SGR) are NOT
 * touched.
 *
 * Not `ansiStrip.js`: that one removes ALL escape sequences to recover plain text
 * for log/summary extraction. The replay buffer is fed back to a real terminal, so
 * it must keep everything that paints — this removes only the questions.
 *
 * The set is exactly what @xterm/xterm actually replies to, verified by feeding
 * each sequence to a real terminal and watching `onData`. Sequences other
 * emulators answer but xterm does not (XTVERSION `ESC[>q`, XTWINOPS `ESC[18t`,
 * XTGETTCAP, kitty `ESC[?u`) are left alone — they cannot produce this bug here,
 * and stripping more than necessary risks eating real output.
 */

// The final byte is the only thing that disambiguates these from the cursor-move
// and SGR sequences they sit among in real output, so each pattern is anchored on
// it rather than on the parameters.
const QUERY_PATTERNS = [
  // DSR — Device Status Report. `ESC[6n` (cursor position) is the one TUIs spam;
  // `ESC[5n` (operating status) is answered too. `CSI > Ps n` is XTMODKEYS, which
  // sets state and solicits nothing, so the `>` form is deliberately excluded.
  /\x1b\[\??\d*(?:;\d+)*n/g,
  // DA — Device Attributes. `ESC[c` (DA1) and `ESC[>c` (DA2) both get answered.
  /\x1b\[[<>=?]?\d*(?:;\d+)*c/g,
  // DECRQM — request mode state, answered with a DECRPM report.
  /\x1b\[\??\d+(?:;\d+)*\$p/g,
  // DECRQSS — request a setting's current value, answered with a DECRPSS string.
  // Lazy to the first ST so an unterminated query can't swallow the rest of the
  // buffer.
  /\x1bP\$q[\s\S]*?\x1b\\/g,
  // OSC color queries — `OSC 10/11/12;?` (fg/bg/cursor) and `OSC 4;<n>;?` /
  // `OSC 5;<n>;?` (palette). Terminated by BEL or ST.
  /\x1b\](?:1[0-2]|[45];\d+);\?(?:\x07|\x1b\\)/g,
];

/**
 * Remove every sequence that would make a terminal emulator send input back.
 *
 * @param {string} text - raw PTY output (the joined re-attach ring buffer)
 * @returns {string} the same output with response-soliciting queries removed
 */
export const stripTerminalQueries = (text) => {
  if (typeof text !== 'string') return '';
  if (!text.includes('\x1b')) return text;
  return QUERY_PATTERNS.reduce((out, pattern) => out.replace(pattern, ''), text);
};

/**
 * ── The second replay bug: modes that scrolled out of the ring buffer ──────────
 *
 * A full-screen TUI announces its terminal state ONCE, in its first few hundred
 * bytes: alternate screen (`ESC[?1049h`), mouse tracking (`ESC[?1000;1002;1003h`
 * plus an encoding like `ESC[?1006h`), bracketed paste, cursor visibility. The
 * replay buffer keeps only the LAST 50KB, so on any run long enough to overflow
 * it — which is every watched TUI-agent run — those announcements are gone by the
 * time someone attaches. The attaching xterm is `reset()` first, so it repaints a
 * long-running OpenCode session as a NORMAL-buffer, mouse-less terminal.
 *
 * Everything that reads the terminal's mode state then reads the wrong answer:
 *
 *   - `lib/terminalScroll.js` (client) decides how to scroll from
 *     `buffer.active.type` and `modes.mouseTrackingMode`. Believing it is in the
 *     normal buffer, it scrolls local scrollback — frames of a redrawing TUI —
 *     instead of routing the gesture to the app, and xterm never forwards a wheel
 *     as a mouse report because no app asked for mouse events. OpenCode's message
 *     viewport therefore cannot be scrolled at all from the Shell page.
 *   - `useShellSession`'s arrow-key buttons pick CSI vs SS3 from
 *     `applicationCursorKeysMode`, and send the wrong one.
 *
 * Fixed here rather than by growing the ring buffer, which only moves the
 * threshold: the tracker watches the WHOLE stream and `preamble()` re-announces
 * the modes still in force, prepended to the replay so the attaching terminal
 * starts in the state the live PTY is actually in.
 */

// The DEC private modes a re-attaching terminal has to inherit, mapped to the
// value a freshly-`reset()` terminal already holds — only a departure from that
// default is worth re-announcing. Alternate-screen modes lead the list so the
// replayed frames paint into the buffer they were drawn for.
//
// Deliberately NOT tracked: transient modes that are a begin/end pair rather than
// a state (`?2026` synchronized update — replaying a dangling "begin" would freeze
// the view) and modes no PortOS code reads.
const REPLAYED_PRIVATE_MODES = [
  [1049, 'l'], // alternate screen + save cursor (xterm)
  [1047, 'l'], // alternate screen (xterm, no cursor save)
  [47, 'l'],   // alternate screen (DEC)
  [1, 'l'],    // DECCKM — application cursor keys
  [25, 'h'],   // DECTCEM — cursor visible
  [1000, 'l'], // X11 mouse — button press/release
  [1002, 'l'], // X11 mouse — button + drag motion
  [1003, 'l'], // X11 mouse — any motion
  [1004, 'l'], // focus in/out reporting
  [1005, 'l'], // UTF-8 mouse encoding
  [1006, 'l'], // SGR mouse encoding
  [1015, 'l'], // urxvt mouse encoding
  [1016, 'l'], // SGR pixel mouse encoding
  [2004, 'l'], // bracketed paste
];

const MODE_DEFAULTS = new Map(REPLAYED_PRIVATE_MODES);

// `ESC[?1000;1002;1003h` sets three modes in one sequence, so the parameter list
// is split rather than matched as a single number.
const PRIVATE_MODE_SEQUENCE = /\x1b\[\?([\d;]*)([hl])/g;

// A mode sequence can straddle two PTY chunks. Carry only a trailing fragment that
// could still become one — `ESC`, `ESC[`, `ESC[?`, `ESC[?1000;1002` — and cap it so
// a lone `ESC` in a data stream can't grow an unbounded carry.
const PARTIAL_SEQUENCE = /\x1b(?:\[\??[\d;]*)?$/;
const MAX_PARTIAL_LENGTH = 64;

const trailingPartialSequence = (text) => {
  const tail = text.slice(-MAX_PARTIAL_LENGTH);
  return tail.match(PARTIAL_SEQUENCE)?.[0] ?? '';
};

/**
 * Follow the private-mode state of a PTY stream so a later attach can be handed
 * the modes still in force, whatever the ring buffer has since dropped.
 *
 * @returns {{ observe: (chunk: string) => void, preamble: () => string }}
 */
export const createTerminalModeTracker = () => {
  const observed = new Map();
  let partial = '';

  return {
    /** Feed one chunk of raw PTY output, in stream order. */
    observe(chunk) {
      if (typeof chunk !== 'string' || !chunk) return;
      const text = partial + chunk;
      partial = trailingPartialSequence(text);
      if (!text.includes('\x1b[?')) return;
      PRIVATE_MODE_SEQUENCE.lastIndex = 0;
      let match;
      while ((match = PRIVATE_MODE_SEQUENCE.exec(text)) !== null) {
        for (const param of match[1].split(';')) {
          const mode = Number(param);
          if (MODE_DEFAULTS.has(mode)) observed.set(mode, match[2]);
        }
      }
    },

    /**
     * The sequences that put a freshly-reset terminal into the session's current
     * mode state — empty when every tracked mode is still at its default.
     */
    preamble() {
      let out = '';
      for (const [mode, fallback] of REPLAYED_PRIVATE_MODES) {
        const value = observed.get(mode);
        if (value && value !== fallback) out += `\x1b[?${mode}${value}`;
      }
      return out;
    }
  };
};
