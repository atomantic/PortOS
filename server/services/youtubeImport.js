/**
 * YouTube watch-history Takeout importer (#2153) — bulk historical backfill into
 * the machine-local human-activity timeline (#2150).
 *
 * YouTube killed the watch-history API years ago, so the reliable path for
 * historical data is Google Takeout: request "YouTube and YouTube Music →
 * history" and Google ships `watch-history.json` (a flat array, newest first)
 * covering the account lifetime. This importer takes that export (the raw ZIP or
 * the individual JSON) and maps every watch into a `media.watch` activity event
 * with the EXACT timestamp Takeout records.
 *
 * Takeout `watch-history.json` record shape:
 *   {
 *     header: "YouTube" | "YouTube Music",
 *     title:  "Watched <video title>",         // "Watched a video that has been removed" when gone
 *     titleUrl: "https://www.youtube.com/watch?v=VIDEOID",  // absent for removed videos / some ads
 *     subtitles: [{ name: "<channel>", url: "https://www.youtube.com/channel/UC..." }],
 *     time: "2024-01-05T04:32:10.123Z",
 *     products: ["YouTube"],
 *     activityControls: ["YouTube watch history"],
 *   }
 *
 * Dedupe reconciles the scrape and the backfill: BOTH sources key on
 * `yt:<videoId>:<localDay>` (the history page only shows a video once per day, so
 * day-bucketing is the coarsest-common-denominator that keeps a Takeout import and
 * a live scrape of the same watch from double-counting). The `happenedAt` we store
 * from Takeout is the exact timestamp; the scrape can only offer local midnight.
 * `recordEvents`'s `ON CONFLICT DO NOTHING` makes re-imports (and overlap with the
 * scrape) no-ops. No AI-provider calls; parsing is deterministic and LLM-free.
 */
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { parseZip, collectZipEntry } from '../lib/zipStream.js';
import { shortSummary, recordEvents, localDayKey } from './humanActivity.js';
import { getUserTimezone } from '../lib/timezone.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects).
// Shared with youtubeSync.js so the scrape and the backfill agree on video-id
// extraction and dedupe-key construction.
// ---------------------------------------------------------------------------

// Extract the 11-char YouTube video id from any of the URL shapes YouTube emits:
//   watch?v=ID · youtu.be/ID · /shorts/ID · /embed/ID · /v/ID · music.youtube.com
// Returns the id or null. The trailing charset is bounded so a garbage query
// string can't smuggle a giant "id" into the dedupe key.
export function youtubeVideoIdFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  const vParam = /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(s);
  if (vParam) return vParam[1];
  const pathId = /(?:youtu\.be\/|\/shorts\/|\/embed\/|\/v\/)([A-Za-z0-9_-]{6,20})/.exec(s);
  if (pathId) return pathId[1];
  return null;
}

