/** Redact revoked vault facts in replayable terminal recordings while preserving unrelated terminal bytes. */
import { ANSI_PATTERN, incompleteAnsiStart } from './ansiStrip.js';
import { hasStoredPrivacyFacts } from './privacyPrompt.js';
import { escapeRegExp } from './textUtils.js';

export function privacyFactPattern(values) {
  const alternatives = [...values].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'gu');
}

const replacement = '[redacted]';
const emptyContext = { tail: '', previous: '' };
const active = new Map();

function recordingFilter(values) {
  const pattern = privacyFactPattern(values);
  const longest = values.reduce((max, value) => Math.max(max, value.length), 0);
  const firstCharacters = [...new Set(values.map(value => String.fromCodePoint(value.codePointAt(0))))];
  const starts = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${firstCharacters.map(escapeRegExp).join('|')})`, 'gu');
  const scrubControl = control => control.replace(pattern, replacement);

  return (batch, context, final) => {
    const raw = context.tail + batch;
    let end = final ? raw.length : incompleteAnsiStart(raw, Infinity);
    if (!final && end === raw.length && /[\uD800-\uDBFF]$/.test(raw)) end--;
    const complete = raw.slice(0, end);
    const visible = context.previous + complete.replace(ANSI_PATTERN, '');
    // Retain only a possible whole-token prefix, including a complete value
    // whose right-hand neighbor has not arrived. A longer alternative can
    // still win over a shorter complete one at the same position.
    let cut = visible.length;
    if (!final) {
      starts.lastIndex = Math.max(context.previous.length, visible.length - longest);
      for (const start of visible.matchAll(starts)) {
        const suffix = visible.slice(start.index);
        if (values.some(value => value.startsWith(suffix))) {
          cut = start.index;
          break;
        }
      }
    }
    const controls = complete.matchAll(ANSI_PATTERN);
    let control = controls.next().value;
    let hidden = 0;
    function rawOffset(offset, afterControls) {
      let position = offset - context.previous.length + hidden;
      while (control && (control.index < position || (afterControls && control.index === position))) {
        hidden += control[0].length;
        position += control[0].length;
        control = controls.next().value;
      }
      return position;
    }
    let start = 0;
    let output = '';
    pattern.lastIndex = context.previous.length; // prior text is only for the left boundary
    for (const match of visible.matchAll(pattern)) {
      if (match.index >= cut) break;
      const left = rawOffset(match.index, true);
      const right = rawOffset(match.index + match[0].length, false);
      output += complete.slice(start, left).replace(ANSI_PATTERN, scrubControl) + replacement;
      // Keep SGR state and hyperlink closures that occur inside a match.
      for (const code of complete.slice(left, right).matchAll(ANSI_PATTERN)) output += scrubControl(code[0]);
      start = right;
      cut = Math.max(cut, match.index + match[0].length);
    }
    const consumed = rawOffset(cut, true);
    output += complete.slice(start, consumed).replace(ANSI_PATTERN, scrubControl);
    const previous = visible.slice(Math.max(0, cut - 2), cut); // one full Unicode code point for lookbehind
    return { output, tail: raw.slice(consumed), previous };
  };
}

// A rollover changes the recording's left word boundary. Check both the new
// batch and any byte-capped suffix as standalone terminal input. Redaction can
// expand a short word beyond the limit; progressively shorten the same source
// so an expanding replacement cannot cycle.
function prepareBatch(batch, context, filter, final, limit) {
  const raw = context.tail + batch;
  const render = (source, previous) => filter
    ? filter(source, { tail: '', previous }, final)
    : { output: source, ...emptyContext };
  let next = render(raw, Number.isFinite(limit) ? '' : context.previous);
  if (limit === Infinity || Buffer.byteLength(next.output) + Buffer.byteLength(next.tail) <= limit) return next;
  const bytes = Buffer.from(next.output + next.tail);
  let start = bytes.length - limit;
  let step = 1;
  for (;;) {
    // node-pty supplies UTF-8 strings; preserve that invariant at a cap cut.
    while ((bytes[start] & 0xc0) === 0x80) start++;
    next = render(bytes.toString('utf8', start), '');
    if (Buffer.byteLength(next.output) + Buffer.byteLength(next.tail) <= limit) return next;
    start = Math.min(bytes.length, start + step);
    step *= 2;
  }
}

export function scrubTerminalRecording(text, values) {
  return recordingFilter(values)(text, emptyContext, true).output;
}

// File-turn callers commit a preview only after the corresponding write succeeds.
// Revocation replays the existing file and its unpublished suffix together, so
// adding another fact also works when its prefix predates the revocation.
export function trackPrivateRecording(path, prompt, setWrittenBytes) {
  const isPrivate = hasStoredPrivacyFacts(prompt);
  let values = [];
  let filter;
  let context = emptyContext;
  const recording = {
    isPrivate,
    prepare: (batch, final, limit = Infinity) => prepareBatch(batch, context, filter, final, limit),
    commit(next) {
      // A small sliced string can pin a full debounce batch or replayed file.
      const tail = next.tail ? Buffer.from(next.tail, 'utf16le').toString('utf16le') : '';
      context = { tail, previous: next.previous };
    },
    async revoke(original, revoked, write) {
      const combined = [...new Set([...values, ...revoked])];
      const updated = recordingFilter(combined);
      const next = updated(original + context.tail, emptyContext, false);
      if (next.output !== original) await write(next.output);
      values = combined;
      filter = updated;
      recording.commit(next);
      setWrittenBytes(Buffer.byteLength(next.output));
    },
    release() { if (active.get(path) === recording) active.delete(path); },
  };
  if (isPrivate) active.set(path, recording);
  return recording;
}

export async function scrubPlainRecording(path, original, values, write) {
  const recording = active.get(path);
  if (recording) return recording.revoke(original, values, write);
  const cleaned = scrubTerminalRecording(original, values);
  if (cleaned !== original) await write(cleaned);
}
