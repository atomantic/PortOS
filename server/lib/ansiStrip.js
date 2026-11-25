/**
 * Shared streaming ANSI / control-byte stripper.
 *
 * PTY chunks can split a CSI/OSC escape sequence across reads; a trailing
 * incomplete-escape fragment is buffered and prepended to the next chunk.
 * Returns a stateful stripper function — instantiate one per stream.
 */

// OSC alternative comes first: the two-byte class `[0-Z\\-~]` includes `]`, so
// running first it would strip only the `\x1B]` opener and leak body+terminator.
// The body alternation `[^\x07\x1B]|\x1B(?!\\)` stops at the FIRST ST; a naive
// `[^\x07]*` would swallow visible text between adjacent OSC sequences. No
// catastrophic backtracking: each char yields at most one alternative.
// Beyond CSI and OSC a terminal consumes two more ECMA-35 forms, both of which
// TUIs emit: nF (`ESC` + intermediates 0x20-0x2F + final, e.g. the charset select
// `ESC ( B`) and the two-byte Fp/Fe/Fs escapes (`ESC 7`/`ESC 8` save and restore
// the cursor). Matching only Fe used to leak `(B`, `7` and `8` into transcripts.
export const ANSI_PATTERN = /(?:\x1B\]|\x9D)(?:[^\x07\x1B\x9C]|\x1B(?!\\))*(?:\x07|\x1B\\|\x9C)|(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]|\x1B(?:[ -/]+[0-~]|[0-Z\\-~])|[\x00\x0E\x0F]/g;

const INCOMPLETE_CSI = /^(?:\x1B\[|\x9B)[0-?]*[ -/]*$/;
const INCOMPLETE_ESC_2BYTE = /^\x1B$/;
const INCOMPLETE_NF = /^\x1B[ -/]+$/;
// OSC terminators (BEL or ST). Module-level `g`-regex; reset `lastIndex` per use.
const OSC_TERMINATOR = /\x07|\x1B\\|\x9C/g;

// `[@-_]` is the range that legitimately follows `\x1B` (CSI, OSC, single-byte
// forms); the lookahead spares those starts so the main pattern can match them.
const STRIP = (s) => s
  .replace(ANSI_PATTERN, '')
  .replace(/\x1B(?![@-_])/g, '');

// After the last OSC terminator, the first opener owns any nested OSC-looking
// bytes. Scanning once avoids quadratic backtracking on incomplete sequences.
// The display stripper limits its carry; the recording spool enforces its own byte cap.
export function incompleteAnsiStart(text, maxTail = 4096) {
  OSC_TERMINATOR.lastIndex = 0;
  let lastTermEnd = 0;
  let terminator;
  while ((terminator = OSC_TERMINATOR.exec(text)) !== null) {
    lastTermEnd = terminator.index + terminator[0].length;
  }
  const searchStart = Math.max(lastTermEnd, text.length - maxTail);
  const oscOpen = text.indexOf('\x1B]', searchStart);
  const c1Open = text.indexOf('\x9D', searchStart);
  if (c1Open !== -1 && (oscOpen === -1 || c1Open < oscOpen)) return c1Open;
  if (oscOpen !== -1) return oscOpen;
  const lastEsc = Math.max(text.lastIndexOf('\x1B'), text.lastIndexOf('\x9B'));
  if (lastEsc !== -1 && text.length - lastEsc <= maxTail) {
    const candidate = text.slice(lastEsc);
    if (INCOMPLETE_ESC_2BYTE.test(candidate) || INCOMPLETE_NF.test(candidate) || INCOMPLETE_CSI.test(candidate)) return lastEsc;
  }
  return text.length;
}

export function createStreamingAnsiStripper() {
  let tail = '';
  return (text) => {
    const combined = tail + text;
    const cut = incompleteAnsiStart(combined);
    tail = combined.slice(cut);
    return STRIP(combined.slice(0, cut));
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