// Resolve a Takeout watch timestamp to a UTC ISO string, or null if unparseable.
// Takeout's `time` is ISO-8601 with a `Z` (or an explicit offset), so a plain
// Date parse is correct — no OS-timezone ambiguity to correct for.
export function resolveYoutubeInstant(value) {
  if (!value) return null;
  const d = new Date(String(value).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Strip Takeout's localized action prefix from a title. English exports prefix
// "Watched " (videos) / "Viewed " (some ads); other locales differ. We only strip
// the known English prefixes and otherwise keep the title verbatim — the video id
// (not the title) is what identifies the watch, so a non-English title still maps.
export function stripWatchedPrefix(title) {
  if (!title) return '';
  const s = String(title).trim();
  const m = /^(?:Watched|Viewed)\s+(.*)$/s.exec(s);
  return (m ? m[1] : s).trim();
}

// Map ONE raw Takeout watch record to a `media.watch` candidate, or null when it
// lacks a resolvable video id (removed videos / bare ad impressions carry no
// autobiographical signal) or a usable timestamp. `timezone` anchors the
// local-day dedupe bucket so a watch near local midnight keys to the right day.
export function takeoutWatchRecordToCandidate(record, timezone) {
  if (!record || typeof record !== 'object') return null;
  const happenedAt = resolveYoutubeInstant(record.time);
  if (!happenedAt) return null;
  const videoId = youtubeVideoIdFromUrl(record.titleUrl);
  if (!videoId) return null;

  const dayKey = localDayKey(happenedAt, timezone);
  if (!dayKey) return null;

  const title = stripWatchedPrefix(record.title) || '(untitled video)';
  const sub = Array.isArray(record.subtitles) ? record.subtitles[0] : null;
  const channel = sub?.name ? String(sub.name).trim() : null;
  const channelUrl = sub?.url ? String(sub.url).trim() : null;
  const product = typeof record.header === 'string' ? record.header : 'YouTube';

  return {
    source: 'youtube',
    kind: 'media.watch',
    happenedAt,
    title,
    summary: channel ? shortSummary(channel) : null,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    // Shared with the scrape — one watch per video per local day (see file header).
    dedupeKey: `yt:${videoId}:${dayKey}`,
    metadata: {
      videoId,
      channel,
      channelUrl,
      product,
      dayBucket: dayKey,
    },
  };
}

// Map a batch of raw records to candidates, dropping the unmappable ones.
export function youtubeWatchActivityCandidates(records = [], timezone) {
  if (!Array.isArray(records)) return [];
  return records.map((r) => takeoutWatchRecordToCandidate(r, timezone)).filter(Boolean);
}

// Summarize a candidate batch for the import preview: date range, watch count,
// unique videos, and the top channels by watch count. Pure over candidates.
export function summarizeYoutubeCandidates(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  let earliest = null;
  let latest = null;
  const videos = new Set();
  const channelCounts = new Map();
  for (const c of list) {
    if (c.happenedAt) {
      if (!earliest || c.happenedAt < earliest) earliest = c.happenedAt;
      if (!latest || c.happenedAt > latest) latest = c.happenedAt;
    }
    videos.add(c.metadata?.videoId || c.title);
    const channel = c.metadata?.channel;
    if (channel) channelCounts.set(channel, (channelCounts.get(channel) || 0) + 1);
  }
  const topChannels = [...channelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return {
    watches: list.length,
    uniqueVideos: videos.size,
    from: earliest,
    to: latest,
    topChannels,
  };
}

// Parse the text of a single Takeout watch-history JSON file into a record array.
// Tolerates a top-level array (the normal shape) and an `{ items: [...] }`
// wrapper; anything else yields []. Throws only on malformed JSON.
export function parseYoutubeJsonText(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  return [];
}

// ---------------------------------------------------------------------------
// File ingestion (ZIP or single JSON) → records.
// ---------------------------------------------------------------------------

const isZip = (file) =>
  file?.mimetype === 'application/zip' ||
  file?.mimetype === 'application/x-zip-compressed' ||
  /\.zip$/i.test(file?.originalname || '');

// The watch-history JSON member inside a Takeout ZIP. Google nests it at
// `Takeout/YouTube and YouTube Music/history/watch-history.json`; match the
// filename anywhere so folder-naming/vintage differences don't miss it. The HTML
// variant (`watch-history.html`) is intentionally NOT matched — the JSON export
// is the supported, cheap-to-parse path.
const isWatchHistoryJsonEntry = (entryPath) =>
  /(?:^|\/)watch-history[^/]*\.json$/i.test(String(entryPath || ''));

// Extract and concatenate the watch records from every watch-history JSON member
// of the Takeout ZIP. Non-matching entries are drained and ignored.
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
        if (isWatchHistoryJsonEntry(entry.path)) {
          reads.push(
            collectZipEntry(entry)
              .then((buf) => {
                for (const r of parseYoutubeJsonText(buf.toString('utf-8'))) records.push(r);
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

// Read raw watch records from an uploaded file (ZIP export or single JSON array).
export async function readYoutubeRecords(file) {
  if (!file?.path) return [];
  if (isZip(file)) return readRecordsFromZip(file.path);
  const text = await readFile(file.path, 'utf-8');
  return parseYoutubeJsonText(text);
}

// End-to-end import seam: read the file → map → (preview | record). Returns
// counts + a preview summary. `dryRun` parses and summarizes WITHOUT writing so
// the UI can show the user what will be imported before they commit. Because
// `recordEvents` is idempotent, committing (or re-committing) is always safe.
export async function importYoutubeHistory(file, { dryRun = false } = {}) {
  const timezone = await getUserTimezone();
  const records = await readYoutubeRecords(file);
  const candidates = youtubeWatchActivityCandidates(records, timezone);
  const summary = summarizeYoutubeCandidates(candidates);
  if (dryRun) {
    console.log(`📺 YouTube import preview: ${candidates.length} watch(es) from ${records.length} record(s)`);
    return { dryRun: true, parsed: records.length, mapped: candidates.length, recorded: 0, skipped: 0, summary };
  }
  const { recorded, skipped } = await recordEvents(candidates);
  console.log(`📺 YouTube import: ${recorded} new watch(es) recorded, ${skipped} duplicate/invalid (from ${records.length} record(s))`);
  return { dryRun: false, parsed: records.length, mapped: candidates.length, recorded, skipped, summary };
}
