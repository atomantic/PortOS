/**
 * Discord data-package importer (#2160) — bulk historical backfill into the
 * human-activity timeline.
 *
 * Discord's "Request my data" download ships a ZIP whose `messages/` folder holds
 * ONE subfolder per channel/DM you participated in. Each subfolder carries:
 *   - `channel.json` — channel metadata `{ id, type, name?, guild?: { id, name },
 *     recipients?: [...] }` (recipients are the *other* people in a DM).
 *   - `messages.json` (2023+) or `messages.csv` (older) — an array of the messages
 *     YOU sent in that channel: `{ ID, Timestamp, Contents, Attachments }`.
 *
 * Every message in a Discord data package is authored by the account owner, so
 * the direction is unambiguous: each maps to a `message.sent` activity event
 * under source `discord`. Contents keep only a SHORT summary line (privacy
 * contract); the message id + channel id in `metadata` point back to the source.
 *
 * Idempotent: Discord message IDs are globally-unique snowflakes, so the dedupe
 * key is just `discord:<messageId>` — re-importing the same export (or a newer
 * overlapping one) is a no-op via `recordEvents`'s `ON CONFLICT DO NOTHING`. No
 * AI-provider calls; parsing is deterministic and LLM-free.
 */
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { parseZip, collectZipEntry } from '../lib/zipStream.js';
import { shortSummary, recordEvents, normalizeParticipants } from './humanActivity.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects).
// ---------------------------------------------------------------------------

// Resolve a Discord message timestamp to a UTC ISO string, or null if
// unparseable. Newer exports use ISO-8601 with an offset
// (`2023-05-01T18:30:45.123+00:00`); older CSV exports use a space-separated UTC
// wall clock (`2023-05-01 18:30:45`) — append the missing `Z` so it's read as
// UTC, not the server's OS-local zone.
export function resolveDiscordInstant(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const legacy = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  const iso = legacy ? `${legacy[1]}T${legacy[2]}Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Minimal RFC-4180 CSV parser (written in-tree to avoid a dependency for one
// helper). Handles quoted fields, escaped quotes (`""`), and embedded
// commas/newlines. Returns an array of row objects keyed by the header row.
// Discord's older `messages.csv` is exactly this shape: `ID,Timestamp,Contents,
// Attachments` with the Contents column freely containing commas and newlines.
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue; // normalize CRLF → LF
    if (ch === '\n') { row.push(field); rows.push(row); field = ''; row = []; continue; }
    field += ch;
  }
  // Flush the trailing field/row when the file doesn't end in a newline.
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const obj = {};
    header.forEach((key, idx) => { obj[key] = cols[idx] ?? ''; });
    return obj;
  });
}

// Parse the text of ONE Discord `messages.json` / `messages.csv` file into a raw
// record array. JSON is a top-level array (or `{ messages: [...] }` wrapper);
// CSV is dispatched by a leading `ID,` header. Throws only on malformed JSON.
export function parseDiscordMessagesText(text, entryPath = '') {
  const s = String(text ?? '');
  if (/\.csv$/i.test(entryPath) || /^\s*id\s*,/i.test(s)) return parseCsv(s);
  const parsed = JSON.parse(s);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.messages)) return parsed.messages;
  return [];
}

// Build a human-friendly channel label from a parsed `channel.json`. A guild
// channel reads "Guild — #channel"; a DM reads "DM with A, B"; anything else
// falls back to the channel name or id.
export function channelLabel(channel) {
  if (!channel || typeof channel !== 'object') return null;
  const guildName = channel.guild?.name;
  if (guildName) return channel.name ? `${guildName} — #${channel.name}` : guildName;
  const recips = Array.isArray(channel.recipients) ? channel.recipients : [];
  const names = recips.map((r) => (typeof r === 'string' ? r : r?.username || r?.name)).filter(Boolean);
  if (names.length) return `DM with ${names.join(', ')}`;
  return channel.name || (channel.id ? `Channel ${channel.id}` : null);
}

