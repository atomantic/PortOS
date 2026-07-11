/**
 * Spotify extended-streaming-history importer (#2160) — bulk historical backfill
 * into the human-activity timeline.
 *
 * Spotify's privacy download ("Extended streaming history") ships a ZIP whose
 * `Streaming_History_Audio_*.json` files are arrays of per-play records covering
 * the full account lifetime — far more than the 50-track window the Web API
 * exposes (which the live sync in Phase 3 polls). This importer takes that export
 * (either the raw ZIP or an individual JSON array) and maps every play into a
 * `media.listen` activity event.
 *
 * Two export shapes are supported:
 *   - Extended history (2023+): `{ ts, ms_played, master_metadata_track_name,
 *     master_metadata_album_artist_name, master_metadata_album_album_name,
 *     spotify_track_uri, episode_name, ... }`
 *   - Legacy "Account data" `StreamingHistory*.json`: `{ endTime, artistName,
 *     trackName, msPlayed }` (endTime is UTC "YYYY-MM-DD HH:MM").
 *
 * Idempotent: every candidate carries a stable `dedupeKey` (track uri + ISO
 * timestamp), so re-importing the same export — or an overlapping newer export —
 * is a no-op via `recordEvents`'s `ON CONFLICT DO NOTHING`. No AI-provider calls;
 * parsing is deterministic and LLM-free.
 */
import { readFile } from 'fs/promises';
import { collectZipEntries, isZipUpload } from '../lib/zipStream.js';
import { shortSummary, recordEvents } from './humanActivity.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects).
// ---------------------------------------------------------------------------

