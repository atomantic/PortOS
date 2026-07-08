/**
 * Browser history importer (#2160) — bulk historical backfill into the
 * human-activity timeline.
 *
 * Chrome/Edge (and any Chromium browser) have no in-app "export history" button,
 * but Google Takeout ships the full history as JSON: the "Chrome" product export
 * contains `Chrome/History.json` (older vintages name it `BrowserHistory.json`)
 * whose shape is:
 *
 *   { "Browser History": [
 *       { "page_transition": "LINK", "title": "Example",
 *         "url": "https://example.com/", "client_id": "…",
 *         "time_usec": 1699999999000000 },
 *       …
 *   ] }
 *
 * `time_usec` is MICROSECONDS since the Unix epoch (UTC) — Takeout normalizes the
 * raw Chrome 1601-epoch value for us, so we just divide by 1000 for ms. Each entry
 * maps to a `web.visit` activity event under source `browser`. The full URL lands
 * in the row's `url` column; the summary keeps only the hostname (privacy
 * contract — no query strings in the preview line, the full URL stays in `url`).
 *
 * Subframe navigations (`AUTO_SUBFRAME` / `MANUAL_SUBFRAME` — ad/embed iframe
 * loads Chrome records alongside real navigations) carry no autobiographical "I
 * visited this" signal, so they're dropped the same way the location importer
 * drops travel segments.
 *
 * Idempotent: a visit has no stable id in the export, so the dedupe key is a
 * content hash of (visit instant + URL). Re-importing the same export — or a
 * newer overlapping one — is a no-op via `recordEvents`'s `ON CONFLICT DO
 * NOTHING`. No AI-provider calls; parsing is deterministic and LLM-free.
 */
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { parseZip, collectZipEntry } from '../lib/zipStream.js';
import { shortSummary, recordEvents } from './humanActivity.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects).
// ---------------------------------------------------------------------------

// Resolve a Takeout `time_usec` (microseconds since the Unix epoch) to a UTC ISO
// string, or null if unparseable / non-positive. A blank/nullish/zero value has
// no usable instant. Accepts a numeric string too (Takeout sometimes stringifies
// the large integer).
export function resolveHistoryInstant(timeUsec) {
  if (timeUsec === null || timeUsec === undefined || timeUsec === '') return null;
  const n = Number(timeUsec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(Math.round(n / 1000));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Normalize a page_transition token to an UPPER_SNAKE string, or null.
export function normalizeTransition(transition) {
  if (!transition) return null;
  const s = String(transition).trim().toUpperCase();
  return s || null;
}

// Subframe transitions are iframe/embed loads (ads, widgets), not pages the user
// navigated to — dropped as noise. Matches the two Chromium subframe types.
export function isSubframeTransition(transition) {
  const t = normalizeTransition(transition);
  return t === 'AUTO_SUBFRAME' || t === 'MANUAL_SUBFRAME';
}

// Hostname of an http(s) URL, or null for a non-web scheme (chrome://, about:,
// file:) or a malformed value. Uses URL.canParse so a bad value returns null
// instead of throwing and failing the whole import; restricting to http(s) keeps
// internal browser pages from surfacing a junk "host" (e.g. chrome://newtab →
// "newtab") in the summary line.
export function hostnameOf(url) {
  const s = String(url || '').trim();
  if (!s || !URL.canParse(s)) return null;
  const parsed = new URL(s);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.hostname || null;
}

// Map ONE raw Browser-History record to an activity candidate, or null if it
// lacks a URL / usable timestamp, or is a subframe (iframe) load.
export function historyVisitToCandidate(record) {
  if (!record || typeof record !== 'object') return null;
  const url = String(record.url ?? '').trim();
  if (!url) return null;
  const happenedAt = resolveHistoryInstant(record.time_usec ?? record.timeUsec);
  if (!happenedAt) return null;
  const transition = normalizeTransition(record.page_transition ?? record.pageTransition);
  if (isSubframeTransition(transition)) return null;

  const host = hostnameOf(url);
  const title = String(record.title ?? '').trim() || host || url;

  // No visit id in the export — hash the visit's CONTENT identity (instant + URL)
  // so re-imports collapse deterministically. Two identical URLs at the same
  // microsecond are indistinguishable in the file (and can't happen in practice),
  // so collapsing them is correct — same precedent as the location importer's
  // visit-start + place key.
  const dedupeKey = createHash('sha1')
    .update(`${happenedAt} ${url}`)
    .digest('hex')
    .slice(0, 24);

  return {
    source: 'browser',
    kind: 'web.visit',
    happenedAt,
    title,
    summary: host ? shortSummary(host) : null,
    url,
    dedupeKey: `browser:${dedupeKey}`,
    metadata: {
      host: host || null,
      transition: transition || null,
    },
  };
}

// Extract the raw Browser-History records from ONE parsed history JSON object,
// handling the `{ "Browser History": [...] }` wrapper and a bare top-level array.
// Other Takeout `History.json` keys (e.g. "Favicons") are ignored.
export function extractHistoryRecords(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed['Browser History'])) return parsed['Browser History'];
  if (Array.isArray(parsed.browserHistory)) return parsed.browserHistory;
  return [];
}