// Map ONE raw Discord message record (+ optional resolved channel context) to an
// activity candidate, or null if it lacks a usable id or timestamp. Column names
// come straight from Discord's export (`ID`, `Timestamp`, `Contents`,
// `Attachments`); lowercase variants are tolerated for forward-compat.
export function discordMessageToCandidate(record, channel = null) {
  if (!record || typeof record !== 'object') return null;
  const messageId = String(record.ID ?? record.id ?? '').trim();
  if (!messageId) return null;
  const happenedAt = resolveDiscordInstant(record.Timestamp ?? record.timestamp);
  if (!happenedAt) return null;

  const contents = record.Contents ?? record.contents ?? '';
  const attachmentsRaw = record.Attachments ?? record.attachments ?? '';
  const hasAttachments = Array.isArray(attachmentsRaw)
    ? attachmentsRaw.length > 0
    : Boolean(String(attachmentsRaw).trim());

  const label = channelLabel(channel);
  const channelId = channel?.id || record.channelId || null;
  // A message with no text (attachment-only) still carries autobiographical
  // signal (you sent something at this time) — keep it, with a placeholder body.
  const summaryText = String(contents).trim() || (hasAttachments ? '(attachment)' : '');

  return {
    source: 'discord',
    kind: 'message.sent',
    happenedAt,
    title: label || 'Discord message',
    summary: shortSummary(summaryText),
    participants: normalizeParticipants(
      (Array.isArray(channel?.recipients) ? channel.recipients : [])
        .map((r) => (typeof r === 'string' ? r : r?.username || r?.name))
        .filter(Boolean)
        .map((name) => ({ name })),
    ),
    dedupeKey: `discord:${messageId}`,
    metadata: {
      messageId,
      channelId,
      channelName: label,
      guildName: channel?.guild?.name || null,
      channelType: channel?.type ?? null,
      hasAttachments,
    },
  };
}

// Map a batch of { record, channel } intermediates to candidates, dropping the
// unmappable ones.
export function discordActivityCandidates(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => discordMessageToCandidate(it.record, it.channel)).filter(Boolean);
}

// Summarize a candidate batch for the import preview: date range, message count,
// unique channels, and the most-active channel labels. Pure over candidates.
export function summarizeDiscordCandidates(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  let earliest = null;
  let latest = null;
  // Key BOTH the unique count and the top-channels tally by the same channel
  // identity (id when present, else the label) so they can't diverge — two
  // distinct channels that happen to share a display label stay two entries.
  // The display label is carried alongside the count for rendering.
  const channelStats = new Map(); // identity → { name, count }
  for (const c of list) {
    if (c.happenedAt) {
      if (!earliest || c.happenedAt < earliest) earliest = c.happenedAt;
      if (!latest || c.happenedAt > latest) latest = c.happenedAt;
    }
    const identity = c.metadata?.channelId || c.metadata?.channelName || c.title;
    const name = c.metadata?.channelName || c.title;
    const stat = channelStats.get(identity);
    if (stat) stat.count += 1;
    else channelStats.set(identity, { name, count: 1 });
  }
  const topChannels = [...channelStats.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    messages: list.length,
    uniqueChannels: channelStats.size,
    from: earliest,
    to: latest,
    topChannels,
  };
}

// ---------------------------------------------------------------------------
// File ingestion (ZIP data package or single messages JSON/CSV) → intermediates.
// ---------------------------------------------------------------------------

const isZip = (file) =>
  file?.mimetype === 'application/zip' ||
  file?.mimetype === 'application/x-zip-compressed' ||
  /\.zip$/i.test(file?.originalname || '');

