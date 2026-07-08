/**
 * Gmail full-history metadata importer (#2160) — bulk historical backfill into
 * the machine-local human-activity timeline (#2150).
 *
 * Gmail has no metadata API for the full account lifetime, but Google Takeout
 * ships the entire mailbox as an RFC-822 **mbox** file ("Mail" product export →
 * e.g. `Takeout/Mail/All mail Including Spam and Trash.mbox`). That file is
 * routinely MULTIPLE GIGABYTES — it does NOT fit the 200MB multipart upload the
 * other timeline importers use. So this importer is **path-based**: the user
 * points it at a local `.mbox` file (or the extracted `Takeout/Mail/` folder) the
 * server can already see on disk, and we STREAM it line-by-line so a 10GB mailbox
 * never has to be held in memory.
 *
 * Privacy contract (per the design doc): we parse HEADERS ONLY and store metadata
 * + a short summary line — never the message body. Each message maps to a
 * `message.sent` / `message.received` activity event under source `gmail`.
 * Direction comes from Gmail Takeout's `X-Gmail-Labels` header (which carries the
 * `Sent` label on outbound mail); an optional `yourEmail` refines it when the
 * From address matches.
 *
 * Idempotent: the dedupe key is the RFC-822 `Message-ID` (globally unique and
 * stable), so re-importing the same export — or a newer overlapping one — is a
 * no-op via `recordEvents`'s `ON CONFLICT DO NOTHING`. Messages missing a
 * Message-ID (rare — some drafts) fall back to a content hash of
 * (instant + from + subject). No AI-provider calls; parsing is deterministic and
 * LLM-free.
 */
import { createReadStream } from 'fs';
import { stat, readdir } from 'fs/promises';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { homedir } from 'os';
import path from 'path';

import { ServerError } from '../lib/errorHandler.js';
import { shortSummary, recordEvents } from './humanActivity.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects).
// ---------------------------------------------------------------------------

// Map an RFC-2047 charset token to a Node Buffer encoding. Node only ships a
// handful of built-in encodings; per the dependency policy we do NOT pull an
// iconv library for the long tail. utf-8 and latin1 cover the overwhelming
// majority of real mail headers, and latin1 preserves bytes (rather than
// throwing) for windows-125x / iso-8859-x variants, so a header still round-trips
// legibly for Western text instead of failing the whole import.
function bufferEncodingFor(charset) {
  const cs = String(charset || '').trim().toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8') return 'utf8';
  if (cs === 'utf-16' || cs === 'utf-16le' || cs === 'utf16le' || cs === 'ucs-2') return 'utf16le';
  // us-ascii / iso-8859-* / windows-125x and unknowns → latin1 (byte-preserving).
  return 'latin1';
}

// Decode RFC-2047 "encoded-word" runs (`=?charset?B?…?=` / `=?charset?Q?…?=`)
// found in Subject and display-name headers back to a plain string. Adjacent
// encoded words separated only by whitespace have that whitespace removed (per
// the spec), so a multi-part subject reassembles without stray spaces. Non-encoded
// text passes through unchanged.
export function decodeMimeWords(input) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  // Collapse the whitespace *between* two adjacent encoded words.
  s = s.replace(/\?=\s+=\?/g, '?==?');
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    const encoding = bufferEncodingFor(charset);
    if (enc.toUpperCase() === 'B') {
      return Buffer.from(text, 'base64').toString(encoding);
    }
    // Q-encoding: `_` is a space, `=XX` is a hex byte, everything else literal.
    const bytes = [];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '_') {
        bytes.push(0x20);
      } else if (ch === '=' && i + 2 < text.length) {
        const code = parseInt(text.slice(i + 1, i + 3), 16);
        if (Number.isNaN(code)) { bytes.push(ch.charCodeAt(0)); continue; }
        bytes.push(code);
        i += 2;
      } else {
        bytes.push(ch.charCodeAt(0));
      }
    }
    return Buffer.from(bytes).toString(encoding);
  });
}

