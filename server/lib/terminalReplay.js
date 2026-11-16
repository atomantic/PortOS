/**
 * `stripTerminalQueries` removes response-soliciting terminal sequences (DSR, DA, DECRQM, OSC color queries) from a PTY replay buffer so re-attached clients do not answer them.
 *
 * Replay correctness for the buffer `attachSession` (`services/shell.js`) hands a newly attached client: what must be STRIPPED from the recorded bytes, and what must be RE-ASSERTED because it was never in them.
 *
 * Stripping: the 50KB ring buffer stores raw PTY output verbatim, and full-screen TUIs (Claude Code / Ink, vim, htop) pepper it with QUERIES (`ESC[6n` "where is the cursor?" on nearly every render).
 * On attach xterm can't tell a replayed query from a live one and answers each (hundreds) through `onData` → `shell:input` → the PTY, where the long-gone asker's replies land on the SHELL PROMPT
 * (zsh eats the `ESC[` and self-inserts `56;3R56;3R…`). That garbage is itself PTY output appended to the same buffer, so every later attach re-fires the burst.
 * So the response-soliciting sequences are stripped at attach time over the joined buffer (a sequence split across chunks still matches, no cross-chunk state). LIVE output is untouched: a running TUI must
 * get its answers. Stripping is visually lossless; stateful sequences the replay needs (mouse tracking, bracketed paste, alternate screen, SGR) are NOT touched.
 *
 * Not `ansiStrip.js`, which removes ALL escapes for plain text; this buffer feeds a real terminal and must keep everything that paints. The set is exactly what @xterm/xterm replies to (verified by feeding
 * each sequence to a real terminal); sequences only other emulators answer (XTVERSION, XTWINOPS, XTGETTCAP, kitty `ESC[?u`) are left alone to avoid eating real output.
 */

// The final byte is the only thing that disambiguates these from the cursor-move and SGR sequences around them, so each pattern anchors on it, not the parameters.
const QUERY_PATTERNS = [
  // DSR: `ESC[6n` (cursor position, the one TUIs spam) and `ESC[5n` are answered. `CSI > Ps n` is XTMODKEYS (sets state, solicits nothing), so the `>` form is excluded.
  /\x1b\[\??\d*(?:;\d+)*n/g,
  // DA: `ESC[c` (DA1) and `ESC[>c` (DA2) both get answered.
  /\x1b\[[<>=?]?\d*(?:;\d+)*c/g,
  // DECRQM — request mode state, answered with a DECRPM report.
  /\x1b\[\??\d+(?:;\d+)*\$p/g,
  // DECRQSS: request a setting's value (answered with DECRPSS). Lazy to the first ST so an unterminated query can't swallow the buffer.
  /\x1bP\$q[\s\S]*?\x1b\\/g,
  // OSC color queries: `OSC 10/11/12;?` (fg/bg/cursor) and `OSC 4;<n>;?` / `OSC 5;<n>;?` (palette), terminated by BEL or ST.
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
 * The other replay bug: modes that scrolled out of the ring buffer. A full-screen TUI declares its terminal state ONCE in its first bytes (alternate screen, mouse tracking and encoding, bracketed paste,
 * cursor visibility), the buffer keeps only the LAST 50KB and the client `reset()`s before painting, so a long session replays into the DEFAULT state (normal buffer, no mouse). Consumers branching on mode then
 * misbehave (`client/src/lib/terminalScroll.js` can't scroll a watched TUI-agent run; seen with OpenCode, which passes 120KB in a minute).
 * Growing the buffer only moves the threshold and pinning its head could replay a declaration the app has since taken back, so modes are tracked over the WHOLE stream and `preamble()` re-declares
 * what is still in force, prepended to the replay ("state first, then history").
 *
 * Ceiling: this covers `CSI ? … h/l` only. Other sticky state a mid-stream cut destroys (keypad mode, scroll region, charset designation, the SGR pen) is out of scope; the next step would be serializing
 * real terminal state from a server-side headless emulator (as tmux and asciinema do), not a third ad-hoc tracker.
 */

// The DEC private modes a re-attaching terminal must inherit, each mapped to the value a freshly-`reset()` terminal already holds (only a departure is re-declared). Inclusion test: STICKY STATE THAT CHANGES
// HOW THE TERMINAL INTERPRETS INPUT OR PAINTS OUTPUT; so begin/end pairs (`?2026` synchronized update: a dangling "begin" would freeze the view) and feature negotiation (`?2027`, `?2031`) are excluded.
// Alternate-screen modes lead so replayed frames paint into the buffer they were drawn for.
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

// `ESC[?1000;1002;1003h` sets three modes in one sequence, so the parameter list is split.
const PRIVATE_MODE_SEQUENCE = /\x1b\[\?([\d;]*)([hl])/g;

// A mode sequence can straddle two PTY chunks, so a trailing fragment that could still become one (`ESC`, `ESC[`, `ESC[?`, `ESC[?1000;1002`) is carried. TIGHTER than the CSI-prefix grammars in
// `ansiStrip.js` and `tuiHandshake.js`: only `ESC[?<digits>` can become a private-mode set. The cap bounds the carry so a lone `ESC` can't grow one without end.
const PARTIAL_SEQUENCE = /\x1b(?:\[(?:\?[\d;]*)?)?$/;
const MAX_PARTIAL_LENGTH = 64;

const trailingPartialSequence = (text) => {
  const windowStart = Math.max(0, text.length - MAX_PARTIAL_LENGTH);
  // Bounded scan before the slice: plain output has no ESC near its end, and this is per-chunk code on every PTY, so skipping the slice+match saves most of the cost and all the allocation.
  if (text.indexOf('\x1b', windowStart) === -1) return '';
  return text.slice(windowStart).match(PARTIAL_SEQUENCE)?.[0] ?? '';
};

/**
 * Follow the private-mode state of a PTY stream so a later attach can be handed the modes still in force, whatever the ring buffer has dropped.
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

/**
 * The re-attach ring buffer: the recorded bytes plus BOTH corrections above behind one object (properties of the replay, so `render()` guarantees the preamble leads rather than each attach site remembering).
 * Eviction keeps the NEWEST chunk unconditionally: a single chunk over the cap is the live screen, and dropping it would hand an attaching client an empty terminal.
 *
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ push: (data: string) => void, render: () => string }}
 */
export const createReplayBuffer = ({ maxBytes = 50 * 1024 } = {}) => {
  const chunks = [];
  const modes = createTerminalModeTracker();
  let bytes = 0;

  return {
    /** Record one chunk of raw PTY output, in stream order. */
    push(data) {
      // Observed before eviction can drop the startup chunk that declared them.
      modes.observe(data);
      chunks.push(data);
      bytes += data.length;
      while (bytes > maxBytes && chunks.length > 1) {
        bytes -= chunks.shift().length;
      }
    },

    /** What a newly attached client is handed. */
    render() {
      return modes.preamble() + stripTerminalQueries(chunks.join(''));
    }
  };
};