// The directory token identifying a channel within the package (`messages/c123/…`
// or the newer `messages/123/…`) — the grouping key that joins a channel's
// `channel.json` to its `messages.(json|csv)`.
const channelDirOf = (entryPath) => {
  const m = /(?:^|\/)messages\/([^/]+)\/(?:messages\.(?:json|csv)|channel\.json)$/i.exec(String(entryPath || ''));
  return m ? m[1] : null;
};
const isMessagesEntry = (entryPath) => /(?:^|\/)messages\/[^/]+\/messages\.(?:json|csv)$/i.test(String(entryPath || ''));
const isChannelJsonEntry = (entryPath) => /(?:^|\/)messages\/[^/]+\/channel\.json$/i.test(String(entryPath || ''));

// Extract { record, channel } intermediates from the Discord data-package ZIP.
// Both the per-channel `channel.json` and `messages.*` files are collected into
// per-directory maps (either may stream first), then joined after close so every
// message carries its channel's context.
async function readItemsFromZip(filePath) {
  const channels = new Map(); // dir → parsed channel.json
  const messagesByDir = new Map(); // dir → raw message records[]
  const reads = [];
  await new Promise((resolve, reject) => {
    let settled = false;
    const src = createReadStream(filePath);
    const parser = parseZip();
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      // On failure, tear down the read + parse pipeline so a large upload with an
      // early error (bad JSON member, corrupt ZIP) doesn't keep reading to EOF.
      if (fn === reject) { src.destroy(); parser.destroy?.(); }
      fn(...args);
    };
    src.on('error', settle(reject));
    src
      .pipe(parser)
      .on('entry', (entry) => {
        const dir = channelDirOf(entry.path);
        if (dir && isMessagesEntry(entry.path)) {
          const entryPath = entry.path;
          reads.push(
            collectZipEntry(entry)
              .then((buf) => {
                const recs = parseDiscordMessagesText(buf.toString('utf-8'), entryPath);
                const existing = messagesByDir.get(dir) || [];
                messagesByDir.set(dir, existing.concat(recs));
              })
              .catch(settle(reject)),
          );
        } else if (dir && isChannelJsonEntry(entry.path)) {
          reads.push(
            collectZipEntry(entry)
              .then((buf) => { channels.set(dir, JSON.parse(buf.toString('utf-8'))); })
              .catch(settle(reject)),
          );
        } else {
          entry.autodrain();
        }
      })
      .on('close', () => Promise.all(reads).then(settle(resolve)).catch(settle(reject)))
      .on('error', settle(reject));
  });
  const items = [];
  for (const [dir, recs] of messagesByDir) {
    const channel = channels.get(dir) || null;
    for (const record of recs) items.push({ record, channel });
  }
  return items;
}

// Read { record, channel } intermediates from an uploaded file (the full ZIP
// data package, or a single `messages.json` / `messages.csv` with no channel
// context).
export async function readDiscordItems(file) {
  if (!file?.path) return [];
  if (isZip(file)) return readItemsFromZip(file.path);
  const text = await readFile(file.path, 'utf-8');
  return parseDiscordMessagesText(text, file.originalname || '').map((record) => ({ record, channel: null }));
}

// End-to-end import seam: read the file → map → (preview | record). Returns
// counts + a preview summary. `dryRun` parses and summarizes WITHOUT writing so
// the UI can show the user what will be imported before they commit. Because
// `recordEvents` is idempotent, committing (or re-committing) is always safe.
export async function importDiscordHistory(file, { dryRun = false } = {}) {
  const items = await readDiscordItems(file);
  const candidates = discordActivityCandidates(items);
  const summary = summarizeDiscordCandidates(candidates);
  if (dryRun) {
    console.log(`💬 Discord import preview: ${candidates.length} message(s) from ${items.length} record(s)`);
    return { dryRun: true, parsed: items.length, mapped: candidates.length, recorded: 0, skipped: 0, summary };
  }
  const { recorded, skipped } = await recordEvents(candidates);
  console.log(`💬 Discord import: ${recorded} new message(s) recorded, ${skipped} duplicate/invalid (from ${items.length} record(s))`);
  return { dryRun: false, parsed: items.length, mapped: candidates.length, recorded, skipped, summary };
}