// Split an address-list header value on top-level commas — a comma inside a
// quoted display name (`"Doe, John" <j@x>`) or inside angle brackets is NOT a
// separator.
function splitAddressList(value) {
  const out = [];
  let buf = '';
  let inQuote = false;
  let angle = 0;
  for (const ch of String(value)) {
    if (ch === '"') { inQuote = !inQuote; buf += ch; continue; }
    if (!inQuote && ch === '<') { angle += 1; buf += ch; continue; }
    if (!inQuote && ch === '>') { angle = Math.max(0, angle - 1); buf += ch; continue; }
    if (ch === ',' && !inQuote && angle === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// Parse one address token into { name?, email } (email lowercased), or null if
// no usable email is present. Handles `Name <email>`, `"Quoted, Name" <email>`,
// and a bare `email`.
function parseOneAddress(token) {
  const t = String(token).trim();
  if (!t) return null;
  const angle = /<([^>]*)>/.exec(t);
  let email = '';
  let name = '';
  if (angle) {
    email = angle[1].trim();
    name = t.slice(0, angle.index).trim();
  } else if (t.includes('@')) {
    email = t;
  }
  email = email.replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (!email || !email.includes('@')) return null;
  name = decodeMimeWords(name).replace(/^["']|["']$/g, '').trim();
  return name ? { name, email } : { email };
}

// Parse an address-list header value (From / To / Cc) into [{ name?, email }].
export function parseAddressList(value) {
  if (!value) return [];
  return splitAddressList(value).map(parseOneAddress).filter(Boolean);
}

// Parse a raw header block (array of lines, no leading mbox `From ` postmark)
// into ordered [{ name, value }] entries. RFC-822 folding: a line starting with
// whitespace continues the previous header.
export function parseHeaderLines(headerLines) {
  const headers = [];
  let current = null;
  for (const line of headerLines || []) {
    if (/^[ \t]/.test(line) && current) {
      current.value += ` ${line.trim()}`;
    } else {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      current = { name: line.slice(0, idx).trim().toLowerCase(), value: line.slice(idx + 1).trim() };
      headers.push(current);
    }
  }
  return headers;
}

// First value for a header name (case-insensitive), or '' if absent.
export function headerValue(headers, name) {
  const n = String(name).toLowerCase();
  const h = (headers || []).find((x) => x.name === n);
  return h ? h.value : '';
}

// Split Gmail's `X-Gmail-Labels` comma-separated label list into trimmed labels.
export function parseGmailLabels(value) {
  if (!value) return [];
  return String(value).split(',').map((l) => l.trim()).filter(Boolean);
}

// Resolve an RFC-2822 `Date` header to a UTC ISO string, or null if unparseable.
// V8's Date parses RFC-2822 dates (`Mon, 15 Jan 2024 18:30:45 -0800`) with their
// explicit offset, so no OS-timezone ambiguity to correct for.
export function resolveMboxInstant(value) {
  if (!value) return null;
  const d = new Date(String(value).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Strip the surrounding angle brackets from a `Message-ID` header.
export function cleanMessageId(value) {
  return String(value || '').replace(/[<>]/g, '').trim();
}

// Classify a message as 'sent' or 'received'. Gmail Takeout stamps outbound mail
// with the `Sent` label in `X-Gmail-Labels`; an explicit `selfEmails` match on
// the From address is authoritative when provided (covers exports where the
// label is missing). Everything else is 'received'.
export function gmailDirection(labels, fromEmail, selfEmails = []) {
  const selfSet = new Set((selfEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  if (fromEmail && selfSet.has(fromEmail)) return 'sent';
  const hasSent = (labels || []).some((l) => String(l).trim().toLowerCase() === 'sent');
  return hasSent ? 'sent' : 'received';
}

// Map ONE parsed message (its header lines) to a `message.sent`/`message.received`
// activity candidate, or null when it lacks a usable Date (a false split on a body
// line that starts with "From " has no real headers, so it drops out here). Only
// header metadata + a short recipient/sender summary are kept — never the body.
export function mboxMessageToCandidate(headerLines, { selfEmails = [] } = {}) {
  const headers = parseHeaderLines(headerLines);
  const happenedAt = resolveMboxInstant(headerValue(headers, 'date'));
  if (!happenedAt) return null;

  const messageId = cleanMessageId(headerValue(headers, 'message-id'));
  const subject = decodeMimeWords(headerValue(headers, 'subject')).trim();
  const fromList = parseAddressList(headerValue(headers, 'from'));
  const toList = parseAddressList(headerValue(headers, 'to'));
  const ccList = parseAddressList(headerValue(headers, 'cc'));
  const labels = parseGmailLabels(headerValue(headers, 'x-gmail-labels'));
  const threadId = headerValue(headers, 'x-gm-thrid') || null;

  const fromEmail = fromList[0]?.email || '';
  const direction = gmailDirection(labels, fromEmail, selfEmails);

  const selfSet = new Set((selfEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const participants = [...fromList, ...toList, ...ccList].filter((p) => p.email && !selfSet.has(p.email));

  // A message with no Message-ID (rare — some drafts) has no stable id, so hash a
  // content identity that is stable across re-imports of the same export.
  const dedupeKey = messageId
    ? `gmail:${messageId}`
    : `gmail:h:${createHash('sha1').update(`${happenedAt}|${fromEmail}|${subject}`).digest('hex').slice(0, 24)}`;

  const summary = direction === 'sent'
    ? (toList.length ? `To: ${toList.map((p) => p.name || p.email).slice(0, 3).join(', ')}` : '')
    : (fromList.length ? `From: ${fromList[0].name || fromList[0].email}` : '');

  return {
    source: 'gmail',
    kind: direction === 'sent' ? 'message.sent' : 'message.received',
    happenedAt,
    title: subject || '(no subject)',
    summary: shortSummary(summary),
    participants,
    dedupeKey,
    metadata: {
      messageId: messageId || null,
      threadId,
      labels,
      direction,
    },
  };
}

// Stateful mbox line reader. Feed lines one at a time via `push(line)`; `onMessage`
// fires with the header-line array of each complete message, and `end()` flushes
// the final message at EOF. A message boundary is a line beginning with `From `
// (the postmark — distinct from the `From:` header, which has a colon) that
// follows a blank line (or the start of file); the blank-line guard suppresses the
// common false positive of a body line that happens to start with "From ".
export function createMboxLineReader(onMessage) {
  let headerLines = [];
  let collecting = false;
  let have = false;
  let prevBlank = true;
  return {
    push(line) {
      if (prevBlank && line.startsWith('From ')) {
        if (have) onMessage(headerLines);
        headerLines = [];
        collecting = true;
        have = true;
        prevBlank = false;
        return;
      }
      if (collecting) {
        if (line === '') { collecting = false; prevBlank = true; } else { headerLines.push(line); prevBlank = false; }
      } else {
        prevBlank = (line === '');
      }
    },
    end() {
      if (!have) return;
      const lines = headerLines;
      headerLines = [];
      have = false;
      onMessage(lines);
    },
  };
}

// Parse a whole mbox TEXT string into activity candidates (pure — for tests and
// small in-memory inputs; the real importer streams a file instead of buffering).
export function parseMboxText(text, opts = {}) {
  const out = [];
  const reader = createMboxLineReader((headerLines) => {
    const cand = mboxMessageToCandidate(headerLines, opts);
    if (cand) out.push(cand);
  });
  for (const line of String(text).split(/\r?\n/)) reader.push(line);
  reader.end();
  return out;
}

// Fold a candidate into the running preview summary accumulator.
function accumulateSummary(acc, cand) {
  if (cand.happenedAt) {
    if (!acc.from || cand.happenedAt < acc.from) acc.from = cand.happenedAt;
    if (!acc.to || cand.happenedAt > acc.to) acc.to = cand.happenedAt;
  }
  if (cand.kind === 'message.sent') acc.sent += 1; else acc.received += 1;
  for (const p of cand.participants || []) {
    if (p.email) acc.correspondents.set(p.email, (acc.correspondents.get(p.email) || 0) + 1);
  }
}

function newSummaryAcc() {
  return { from: null, to: null, sent: 0, received: 0, correspondents: new Map() };
}

// Finalize the accumulator into the preview summary payload the panel renders.
function finalizeSummary(acc) {
  const topCorrespondents = [...acc.correspondents.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([email, count]) => ({ email, count }));
  return {
    messages: acc.sent + acc.received,
    sent: acc.sent,
    received: acc.received,
    from: acc.from,
    to: acc.to,
    uniqueCorrespondents: acc.correspondents.size,
    topCorrespondents,
  };
}

// ---------------------------------------------------------------------------
// Filesystem resolution + streaming ingestion.
// ---------------------------------------------------------------------------

function expandHome(p) {
  const s = String(p || '').trim();
  if (s === '~') return homedir();
  if (s.startsWith('~/')) return path.join(homedir(), s.slice(2));
  return s;
}

// Resolve the user-supplied path to a concrete list of mbox files. A directory
// (e.g. the extracted `Takeout/Mail/` folder) contributes every `*.mbox` inside
// it; a single file is taken as-is (Gmail's export is one big `.mbox`, but we
// don't force the extension so a renamed file still works).
export async function resolveMboxFiles(inputPath) {
  const resolved = path.resolve(expandHome(inputPath));
  const st = await stat(resolved).catch(() => null);
  if (!st) throw new ServerError(`No file or folder found at ${resolved}`, { status: 400, code: 'BAD_REQUEST' });
  if (st.isDirectory()) {
    const entries = await readdir(resolved);
    const mboxes = entries.filter((e) => /\.mbox$/i.test(e)).sort().map((e) => path.join(resolved, e));
    if (mboxes.length === 0) {
      throw new ServerError(`No .mbox files found in ${resolved}`, { status: 400, code: 'BAD_REQUEST' });
    }
    return mboxes;
  }
  return [resolved];
}

// Stream one mbox file, mapping each message to a candidate. `dryRun` counts +
// summarizes without writing; otherwise candidates flush to `recordEvents` in
// bounded batches so a multi-GB mailbox never accumulates every candidate in
// memory. `for await` on the readline interface applies natural backpressure while
// a batch is being written, and propagates a read error out to the caller.
const FLUSH_BATCH = 1000;
async function streamMboxFile(filePath, { dryRun, selfEmails, agg }) {
  let batch = [];
  const reader = createMboxLineReader((headerLines) => {
    agg.parsed += 1;
    const cand = mboxMessageToCandidate(headerLines, { selfEmails });
    if (!cand) return;
    agg.mapped += 1;
    accumulateSummary(agg.summary, cand);
    if (!dryRun) batch.push(cand);
  });

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    reader.push(line);
    if (!dryRun && batch.length >= FLUSH_BATCH) {
      agg.recorded += (await recordEvents(batch)).recorded;
      batch = [];
    }
  }
  reader.end();
  if (!dryRun && batch.length > 0) {
    agg.recorded += (await recordEvents(batch)).recorded;
  }
}

// End-to-end path-based import seam: resolve the mbox file(s) → stream → map →
// (preview | record). Returns counts + a preview summary. `dryRun` streams and
// summarizes WITHOUT writing so the UI can show what will land before committing.
// Because `recordEvents` is idempotent, committing (or re-committing) is safe.
export async function importGmailMbox({ path: inputPath, dryRun = false, selfEmails = [] } = {}) {
  const files = await resolveMboxFiles(inputPath);
  const self = (selfEmails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  const agg = { parsed: 0, mapped: 0, recorded: 0, summary: newSummaryAcc() };

  for (const file of files) {
    await streamMboxFile(file, { dryRun, selfEmails: self, agg });
  }

  const summary = finalizeSummary(agg.summary);
  if (dryRun) {
    console.log(`📧 Gmail mbox import preview: ${agg.mapped} message(s) from ${agg.parsed} parsed across ${files.length} file(s)`);
    return { dryRun: true, parsed: agg.parsed, mapped: agg.mapped, recorded: 0, skipped: 0, summary };
  }
  const skipped = agg.mapped - agg.recorded;
  console.log(`📧 Gmail mbox import: ${agg.recorded} new message(s) recorded, ${skipped} duplicate/invalid (from ${agg.parsed} parsed across ${files.length} file(s))`);
  return { dryRun: false, parsed: agg.parsed, mapped: agg.mapped, recorded: agg.recorded, skipped, summary };
}
