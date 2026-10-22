/**
 * Pure stderr-log triage primitives for the `error-log-triage` scheduled task
 * (#12851): split PM2 error-log text into entries, redact them, and reduce each
 * head line to a stable template + fingerprint so recurrences of one fault
 * collapse into one record. No I/O, no provider calls.
 */

import { createHash } from 'node:crypto';
import { redactPii } from './piiRedactionPatterns.js';
import { scrubSecretTokens } from './secretText.js';
import { redactOutput } from './commandSecurity.js';
import { escapeRegExp } from './textUtils.js';

// PM2 prefixes every line with `log_date_format` (`YYYY-MM-DDTHH:mm:ss.SSSZ`
// in ecosystem.config.cjs, so the offset form `-07:00`) followed by `: `.
const PM2_LINE_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?):\s?/;
const HOME_SEGMENT = /\/(Users|home)\/(?!<user>)[^/\s"'`]+/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Double and curly quotes carry interpolated record names (`"My Universe"`).
// Single quotes stay: they mostly wrap identifiers (`reading 'foo'`) the
// investigator needs to find the emitting code.
const QUOTED_TEXT = /"[^"\n]{1,200}"|“[^”\n]{1,200}”/g;
// Filesystem paths only: rooted at a home/system/data directory, relative
// (`~/`, `./`, `../`), or ending in a file extension. An API route such as
// `/api/cos/tasks` must survive, or every route error collapses into one
// fingerprint.
const FILESYSTEM_PATH = /(?<![\w.~-])(?:(?:~|\.{1,2})\/[^\s:'"`)\]]+|\/(?:Users|home|tmp|var|private|opt|Volumes|mnt|usr|etc|Library|root|srv|media|data)\/[^\s:'"`)\]]*|\/(?:[\w.@<>-]+\/)*[\w@<>-]+\.[A-Za-z][\w]{0,5}\b)/g;
const ENTRY_MAX_CONTINUATION_LINES = 12;
export const TEMPLATE_MAX_CHARS = 300;
const SEARCH_EXCERPT_MIN_CHARS = 20;

/** `{ timestamp, body }` for one raw log line; `timestamp` is ISO or null. */
function parseLogLine(line) {
  const text = String(line ?? '').replace(/\r$/, '');
  const match = PM2_LINE_PREFIX.exec(text);
  if (!match) return { timestamp: null, body: text };
  const ms = Date.parse(match[1]);
  return { timestamp: Number.isFinite(ms) ? new Date(ms).toISOString() : null, body: text.slice(match[0].length) };
}

// A stack frame, an indented continuation, or a closing bracket of a printed
// object belongs to the entry above it rather than starting a new fault.
const isContinuation = (body) => /^\s/.test(body) || /^(at |\.\.\. \d+ more|Caused by:|[}\])])/.test(body);

/**
 * Group raw stderr text into entries: a head line plus the stack/continuation
 * lines under it. Blank lines are dropped. Continuations are capped so one
 * dumped object cannot balloon a record.
 */
export function groupStderrEntries(text) {
  const entries = [];
  for (const raw of String(text ?? '').split('\n')) {
    const { timestamp, body } = parseLogLine(raw);
    if (!body.trim()) continue;
    const current = entries[entries.length - 1];
    if (current && isContinuation(body)) {
      if (current.continuation.length < ENTRY_MAX_CONTINUATION_LINES) current.continuation.push(body);
      continue;
    }
    entries.push({ timestamp, head: body, continuation: [] });
  }
  return entries;
}

/**
 * Remove machine identity, PII, credentials and record names from log text
 * before it reaches an agent prompt or the issue tracker.
 *
 * `extraTerms` are install-specific literals the generic patterns cannot know
 * (this machine's hostname, the OS username); each is replaced wherever it
 * appears as a whole word. Terms shorter than 3 characters are ignored so a
 * one-letter username cannot shred the text.
 */
function redactLogText(text, { extraTerms = [] } = {}) {
  if (typeof text !== 'string' || !text) return '';
  // UUIDs first: the phone-number pattern would otherwise eat their tail.
  let out = text.replace(UUID, '<uuid>');
  out = redactOutput(out);
  out = scrubSecretTokens(out);
  // `redactPii` anchors home paths on whitespace/quotes; stack frames print
  // them as `file:///Users/<name>/…`, so drop the username segment anywhere.
  out = out.replace(HOME_SEGMENT, '/$1/<user>');
  out = redactPii(out);
  out = out.replace(QUOTED_TEXT, (quoted) => `${quoted[0]}<redacted>${quoted[quoted.length - 1]}`);
  for (const term of extraTerms) {
    if (typeof term !== 'string' || term.trim().length < 3) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(term.trim())}(?![A-Za-z0-9_-])`, 'gi'), '<redacted>');
  }
  return out;
}

/**
 * Reduce one REDACTED head line to the template its recurrences share:
 * timestamps, UUIDs, hex SHAs, CoS agent/task ids, absolute paths and numbers
 * become placeholders, whitespace collapses, and the result is bounded.
 */
function normalizeLogTemplate(head) {
  return String(head ?? '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(UUID, '<uuid>')
    .replace(/\b(?:agent|task|sys|self-improve|run|job|req)-[A-Za-z0-9][A-Za-z0-9-]*/gi, (m) => `${m.split('-')[0].toLowerCase()}-<id>`)
    .replace(FILESYSTEM_PATH, '<path>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<sha>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEMPLATE_MAX_CHARS);
}

/** Stable 16-hex fingerprint of a template. */
function fingerprintTemplate(template) {
  return createHash('sha256').update(String(template ?? '')).digest('hex').slice(0, 16);
}

/**
 * The longest literal stretch of a template, for a tracker phrase search.
 * Placeholders, emoji and punctuation runs are boundaries. Returns null when
 * no stretch is distinctive enough (under 20 characters) to search on — a
 * vague query would match unrelated issues and suppress a real investigation.
 */
export function templateSearchExcerpt(template, maxChars = 80) {
  const pieces = String(template ?? '')
    .split(/<[a-z]+>|["“”`]|[^\p{L}\p{N}\s:,.'()_-]/u)
    .map((piece) => piece.replace(/\s+/g, ' ').replace(/^[\s:,.'()_-]+|[\s:,.'()_-]+$/g, ''))
    .filter(Boolean);
  const best = pieces.reduce((longest, piece) => (piece.length > longest.length ? piece : longest), '');
  if (best.length < SEARCH_EXCERPT_MIN_CHARS) return null;
  if (best.length <= maxChars) return best;
  const cut = best.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace >= SEARCH_EXCERPT_MIN_CHARS ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * One entry → its redacted, fingerprinted form. `excerpt` is the redacted head
 * plus continuation lines, the only text that may leave this machine.
 */
export function fingerprintEntry(entry, { extraTerms = [] } = {}) {
  const head = redactLogText(entry?.head || '', { extraTerms });
  const template = normalizeLogTemplate(head);
  const continuation = (entry?.continuation || []).map((line) => redactLogText(line, { extraTerms }));
  return {
    fingerprint: fingerprintTemplate(template),
    template,
    excerpt: [head, ...continuation].join('\n'),
    timestamp: entry?.timestamp || null,
  };
}
