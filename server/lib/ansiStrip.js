/**
 * Shared streaming ANSI / control-byte stripper.
 *
 * PTY chunks can split a CSI/OSC escape sequence across reads; a trailing
 * incomplete-escape fragment is buffered and prepended to the next chunk.
 * Returns a stateful stripper function — instantiate one per stream.
 */

// OSC alternative comes first: the single-byte class `[@-Z\\-_]` includes `]`, so
// running first it would strip only the `\x1B]` opener and leak body+terminator.
// The body alternation `[^\x07\x1B]|\x1B(?!\\)` stops at the FIRST ST; a naive
// `[^\x07]*` would swallow visible text between adjacent OSC sequences. No
// catastrophic backtracking: each char yields at most one alternative.
export const ANSI_PATTERN = /\x1B(?:\](?:[^\x07\x1B]|\x1B(?!\\))*(?:\x07|\x1B\\)|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const INCOMPLETE_CSI = /^\x1B\[[0-?]*[ -/]*$/;
const INCOMPLETE_ESC_2BYTE = /^\x1B$/;
// OSC terminators (BEL or ST). Module-level `g`-regex; reset `lastIndex` per use.
const OSC_TERMINATOR = /\x07|\x1B\\/g;

// `[@-_]` is the range that legitimately follows `\x1B` (CSI, OSC, single-byte
// forms); the lookahead spares those starts so the main pattern can match them.
const STRIP = (s) => s
  .replace(ANSI_PATTERN, '')
  .replace(/\x1B(?![@-_])/g, '')
  .replace(/\x00/g, '');

export function createStreamingAnsiStripper() {
  let tail = '';
  return (text) => {
    const combined = tail + text;
    tail = '';
    // Linear-time OSC tail detection: find the position after the LAST terminator,
    // then (clipped to the trailing 4096 bytes so an unbounded body leaks instead
    // of pinning memory) the first `\x1B]` opener: the outermost in-progress OSC.
    // A single end-anchored regex goes quadratic with many `\x1B]` candidates.
    OSC_TERMINATOR.lastIndex = 0;
    let lastTermEnd = 0;
    let tMatch;
    while ((tMatch = OSC_TERMINATOR.exec(combined)) !== null) {
      lastTermEnd = tMatch.index + tMatch[0].length;
    }
    const oscSearchStart = Math.max(lastTermEnd, combined.length - 4096);
    const oscOpen = combined.indexOf('\x1B]', oscSearchStart);
    if (oscOpen !== -1) {
      tail = combined.slice(oscOpen);
      return STRIP(combined.slice(0, oscOpen));
    }
    // CSI parameter bytes exclude `\x1B`, so the rightmost `\x1B` is the
    // unambiguous anchor for incomplete CSI / bare-ESC tails.
    const lastEsc = combined.lastIndexOf('\x1B');
    if (lastEsc !== -1 && combined.length - lastEsc <= 4096) {
      const candidate = combined.slice(lastEsc);
      if (INCOMPLETE_ESC_2BYTE.test(candidate) || INCOMPLETE_CSI.test(candidate)) {
        tail = candidate;
        return STRIP(combined.slice(0, lastEsc));
      }
    }
    return STRIP(combined);
  };
}

/**
 * One-shot strip for buffered text (no streaming state). Use when you have
 * the full PTY output in memory and just want a cleaned copy.
 */
export function stripAnsi(text) {
  if (typeof text !== 'string') return '';
  return STRIP(text);
}
