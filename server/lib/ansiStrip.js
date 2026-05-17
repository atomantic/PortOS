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

export const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

const INCOMPLETE_CSI = /^\x1B\[[0-?]*[ -/]*$/;
const INCOMPLETE_OSC = /^\x1B\][^\x07\x1B]*$/;
const INCOMPLETE_ESC_2BYTE = /^\x1B$/;

export function createStreamingAnsiStripper() {
  let tail = '';
  const strip = (s) => s.replace(ANSI_PATTERN, '').replace(/\x00/g, '');
  return (text) => {
    const combined = tail + text;
    tail = '';
    const lastEsc = combined.lastIndexOf('\x1B');
    // Only consider the trailing fragment if it lives near the end — older
    // unterminated bytes belong to a previous repaint and would never
    // resolve. Bodies longer than 4096 bytes are treated as terminated; an
    // unbounded OSC (e.g. very long hyperlink) would leak its body to
    // display rather than buffer forever.
    if (lastEsc !== -1 && combined.length - lastEsc <= 4096) {
      const candidate = combined.slice(lastEsc);
      if (INCOMPLETE_ESC_2BYTE.test(candidate)
        || INCOMPLETE_CSI.test(candidate)
        || INCOMPLETE_OSC.test(candidate)) {
        tail = candidate;
        return strip(combined.slice(0, lastEsc));
      }
    }
    return strip(combined);
  };
}

/**
 * One-shot strip for buffered text (no streaming state). Use when you have
 * the full PTY output in memory and just want a cleaned copy.
 */
export function stripAnsi(text) {
  if (typeof text !== 'string') return '';
  return text.replace(ANSI_PATTERN, '').replace(/\x00/g, '');
}
