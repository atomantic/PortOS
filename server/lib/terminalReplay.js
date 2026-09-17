/**
 * Replay correctness for the buffer a PTY session hands a newly attached client
 * (`attachSession` in `services/shell.js`): what must be STRIPPED out of the
 * recorded bytes, and what must be RE-ASSERTED because it was never in them.
 *
 * ── The bug the stripping fixes ────────────────────────────────────────────────
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
 * ── The other replay bug: modes that scrolled out of the ring buffer ───────────
 *
 * A full-screen TUI declares its terminal state ONCE, in its first few hundred
 * bytes — alternate screen, mouse tracking and its encoding, bracketed paste,
 * cursor visibility — and never repeats it. The ring buffer keeps only the LAST
 * 50KB, and the attaching client `reset()`s its terminal before painting the
 * replay, so on any session that has emitted more than that the declaration is
 * gone and the viewer comes up in the DEFAULT state: normal buffer, no mouse.
 *
 * Every consumer that branches on terminal mode then branches wrongly — most
 * visibly `client/src/lib/terminalScroll.js`, which routes a scroll gesture by
 * buffer type and mouse-tracking mode, so a watched TUI-agent run cannot be
 * scrolled at all. (Observed with OpenCode, whose TUI passes 120KB inside a
 * minute; nothing here is specific to it.)
 *
 * Growing the buffer only moves the threshold, and pinning its head would replay
 * a declaration the app may since have taken back. So track the modes over the
 * WHOLE stream and have `preamble()` re-declare whatever is still in force,
 * prepended to the replay: attach becomes "state first, then history".
 *
 * ── Ceiling ────────────────────────────────────────────────────────────────────
 * This covers `CSI ? … h/l` and nothing else. Other sticky state a mid-stream cut
 * destroys — keypad mode (`ESC =` / `ESC >`), scroll region, charset designation,
 * the SGR pen at the cut point — is out of scope. If that starts to matter, the
 * next step is not a third ad-hoc tracker: it is serializing real terminal state
 * from a server-side headless emulator, the way tmux and asciinema do.
 */

// The DEC private modes a re-attaching terminal has to inherit, each mapped to
// the value a freshly-`reset()` terminal already holds — only a departure from
// that default is worth re-declaring. The test for inclusion is STICKY STATE
// THAT CHANGES HOW THE TERMINAL INTERPRETS INPUT OR PAINTS OUTPUT, which is why
// this deliberately excludes begin/end pairs (`?2026` synchronized update —
// re-declaring a dangling "begin" would freeze the view) and feature negotiation
// (`?2027`, `?2031`). Alternate-screen modes lead so the replayed frames paint
// into the buffer they were drawn for.
const REPLAYED_PRIVATE_MODES = [
  [1049, 'l'], // alternate screen + save cursor (xterm)
  [1047, 'l'], // alternate screen (xterm, no cursor save)
  [47, 'l'],   // alternate screen (DEC)
  [1, 'l'],    // DECCKM — application cursor keys
  [25, 'h'],   // DECTCEM — cursor visible
  [9, 'l'],    // X10 mouse — press only, no wheel (terminalScroll.js branches on it)
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

const TRACKED_MODES = new Set(REPLAYED_PRIVATE_MODES.map(([mode]) => mode));

// `ESC[?1000;1002;1003h` sets three modes in one sequence, so the parameter list
// is split rather than matched as a single number.
const PRIVATE_MODE_SEQUENCE = /\x1b\[\?([\d;]*)([hl])/g;

// A mode sequence can straddle two PTY chunks, so a trailing fragment that could
// still become one — `ESC`, `ESC[`, `ESC[?`, `ESC[?1000;1002` — is carried into
// the next. Deliberately TIGHTER than the incomplete-CSI grammars in
// `ansiStrip.js` and `tuiHandshake.js`, which carry any CSI prefix: only
// `ESC[?<digits>` can become a private-mode set, so an `ESC[38;5` split out of a
// truecolor run is not worth carrying. The cap bounds the carry so a lone `ESC`
// in a data stream can't grow one without end.
const PARTIAL_SEQUENCE = /\x1b(?:\[(?:\?[\d;]*)?)?$/;
const MAX_PARTIAL_LENGTH = 64;

const trailingPartialSequence = (text) => {
  const windowStart = Math.max(0, text.length - MAX_PARTIAL_LENGTH);
  // Bounded scan before the slice: plain output has no ESC near its end, and this
  // is per-chunk code on every PTY in the install. Skipping the slice+match there
  // is most of the cost and all of the allocation.
  if (text.indexOf('\x1b', windowStart) === -1) return '';
  return text.slice(windowStart).match(PARTIAL_SEQUENCE)?.[0] ?? '';
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
      if (!chunk) return;
      const text = partial + chunk;
      partial = trailingPartialSequence(text);
      if (!text.includes('\x1b[?')) return;
      for (const [, params, value] of text.matchAll(PRIVATE_MODE_SEQUENCE)) {
        for (const param of params.split(';')) {
          const mode = Number(param);
          if (TRACKED_MODES.has(mode)) observed.set(mode, value);
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
