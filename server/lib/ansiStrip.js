/**
 * Shared streaming ANSI / control-byte stripper.
 *
 * PTY output arrives in arbitrary chunks. A CSI/OSC escape sequence can split
 * across two reads (e.g. `\x1B[` ends one chunk, `2J` starts the next) and a
 * naive per-chunk strip would leak the body of unterminated sequences into
 * the cleaned stream. This helper buffers a trailing fragment if it looks
 * like an incomplete escape and prepends it to the next chunk before
 * stripping, so split sequences resolve cleanly.
 *
 * Returns a stateful stripper function — instantiate one per stream.
 */

// OSC alternative comes first so a complete `\x1B]<body>(BEL|ST)` sequence is
// consumed whole. The single-byte class `[@-Z\\-_]` covers 0x40-0x5A and
// 0x5C-0x5F, which includes `]` (0x5D); if it ran first it would strip the
// `\x1B]` opener only and leak the body+terminator. The bare `\x1B]` (no
// terminator) case still falls through to the single-byte branch.
//
// Body alternation `[^\x07\x1B]|\x1B(?!\\)` stops greedy matching at the
// FIRST `\x1B\\` (ST terminator). A naive `[^\x07]*` would otherwise prefer
// the latest possible ST and swallow visible text between two adjacent
// OSC sequences (e.g. `\x1B]a\x1B\\VISIBLE\x1B]b\x1B\\` → `` instead of
// `VISIBLE`). Each character produces at most one alternative attempt, so
// the alternation does not introduce catastrophic backtracking.
export const ANSI_PATTERN = /\x1B(?:\](?:[^\x07\x1B]|\x1B(?!\\))*(?:\x07|\x1B\\)|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const INCOMPLETE_CSI = /^\x1B\[[0-?]*[ -/]*$/;
const INCOMPLETE_ESC_2BYTE = /^\x1B$/;
// OSC terminators (BEL or ST). Used to locate the position right after the
// last completed terminator so the streaming stripper can find the first
// `\x1B]` that has NO terminator before end-of-string — the outermost
// in-progress opener. Module-level `g`-regex; reset `lastIndex` per use.
const OSC_TERMINATOR = /\x07|\x1B\\/g;

// `[@-_]` (0x40-0x5F) is the byte range that legitimately follows an `\x1B`
// in a complete sequence: covers `[` (0x5B) for CSI, `]` (0x5D) for OSC, plus
// the single-byte escape forms (`\x1B@` ... `\x1B_`) caught by the main
// pattern's first branch. The lookahead spares those starts so the main
// pattern can match them on the current or next chunk.
const STRIP = (s) => s
  .replace(ANSI_PATTERN, '')
  .replace(/\x1B(?![@-_])/g, '')
  .replace(/\x00/g, '');

export function createStreamingAnsiStripper() {
  let tail = '';
  return (text) => {
    const combined = tail + text;
    tail = '';
    // Linear-time OSC tail detection:
    //   1. Walk the string once to find the position right after the LAST
    //      OSC terminator (`\x07` or `\x1B\\`). Anything after that
    //      position is candidate territory for an in-progress OSC; by
    //      construction it contains no terminator, so the body grammar
    //      `[^\x07\x1B]|\x1B(?!\\)` matches every byte in it.
    //   2. From there (clipped to the trailing 4096-byte window so an
    //      unbounded body leaks instead of pinning memory), locate the
    //      first `\x1B]` opener. That's the outermost in-progress OSC.
    //
    // An earlier `combined.match(/\x1B\]...$/)` implementation was elegant
    // but went quadratic when many `\x1B]` candidates preceded a final
    // terminator — each candidate ran a full-length body match before
    // failing the `$` anchor. The scan below is strictly O(combined.length).
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
