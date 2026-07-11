/**
 * WhatsApp chat-export importer (#2160) — bulk historical backfill into the
 * human-activity timeline.
 *
 * WhatsApp's "Export chat" (per-conversation: chat → ⋯ → More → Export chat)
 * produces either a single `_chat.txt` / `WhatsApp Chat with <name>.txt`, or a
 * ZIP bundling that `_chat.txt` alongside any exported media. Each text line is a
 * timestamped message:
 *
 *   iOS:      `[2024-01-15, 6:30:45 PM] Alice: hey there`
 *   Android:  `1/15/24, 6:30 PM - Alice: hey there`
 *
 * A message body may span multiple lines; continuation lines carry no timestamp
 * header and are folded back into the preceding message. System notices ("…are
 * end-to-end encrypted", "Alice created group …") have no `Sender: ` segment and
 * are skipped — they aren't activity the user authored or received.
 *
 * Direction (sent vs received) is NOT marked in a WhatsApp export — every line
 * carries the sender's saved display name, with no flag for "you". The importer
 * therefore takes an OPTIONAL `yourName`: when supplied, a line whose sender
 * matches it (case-insensitive, trimmed) becomes a `message.sent` event and every
 * other line a `message.received` event (the same kinds the email importer uses);
 * when omitted, each message stays a neutral `message` event under source
 * `whatsapp`. The sender is always kept in `participants`/`metadata`. Direction is
 * NOT part of the dedupe key, so re-importing the same export with a `yourName`
 * this time inserts nothing over an earlier neutral import (the rows already
 * exist) — clearing the source's events and re-importing applies the new
 * classification.
 *
 * Timestamps are LOCAL wall-clock with no offset — unlike the UTC Spotify/Discord
 * exports — so they're interpreted in the user's configured timezone via
 * `resolveEventInstant`, the same anchor the calendar importer uses for
 * offset-less values.
 *
 * Idempotent: WhatsApp lines carry no message id, so the dedupe key is a stable
 * content hash of (instant, sender, body). Re-importing the same or an overlapping
 * export is a no-op via `recordEvents`'s `ON CONFLICT DO NOTHING`. No AI-provider
 * calls; parsing is deterministic and LLM-free.
 *
 * The importer also takes an OPTIONAL `chatLabel`: a stable, user-supplied name for
 * the conversation (e.g. "Family group"). WhatsApp exports carry no stable chat id
 * — the filename is unstable (zip vs extracted `_chat.txt`, renames) — so absent a
 * label the dedupe key is deliberately NOT chat-scoped, which means two DIFFERENT
 * chats that happen to contain a same-named sender sending an identical body at the
 * same timestamp granularity collapse into one event. Supplying `chatLabel`
 * prefixes the hash with that stable scope, so those cross-chat collisions no longer
 * merge — while a blank label preserves the byte-identical legacy key (backward
 * compatible). Because the label participates in the key, a chat must be labelled
 * CONSISTENTLY across re-imports (an unlabelled import and a labelled one of the same
 * chat are distinct identities); the label also becomes the display chat title.
 */
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { collectZipEntries, isZipUpload } from '../lib/zipStream.js';
import { shortSummary, recordEvents, resolveEventInstant } from './humanActivity.js';
import { getUserTimezone } from '../lib/timezone.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects).
// ---------------------------------------------------------------------------

// Bidi marks WhatsApp (iOS especially) injects around timestamps, senders, and
// media placeholders; stripped so they can't leak into the parsed fields.
const BIDI_MARKS = /[‎‏‪-‮]/g;

