// Buffered chunk→line splitter for child-process stdout/stderr streams.
//
// Node delivers 'data' chunks on arbitrary byte boundaries, so a line can arrive split across chunks (or several in one). `createLineReader` carries the partial trailing line and emits each COMPLETE line to `onLine`; call `flush()` on process 'close'/'exit' to emit a final line written
// without a trailing newline (SIGKILL mid-write, a progress bar that never terminated its last redraw): hand-copied splitters (ytdlpAudioImport, videoDownload) dropped that line while hfDownload's alone flushed. Chunks decode through a per-reader `StringDecoder` so a multibyte UTF-8 codepoint split
// across a boundary stitches back instead of becoming two replacement characters; plain strings pushed by tests pass straight through. Each stream needs its OWN reader (a shared carry would splice a stdout partial onto a stderr chunk and corrupt marker lines).
// `splitRe` defaults to `/\r?\n/` (blank lines preserved as empty strings); pass `/[\r\n]+/` for torch/tqdm progress bars redrawing with a bare `\r`. A collapsing regex collapses runs WITHIN a chunk, but a run split across a boundary can yield one empty segment: every caller of that option filters empty lines.

import { StringDecoder } from 'string_decoder';

const DEFAULT_SPLIT_RE = /\r?\n/;
// Clamp so a stream that never emits a separator (a child writing megabytes with no newline) can't grow the carry buffer without bound: at the threshold the oversized carry is flushed as a line and reset.
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
      // Safety valve: no separator within maxCarry chars; emit what we have as a line, then reset.
      const oversized = carry;
      carry = '';
      onLine(oversized);
    }
  };

  const flush = () => {
    // Drain bytes the decoder holds for an incomplete multibyte sequence (a no-op when only strings were pushed).
    carry += decoder.end();
    if (carry.length === 0) return;
    const line = carry;
    carry = '';
    onLine(line);
  };

  return { push, flush };
}

/**
 * A rolling buffer of the most recent output lines, capped by a char budget: the tail turns "exited with code 1" into the reason the tool printed (`runStreamingCommand` attaches it to every non-zero exit; `services/localRuntimeSetup.js`'s daemon starter needs it for a server dying before it binds), shared so the two can't drift.
 * `remember` ignores decoration-only lines (box drawing, rules, ASCII-art banners): a 6-line logo before failing would spend the whole budget and push the real error out.
 */
export function createOutputTail({ budget = 1024 } = {}) {
  const lines = [];
  let chars = 0;

  const remember = (line) => {
    const text = String(line ?? '').trim();
    // Something readable, not `╭─────╮` / `====` / the logo's block glyphs.
    if (!/[a-z0-9]/i.test(text)) return;
    lines.push(text);
    chars += text.length + 1;
    while (chars > budget && lines.length > 1) {
      chars -= lines.shift().length + 1;
    }
  };

  return { remember, text: () => lines.join(' — ').trim() };
}
