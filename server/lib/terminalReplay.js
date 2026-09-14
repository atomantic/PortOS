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