// One message-line header: an optional `[`, a date (three numeric groups in some
// order), a time (12h with AM/PM or 24h), an optional `]`, and an optional
// Android ` - ` separator, then the remainder ("Sender: body" or a system line).
// The capture groups are (d1, d2, d3, hour, minute, second?, ampm?, rest).
const HEADER_RE = /^\[?\s*(\d{1,4})[.\/-](\d{1,2})[.\/-](\d{1,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s*\]?\s*(?:[-–]\s+)?(.*)$/;

// Convert a 12h clock + AM/PM token to a 0–23 hour. A 24h line (no token) passes
// through unchanged. 12 AM → 0, 12 PM → 12.
function to24Hour(hour, ampm) {
  const h = Number(hour);
  if (!ampm) return h;
  const pm = /p/i.test(ampm);
  if (pm) return h === 12 ? 12 : h + 12; // 12 PM stays 12; 1–11 PM → +12
  return h === 12 ? 0 : h; // 12 AM → 0; 1–11 AM unchanged
}

// Split the post-timestamp remainder into { sender, body, isSystem }. A real
// message is `Sender: body`; the sender segment must be a single line with no
// embedded colon-space (display names don't contain ": "). Anything else is a
// system notice (encryption info, group membership changes, "You deleted…").
function splitSenderBody(rest) {
  const idx = rest.indexOf(': ');
  if (idx === -1) return { sender: null, body: rest, isSystem: true };
  const sender = rest.slice(0, idx).trim();
  if (!sender || sender.includes('\n')) return { sender: null, body: rest, isSystem: true };
  return { sender, body: rest.slice(idx + 2), isSystem: false };
}

// Parse a full `_chat.txt` into raw messages. Continuation lines (no header) fold
// into the previous message's body. Numeric date groups are kept UN-ordered here
// (mdy vs dmy is a per-file property resolved by detectDateOrder); the time is
// already normalized to a 24h hour.
export function parseWhatsappChat(text) {
  const messages = [];
  const lines = String(text ?? '').replace(BIDI_MARKS, '').split(/\r?\n/);
  for (const line of lines) {
    const m = HEADER_RE.exec(line);
    if (!m) {
      // Continuation of a multi-line message body.
      if (messages.length) messages[messages.length - 1].body += `\n${line}`;
      continue;
    }
    const [, d1, d2, d3, hour, minute, second, ampm, rest] = m;
    const { sender, body, isSystem } = splitSenderBody(rest);
    messages.push({
      d1: Number(d1),
      d2: Number(d2),
      d3: Number(d3),
      hour24: to24Hour(hour, ampm),
      minute: Number(minute),
      second: second ? Number(second) : 0,
      sender,
      body,
      isSystem,
    });
  }
  return messages;
}

// Infer the file's date component order from the parsed messages. WhatsApp writes
// the phone's locale format, so the whole file shares one order. A 4-digit first
// group is unambiguously year-first; otherwise a first group >12 forces D/M and a
// second group >12 forces M/D. Ambiguous files (all components ≤12) default to
// M/D/Y — the US/iOS default — which is the safest single guess.
export function detectDateOrder(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  for (const m of list) if (m.d1 >= 1000) return 'ymd';
  for (const m of list) if (m.d1 > 12) return 'dmy';
  for (const m of list) if (m.d2 > 12) return 'mdy';
  return 'mdy';
}

// Resolve a message's numeric date groups to a { year, month, day } under the
// given order, normalizing a 2-digit year to 20xx (WhatsApp postdates 2009).
function resolveYmd(msg, order) {
  let year;
  let month;
  let day;
  if (order === 'ymd') { [year, month, day] = [msg.d1, msg.d2, msg.d3]; }
  else if (order === 'dmy') { [day, month, year] = [msg.d1, msg.d2, msg.d3]; }
  else { [month, day, year] = [msg.d1, msg.d2, msg.d3]; }
  if (year < 100) year += 2000;
  return { year, month, day };
}

// A body that's only a media placeholder ("<Media omitted>", "image omitted",
// "‎<attached: …>") still carries autobiographical signal (you sent/received
// something then) — flagged so the summary can show a placeholder rather than an
// empty line. Anchored to the actual placeholder shapes (the whole body IS the
// placeholder, or an `<attached:` token) so a normal message that merely contains
// the word "omitted" ("I omitted that detail") isn't mis-flagged.
const MEDIA_RE = /^\s*(<[^>]*\bomitted\b[^>]*>|(?:image|video|audio|gif|sticker|document|contact card|media)\s+omitted|<attached:[^>]*>)\s*$|<attached:/i;

// Normalize a display name for direction matching: trimmed + lower-cased, or ''
// for a non-string / empty value (never matches a real sender).
export function normalizeName(name) {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}

// Normalize a user-supplied chat label into a stable dedupe scope: trimmed +
// lower-cased so "Family Group" and " family group " scope to the same chat, or ''
// for a non-string / empty value (→ the legacy, un-scoped dedupe key). Reuses the
// same normalization as `normalizeName` so the label is stable across casing/space.
export function normalizeChatScope(label) {
  return normalizeName(label);
}

// Map ONE raw WhatsApp message to an activity candidate, or null if it's a system
// notice, lacks a sender, or has an unresolvable timestamp. `timezone` anchors the
// offset-less local wall-clock; `chatTitle` labels the conversation. `yourName`
// (optional) classifies direction: a sender matching it → `message.sent`, others
// → `message.received`; when absent, the event stays a neutral `message`.
// `chatScope` (optional) is a stable user-supplied chat name folded into the dedupe
// key so distinct chats don't collide; absent → the legacy un-scoped key.
export function whatsappMessageToCandidate(msg, { order = 'mdy', chatTitle = null, timezone = null, yourName = null, chatScope = null } = {}) {
  if (!msg || msg.isSystem || !msg.sender) return null;
  const { year, month, day } = resolveYmd(msg, order);
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    + `T${String(msg.hour24).padStart(2, '0')}:${String(msg.minute).padStart(2, '0')}:${String(msg.second).padStart(2, '0')}`;
  const instant = resolveEventInstant(iso, timezone);
  if (!instant) return null;
  const happenedAt = instant.toISOString();

  const bodyText = String(msg.body ?? '').trim();
  const hasMedia = MEDIA_RE.test(bodyText);
  const title = chatTitle ? `WhatsApp: ${chatTitle}` : 'WhatsApp message';
  const summaryText = bodyText || (hasMedia ? '(media)' : '');

  // No message id in the export — hash the message's CONTENT identity (instant +
  // sender + body) so re-imports collapse deterministically. Deliberately NOT
  // keyed on chatTitle: that's derived from the upload filename, which differs
  // between a `WhatsApp Chat - Alice.zip` and the bare `_chat.txt` extracted from
  // it (and changes on any rename), so keying on it would double-count the whole
  // conversation across those equivalent uploads. Two identical bodies from the
  // same sender at the same timestamp granularity are indistinguishable in the
  // file, so collapsing them is correct — same precedent as the Spotify importer's
  // played-at+track key. The granularity is the export's own: iOS carries seconds,
  // but Android lines have none (second defaults to 0), so two identical Android
  // messages within the same clock-MINUTE collapse to one event.
  //
  // Cross-chat collision residual: without a chat scope, two DIFFERENT chats that
  // each contain a same-named sender sending the same body at the same timestamp
  // granularity collapse to one event. The filename-derived chatTitle can't be the
  // scope (it's unstable across zip-vs-extracted uploads and renames). The optional
  // `chatScope` (a stable, user-supplied chat name) closes this: when present it is
  // prefixed into the hash ahead of the ISO instant, separated by a NUL (`\u0000`)
  // that can't occur in a normalized display name, so the two chats key apart with
  // no delimiter ambiguity. When absent the hash input is byte-identical to the
  // legacy key, so unlabelled imports (and their idempotency) are unchanged.
  const scope = normalizeChatScope(chatScope);
  const hashInput = scope
    ? `${scope}\u0000${happenedAt} ${msg.sender} ${bodyText}`
    : `${happenedAt} ${msg.sender} ${bodyText}`;
  const dedupeKey = createHash('sha1')
    .update(hashInput)
    .digest('hex')
    .slice(0, 24);

  // Direction: match the sender against `yourName` (if given) to pick sent vs
  // received; a neutral `message` when no name is supplied. Deliberately NOT part
  // of the dedupe key (see the file header) so re-importing with a name over an
  // earlier neutral import is a no-op rather than a duplicate.
  const normalizedYou = normalizeName(yourName);
  const isSelf = normalizedYou !== '' && normalizeName(msg.sender) === normalizedYou;
  const kind = normalizedYou === '' ? 'message' : (isSelf ? 'message.sent' : 'message.received');

  return {
    source: 'whatsapp',
    kind,
    happenedAt,
    title,
    summary: shortSummary(summaryText),
    participants: [{ name: msg.sender }],
    dedupeKey: `whatsapp:${dedupeKey}`,
    metadata: {
      chatTitle: chatTitle || null,
      chatScope: scope || null,
      sender: msg.sender,
      hasMedia,
      dateOrder: order,
      direction: normalizedYou === '' ? null : (isSelf ? 'sent' : 'received'),
    },
  };
}

// Map a full parsed chat to candidates: detect the date order once, then map +
// filter every message under it. `yourName` (optional) classifies direction;
// `chatScope` (optional) scopes the dedupe key to a stable user-supplied chat name.
export function whatsappActivityCandidates(messages = [], { chatTitle = null, timezone = null, yourName = null, chatScope = null } = {}) {
  if (!Array.isArray(messages)) return [];
  const order = detectDateOrder(messages);
  return messages
    .map((msg) => whatsappMessageToCandidate(msg, { order, chatTitle, timezone, yourName, chatScope }))
    .filter(Boolean);
}

// Summarize a candidate batch for the import preview: message count, unique
// senders, date range, and the most-active senders. Pure over candidates.
export function summarizeWhatsappCandidates(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  let earliest = null;
  let latest = null;
  let sent = 0;
  let received = 0;
  const senderCounts = new Map();
  for (const c of list) {
    if (c.happenedAt) {
      if (!earliest || c.happenedAt < earliest) earliest = c.happenedAt;
      if (!latest || c.happenedAt > latest) latest = c.happenedAt;
    }
    if (c.metadata?.direction === 'sent') sent += 1;
    else if (c.metadata?.direction === 'received') received += 1;
    const sender = c.metadata?.sender || c.participants?.[0]?.name;
    if (sender) senderCounts.set(sender, (senderCounts.get(sender) || 0) + 1);
  }
  const topSenders = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return {
    messages: list.length,
    uniqueSenders: senderCounts.size,
    from: earliest,
    to: latest,
    topSenders,
    // sent/received are 0 when no `yourName` was supplied (all neutral); the UI
    // only shows the breakdown when a direction was actually classified.
    sent,
    received,
    directionKnown: sent > 0 || received > 0,
    chatTitle: list[0]?.metadata?.chatTitle || null,
  };
}

// Derive a human chat title from the uploaded file name. WhatsApp names direct
// exports `WhatsApp Chat with Alice.txt` / `WhatsApp Chat - Alice.zip`; the
// in-ZIP text is always the anonymous `_chat.txt` (→ no title). Returns null when
// nothing meaningful can be extracted.
export function deriveChatTitle(fileName) {
  if (!fileName) return null;
  const base = String(fileName).replace(/\.[^.]+$/, '').trim();
  if (!base || /^_chat$/i.test(base)) return null;
  const m = /^whatsapp chat(?:\s+with|\s*[-–])?\s*(.+)$/i.exec(base);
  const title = (m ? m[1] : base).trim();
  return title || null;
}

// ---------------------------------------------------------------------------
// File ingestion (single `.txt` or an "Export chat" ZIP) → chat text.
// ---------------------------------------------------------------------------

// The chat transcript inside an "Export chat" ZIP is `_chat.txt`; older/renamed
// exports may name it `WhatsApp Chat with X.txt`. Prefer `_chat.txt`, else the
// first `.txt` member.
const isChatTxtEntry = (entryPath) => /(?:^|\/)_chat\.txt$/i.test(String(entryPath || ''));
const isAnyTxtEntry = (entryPath) => /\.txt$/i.test(String(entryPath || ''));

// Extract the chat transcript text from an "Export chat" ZIP. Media entries are
// drained and ignored. Resolves to the transcript string ('' if none found).
// The `match` closes over `fallback` so only the preferred `_chat.txt` plus the
// first other `.txt` are collected; `collectZipEntries` owns teardown/autodrain.
async function readTextFromZip(filePath) {
  let preferred = null; // _chat.txt
  let fallback = null; // first other .txt
  await collectZipEntries(filePath, {
    match: (entryPath) => isChatTxtEntry(entryPath) || (isAnyTxtEntry(entryPath) && fallback === null),
    onMatch: (buf, entryPath) => {
      if (isChatTxtEntry(entryPath)) preferred = buf.toString('utf-8');
      else if (fallback === null) fallback = buf.toString('utf-8');
    },
  });
  return preferred ?? fallback ?? '';
}

// Read the chat transcript text from an uploaded file (a single `.txt` or an
// "Export chat" ZIP).
export async function readWhatsappText(file) {
  if (!file?.path) return '';
  if (isZipUpload(file)) return readTextFromZip(file.path);
  return readFile(file.path, 'utf-8');
}

// End-to-end import seam: read the file → parse → map → (preview | record).
// Returns counts + a preview summary. `dryRun` parses and summarizes WITHOUT
// writing so the UI can show what will be imported before committing. Because
// `recordEvents` is idempotent, committing (or re-committing) is always safe.
export async function importWhatsappHistory(file, { dryRun = false, yourName = null, chatLabel = null } = {}) {
  const text = await readWhatsappText(file);
  const messages = parseWhatsappChat(text);
  const timezone = await getUserTimezone();
  // A user-supplied chat label (when given) is both the stable dedupe scope AND the
  // display title, overriding the unstable filename-derived one; absent → fall back
  // to the filename-derived title with no dedupe scope (legacy behavior).
  const label = typeof chatLabel === 'string' ? chatLabel.trim() : '';
  const chatTitle = label || deriveChatTitle(file?.originalname);
  const candidates = whatsappActivityCandidates(messages, { chatTitle, timezone, yourName, chatScope: label });
  const summary = summarizeWhatsappCandidates(candidates);
  if (dryRun) {
    console.log(`💬 WhatsApp import preview: ${candidates.length} message(s) from ${messages.length} line-record(s)`);
    return { dryRun: true, parsed: messages.length, mapped: candidates.length, recorded: 0, skipped: 0, summary };
  }
  const { recorded, skipped } = await recordEvents(candidates);
  console.log(`💬 WhatsApp import: ${recorded} new message(s) recorded, ${skipped} duplicate/invalid (from ${messages.length} line-record(s))`);
  return { dryRun: false, parsed: messages.length, mapped: candidates.length, recorded, skipped, summary };
}