// Map a batch of raw records to candidates, dropping the unmappable ones.
export function browserHistoryCandidates(records = []) {
  if (!Array.isArray(records)) return [];
  return records.map(historyVisitToCandidate).filter(Boolean);
}

// Summarize a candidate batch for the import preview: visit count, unique hosts
// (domains), date range, and the most-visited domains. Pure over candidates.
export function summarizeBrowserCandidates(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  let earliest = null;
  let latest = null;
  const hostCounts = new Map();
  for (const c of list) {
    if (c.happenedAt) {
      if (!earliest || c.happenedAt < earliest) earliest = c.happenedAt;
      if (!latest || c.happenedAt > latest) latest = c.happenedAt;
    }
    const host = c.metadata?.host;
    if (host) hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
  }
  const topHosts = [...hostCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return {
    visits: list.length,
    uniqueHosts: hostCounts.size,
    from: earliest,
    to: latest,
    topHosts,
  };
}

// Parse the text of a single history JSON file into a parsed object. Throws only
// on malformed JSON; `extractHistoryRecords` handles the shape dispatch.
export function parseHistoryJsonText(text) {
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// File ingestion (ZIP or single JSON) → raw records.
// ---------------------------------------------------------------------------

const isZip = (file) =>
  file?.mimetype === 'application/zip' ||
  file?.mimetype === 'application/x-zip-compressed' ||
  /\.zip$/i.test(file?.originalname || '');

// A Chrome history JSON member inside the Takeout ZIP: `Chrome/History.json`
// (2024+) or the older `BrowserHistory.json`. The distinctive filename lets us
// skip every other product's JSON in a full Takeout archive.
const isHistoryJsonEntry = (entryPath) =>
  /(?:^|\/)(?:Browser)?History\.json$/i.test(String(entryPath || ''));

// Extract and concatenate the raw records from every history JSON member of the
// Takeout ZIP. Non-matching entries are drained and ignored.
async function readRecordsFromZip(filePath) {
  const records = [];
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
        if (isHistoryJsonEntry(entry.path)) {
          reads.push(
            collectZipEntry(entry)
              .then((buf) => {
                for (const r of extractHistoryRecords(parseHistoryJsonText(buf.toString('utf-8')))) records.push(r);
              })
              .catch(settle(reject)),
          );
        } else {
          entry.autodrain();
        }
      })
      .on('close', () => Promise.all(reads).then(settle(resolve)).catch(settle(reject)))
      .on('error', settle(reject));
  });
  return records;
}

// Read raw history records from an uploaded file (ZIP export or single JSON).
export async function readBrowserHistoryRecords(file) {
  if (!file?.path) return [];
  if (isZip(file)) return readRecordsFromZip(file.path);
  const text = await readFile(file.path, 'utf-8');
  return extractHistoryRecords(parseHistoryJsonText(text));
}

// End-to-end import seam: read the file → map → (preview | record). Returns
// counts + a preview summary. `dryRun` parses and summarizes WITHOUT writing so
// the UI can show the user what will be imported before they commit. Because
// `recordEvents` is idempotent, committing (or re-committing) is always safe.
export async function importBrowserHistory(file, { dryRun = false } = {}) {
  const records = await readBrowserHistoryRecords(file);
  const candidates = browserHistoryCandidates(records);
  const summary = summarizeBrowserCandidates(candidates);
  if (dryRun) {
    console.log(`🌐 Browser history import preview: ${candidates.length} visit(s) from ${records.length} record(s)`);
    return { dryRun: true, parsed: records.length, mapped: candidates.length, recorded: 0, skipped: 0, summary };
  }
  const { recorded, skipped } = await recordEvents(candidates);
  console.log(`🌐 Browser history import: ${recorded} new visit(s) recorded, ${skipped} duplicate/invalid (from ${records.length} record(s))`);
  return { dryRun: false, parsed: records.length, mapped: candidates.length, recorded, skipped, summary };
}
