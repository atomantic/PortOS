// Buffered chunk→line splitter for child-process stdout/stderr streams.
//
// Node delivers a stream's 'data' chunks on arbitrary byte boundaries, so a
// single output line can arrive split across two chunks (or several lines can
// arrive in one chunk). `createLineReader` carries the partial trailing line
// between chunks and emits each COMPLETE line to `onLine`; call `flush()` on
// the process 'close'/'exit' event to emit any final line the child wrote
// without a trailing newline (a SIGKILL mid-write, or a progress bar that
// never terminated its last redraw). Flushing the tail is the drift this
// helper ends — hand-copied splitters (ytdlpAudioImport, videoDownload) were
// dropping that unterminated last line while hfDownload's copy alone flushed.
//
// Chunks are decoded through a per-reader `StringDecoder`, so a multibyte
// UTF-8 codepoint split across a chunk boundary (a non-ASCII yt-dlp title,
// say) is stitched back together instead of decoded as two replacement
// characters. Callers may also `push()` plain strings (tests, already-decoded
// input) — those pass straight through.
//
// Each stream needs its OWN reader: a shared carry buffer would splice a
// partial line from stdout onto a chunk from stderr and corrupt marker lines.
//
// `splitRe` defaults to `/\r?\n/` (newline-terminated lines; blank lines are
// preserved as empty strings). Pass `splitRe: /[\r\n]+/` for torch/tqdm-style
// progress bars that redraw the same line with a bare `\r` and no `\n`, so each
// redraw surfaces as its own line. A collapsing regex like `/[\r\n]+/` collapses
// separator runs WITHIN a chunk, but a run split across a chunk boundary can
// still yield one empty-string segment — every caller of that option filters
// empty lines, which is the intended usage.

import { StringDecoder } from 'string_decoder';

const DEFAULT_SPLIT_RE = /\r?\n/;
// Clamp so a stream that never emits a separator can't grow the carry buffer
// without bound (a runaway child writing megabytes with no newline). At the
// threshold the oversized carry is flushed as a line and the buffer reset.
const DEFAULT_MAX_CARRY = 1 << 20; // 1 MiB

export function createLineReader(onLine, { splitRe = DEFAULT_SPLIT_RE, maxCarry = DEFAULT_MAX_CARRY } = {}) {
  const decoder = new StringDecoder('utf8');
  let carry = '';

  const push = (chunk) => {
    carry += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const lines = carry.split(splitRe);
    carry = lines.pop() ?? '';
    for (const line of lines) onLine(line);
    if (carry.length > maxCarry) {
      // Safety valve: no separator seen within maxCarry chars. Emit what we
      // have as a line rather than buffer unbounded, then reset.
      const oversized = carry;
      carry = '';
      onLine(oversized);
    }
  };

  const flush = () => {
    // Drain any bytes the decoder is still holding for an incomplete multibyte
    // sequence (a no-op when only strings were pushed).
    carry += decoder.end();
    if (carry.length === 0) return;
    const line = carry;
    carry = '';
    onLine(line);
  };

  return { push, flush };
}