// Resolve a Spotify play timestamp to a UTC ISO string, or null if unparseable.
// Extended history uses ISO-8601 with a `Z` (`ts`); legacy StreamingHistory uses
// a space-separated UTC wall clock without an offset ("2022-01-01 15:30") — we
// append the missing `:00Z` so it's interpreted as UTC, not server-OS-local.
export function resolveSpotifyInstant(value) {
  if (!value) return null;
  const s = String(value).trim();
  const legacy = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(s);
  const iso = legacy ? `${legacy[1]}T${legacy[2]}:00Z` : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Turn a `spotify:track:ID` / `spotify:episode:ID` URI into an open.spotify.com
// link; pass through anything that's already an http(s) URL; else null.
export function spotifyUriToUrl(uri) {
  if (!uri) return null;
  const s = String(uri).trim();
  if (/^https?:\/\//i.test(s)) return s;
  const m = /^spotify:(track|episode|album|artist):([A-Za-z0-9]+)$/.exec(s);
  return m ? `https://open.spotify.com/${m[1]}/${m[2]}` : null;
}

// Map ONE raw Spotify play record to an activity candidate, or null if it lacks a
// usable timestamp or a track/episode name (bare ms_played records with null
// metadata — local files, ads — carry no autobiographical signal).
export function spotifyRecordToCandidate(record) {
  if (!record || typeof record !== 'object') return null;
  const happenedAt = resolveSpotifyInstant(record.ts ?? record.endTime);
  if (!happenedAt) return null;

  const trackName = record.master_metadata_track_name ?? record.trackName ?? null;
  const artist = record.master_metadata_album_artist_name ?? record.artistName ?? null;
  const album = record.master_metadata_album_album_name ?? null;
  const episodeName = record.episode_name ?? null;
  const showName = record.episode_show_name ?? null;
  const title = trackName || episodeName;
  if (!title) return null;

  const isEpisode = !trackName && Boolean(episodeName);
  const uri = record.spotify_track_uri ?? record.spotify_episode_uri ?? null;
  const msRaw = record.ms_played ?? record.msPlayed;
  const ms = Number(msRaw);
  const durationS = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null;

  // Dedupe on the play instant + track identity. Two plays of the same track at
  // the exact same second are indistinguishable in the export, so collapsing
  // them is correct (and matches the design's "played_at + track id" contract).
  // Legacy/local records carry no URI — fall back to artist+album+title (or the
  // show for episodes) so two *different* tracks that happen to share a title at
  // the same instant don't wrongly collapse into one play.
  const identity = uri
    || [artist, isEpisode ? showName : album, title].filter(Boolean).join('|');
  const dedupeKey = `spotify:${identity}:${happenedAt}`;

  const summaryParts = isEpisode
    ? [showName].filter(Boolean)
    : [artist, album].filter(Boolean);

  return {
    source: 'spotify',
    kind: 'media.listen',
    happenedAt,
    durationS,
    title,
    summary: shortSummary(summaryParts.join(' — ')),
    url: spotifyUriToUrl(uri),
    dedupeKey,
    metadata: {
      artist: artist || null,
      album: album || null,
      trackUri: uri,
      type: isEpisode ? 'episode' : 'track',
      showName: isEpisode ? showName || null : null,
      platform: record.platform ?? null,
      reasonStart: record.reason_start ?? null,
      reasonEnd: record.reason_end ?? null,
      shuffle: typeof record.shuffle === 'boolean' ? record.shuffle : null,
      skipped: typeof record.skipped === 'boolean' ? record.skipped : null,
      msPlayed: Number.isFinite(ms) ? ms : null,
    },
  };
}

// Map a batch of raw records to candidates, dropping the unmappable ones.
export function spotifyActivityCandidates(records = []) {
  if (!Array.isArray(records)) return [];
  return records.map(spotifyRecordToCandidate).filter(Boolean);
}

// Summarize a candidate batch for the import preview: date range, listen time,
// unique track count, and the top artists by play count. Pure over candidates.
export function summarizeSpotifyCandidates(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  let earliest = null;
  let latest = null;
  let totalMs = 0;
  const uris = new Set();
  const artistCounts = new Map();
  for (const c of list) {
    if (c.happenedAt) {
      if (!earliest || c.happenedAt < earliest) earliest = c.happenedAt;
      if (!latest || c.happenedAt > latest) latest = c.happenedAt;
    }
    const ms = c.metadata?.msPlayed;
    if (Number.isFinite(ms)) totalMs += ms;
    uris.add(c.metadata?.trackUri || c.title);
    const artist = c.metadata?.artist;
    if (artist) artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
  }
  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return {
    plays: list.length,
    uniqueTracks: uris.size,
    totalMs,
    from: earliest,
    to: latest,
    topArtists,
  };
}

// Parse the text of a single Spotify history JSON file into a record array.
// Tolerates a top-level array (the normal shape) and a `{ items: [...] }`
// wrapper; anything else yields []. Throws only on malformed JSON.
export function parseSpotifyJsonText(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  return [];
}

// ---------------------------------------------------------------------------
// File ingestion (ZIP or single JSON) → records.
// ---------------------------------------------------------------------------

// A streaming-history JSON member inside the export ZIP. Spotify names them
// `Streaming_History_Audio_2023_1.json` (extended) or `StreamingHistory0.json`
// (legacy), sometimes under a `Spotify Extended Streaming History/` folder.
const isHistoryJsonEntry = (entryPath) =>
  /(?:^|\/)(?:Streaming_History_Audio|StreamingHistory)[^/]*\.json$/i.test(entryPath);

// Read raw play records from an uploaded file (ZIP export or single JSON array).
// The ZIP path delegates the whole streaming lifecycle (teardown, autodrain,
// per-entry await) to `collectZipEntries`, leaving only the match/parse callbacks.
export async function readSpotifyRecords(file) {
  if (!file?.path) return [];
  if (isZipUpload(file)) {
    const records = [];
    await collectZipEntries(file.path, {
      match: isHistoryJsonEntry,
      onMatch: (buf) => {
        for (const r of parseSpotifyJsonText(buf.toString('utf-8'))) records.push(r);
      },
    });
    return records;
  }
  const text = await readFile(file.path, 'utf-8');
  return parseSpotifyJsonText(text);
}

// End-to-end import seam: read the file → map → (preview | record). Returns
// counts + a preview summary. `dryRun` parses and summarizes WITHOUT writing so
// the UI can show the user what will be imported before they commit. Because
// `recordEvents` is idempotent, committing (or re-committing) is always safe.
export async function importSpotifyHistory(file, { dryRun = false } = {}) {
  const records = await readSpotifyRecords(file);
  const candidates = spotifyActivityCandidates(records);
  const summary = summarizeSpotifyCandidates(candidates);
  if (dryRun) {
    console.log(`🎧 Spotify import preview: ${candidates.length} play(s) from ${records.length} record(s)`);
    return { dryRun: true, parsed: records.length, mapped: candidates.length, recorded: 0, skipped: 0, summary };
  }
  const { recorded, skipped } = await recordEvents(candidates);
  console.log(`🎧 Spotify import: ${recorded} new play(s) recorded, ${skipped} duplicate/invalid (from ${records.length} record(s))`);
  return { dryRun: false, parsed: records.length, mapped: candidates.length, recorded, skipped, summary };
}
