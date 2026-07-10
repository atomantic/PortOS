/**
 * Spotify listening-history ingestion (#2152) — poll the Web API's
 * recently-played endpoint and feed the machine-local human-activity timeline
 * (#2150) with `media.listen` events.
 *
 * Design constraints (docs/plans/2026-07-04-human-activity-tracking.md):
 *
 * - **50-track window ⇒ cadence must beat it.** `GET /v1/me/player/recently-played`
 *   only exposes the last 50 plays, so the scheduler polls every ~25 min (see
 *   spotifyScheduler.js) to avoid gaps. An incremental `after` cursor (the newest
 *   `played_at` seen) keeps each poll to just the new plays.
 * - **Machine-local + idempotent.** The cursor lives in a `data/spotify/` JSON
 *   file (per-machine, unsynced). Each event carries a stable
 *   `spotify:<played_at>:<trackId>` dedupe key, so re-polls are no-ops.
 * - **LLM-free.** Track/artist/genre metadata is stored verbatim for later twin
 *   enrichment (Phase 7); no AI-provider calls happen on this path.
 * - **Raw-response cache.** The latest API payload is cached under
 *   `data/spotify/cache/` (local, unsynced) for debugging / re-derivation.
 *
 * The pure mappers (candidate mapping, dedupe keys, cursor advance) are exported
 * and unit-tested with fixture payloads — no network or DB required.
 */
import { dataPath, ensureDir, atomicWrite, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { getSettings } from './settings.js';
import { getAccessToken, getAuthStatus } from './spotifyAuth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENTLY_PLAYED_URL = 'https://api.spotify.com/v1/me/player/recently-played';
const RECENTLY_PLAYED_TIMEOUT_MS = 15_000;

// The API caps this at 50; the cursor + fast cadence keep us from missing plays.
const SCAN_LIMIT = 50;

const STATE_FILE = 'sync-state.json';
const CACHE_FILE = 'recently-played.json';

// Sync is OFF by default — the user connects Spotify + opts in from Settings.
const DEFAULT_CONFIG = { enabled: false, intervalMinutes: 25 };

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no filesystem, no DB).
// ---------------------------------------------------------------------------

/**
 * Map one recently-played item to a human-activity `media.listen` candidate, or
 * `null` when it's missing a track id / valid `played_at`. Dedupe key is
 * `spotify:<played_at ISO>:<trackId>` — the same track replayed later is a
 * distinct listen, but the same play re-fetched is deduped.
 *
 * `metadata` keeps track/artist/album pointers (+ isrc/popularity) verbatim for
 * Phase 7 taste enrichment; the short `summary` is the artist line only (privacy
 * contract — no full payload in the event row).
 */
export function spotifyListenCandidate(item) {
  const track = item?.track;
  const playedAt = item?.played_at;
  if (!track?.id || !playedAt) return null;
  const at = new Date(playedAt);
  if (Number.isNaN(at.getTime())) return null;

  const artists = Array.isArray(track.artists)
    ? track.artists.map((a) => ({ id: a?.id || null, name: String(a?.name || '').trim() })).filter((a) => a.name)
    : [];
  const artistNames = artists.map((a) => a.name).join(', ');
  const durationS = Number.isFinite(track.duration_ms) ? Math.round(track.duration_ms / 1000) : null;

  return {
    source: 'spotify',
    accountId: null,
    kind: 'media.listen',
    happenedAt: at.toISOString(),
    durationS,
    title: track.name || '(unknown track)',
    summary: artistNames,
    url: track.external_urls?.spotify || null,
    dedupeKey: `spotify:${at.toISOString()}:${track.id}`,
    metadata: {
      trackId: track.id,
      trackName: track.name || null,
      artists,
      album: track.album?.name || null,
      albumId: track.album?.id || null,
      isrc: track.external_ids?.isrc || null,
      popularity: Number.isFinite(track.popularity) ? track.popularity : null,
      explicit: typeof track.explicit === 'boolean' ? track.explicit : null,
      context: item.context?.type || null,
      contextUri: item.context?.uri || null,
    },
  };
}

export function spotifyListenCandidates(items = []) {
  return (items || []).map(spotifyListenCandidate).filter(Boolean);
}

/**
 * Advance the `after` cursor to the newest `played_at` (epoch ms) across a batch,
 * never regressing below the current cursor. Spotify's `after` param is a Unix-ms
 * timestamp that returns plays strictly AFTER it, so the max seen is the next
 * cursor. Ignores items with an unparseable `played_at`.
 */
export function maxPlayedAtMs(items = [], current = 0) {
  let max = Number.isFinite(current) ? current : 0;
  for (const item of items || []) {
    const t = new Date(item?.played_at).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Config + machine-local cursor state
// ---------------------------------------------------------------------------

export async function getSpotifyConfig() {
  const settings = await getSettings().catch(() => ({}));
  const c = settings?.spotify || {};
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_CONFIG.enabled,
    intervalMinutes: Number.isFinite(c.intervalMinutes) && c.intervalMinutes >= 1
      ? Math.floor(c.intervalMinutes)
      : DEFAULT_CONFIG.intervalMinutes,
  };
}

function stateFilePath() {
  return dataPath('spotify', STATE_FILE);
}

// Machine-local incremental cursor. NOT federated — the recently-played window
// and its timestamps are per-account, so this must never sync to a peer.
export async function readSyncState() {
  const raw = await tryReadFile(stateFilePath());
  const parsed = raw ? safeJSONParse(raw, null, { allowArray: false }) : null;
  return {
    cursorAfter: Number.isFinite(parsed?.cursorAfter) ? parsed.cursorAfter : 0,
    lastRunAt: parsed?.lastRunAt || null,
    lastResult: parsed?.lastResult || null,
  };
}

async function writeSyncState(state) {
  await ensureDir(dataPath('spotify'));
  await atomicWrite(stateFilePath(), JSON.stringify(state, null, 2));
}

async function writeRawCache(payload) {
  await ensureDir(dataPath('spotify', 'cache'));
  await atomicWrite(dataPath('spotify', 'cache', CACHE_FILE), JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------------------
// Sync (side-effecting — network + DB). Runs outside the request lifecycle
// (scheduler / explicit endpoint), so network/persist failures return an error
// report instead of throwing.
// ---------------------------------------------------------------------------

// Re-entrancy guard: a manual "Sync now" overlapping a scheduler tick would
// double-read the same cursor (deduped, but doubled work, and the slower writer
// could stamp a stale cursor over the fresher one) — so concurrent callers share
// the in-flight pass.
let syncInFlight = null;
export async function runSync() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doRunSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doRunSync() {
  const accessToken = await getAccessToken().catch((err) => {
    console.error(`❌ Spotify sync auth failed: ${err?.message || err}`);
    return null;
  });
  if (!accessToken) {
    return { ok: false, needsAuth: true, error: 'Spotify not connected — authorize in Settings → Spotify.' };
  }

  const started = Date.now();
  const state = await readSyncState();
  const url = new URL(RECENTLY_PLAYED_URL);
  url.searchParams.set('limit', String(SCAN_LIMIT));
  if (state.cursorAfter) url.searchParams.set('after', String(state.cursorAfter));

  let res;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      RECENTLY_PLAYED_TIMEOUT_MS,
    );
  } catch (err) {
    const reason = err?.message || String(err);
    console.error(`❌ Spotify recently-played fetch failed: ${reason}`);
    return { ok: false, error: `Spotify API request failed: ${reason}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`❌ Spotify recently-played fetch failed: ${res.status} ${body.slice(0, 200)}`);
    return { ok: false, status: res.status, error: `Spotify API returned ${res.status}` };
  }
  const payload = await res.json().catch(() => null);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  await writeRawCache(payload).catch((err) => console.error(`⚠️ Spotify raw-cache write failed: ${err?.message || err}`));

  const candidates = spotifyListenCandidates(items);

  // Persistence failures must NOT advance the cursor: the dedupe keys make a
  // re-poll a no-op, but the recently-played window scrolls, so skipping past
  // unpersisted plays loses them permanently. Hold the cursor on failure.
  let persistFailed = false;
  const { recordEvents } = await import('./humanActivity.js');
  const recordResult = await recordEvents(candidates).catch((err) => {
    console.error(`❌ Spotify activity record failed: ${err?.message || err}`);
    persistFailed = true;
    return { recorded: 0, skipped: candidates.length };
  });

  // Incrementally refresh observed twin evidence when new listens landed (#2156).
  // LLM-free + self-guarded — never blocks or fails the sync.
  if (!persistFailed && recordResult.recorded > 0) {
    const { refreshTwinEvidenceAfterSync } = await import('./twinEnrichment.js');
    await refreshTwinEvidenceAfterSync();
  }

  // Prefer the response's own `cursors.after` (Spotify's canonical next cursor),
  // falling back to the computed max — but never regress below the stored cursor.
  const responseCursor = Number(payload?.cursors?.after);
  const computed = maxPlayedAtMs(items, state.cursorAfter);
  const advanced = Number.isFinite(responseCursor) && responseCursor > (state.cursorAfter || 0)
    ? responseCursor
    : computed;
  const nextCursor = persistFailed ? state.cursorAfter : advanced;

  const result = {
    ok: !persistFailed,
    ...(persistFailed ? { error: 'Persistence failed — cursor held so the batch retries next sync' } : {}),
    scanned: items.length,
    recorded: recordResult.recorded,
    skipped: recordResult.skipped,
    cursorAfter: nextCursor,
    // A full 50-item batch means older plays may remain beyond this pass — the
    // caller (UI toast / next scheduler tick) should run again to keep draining.
    hasMore: items.length === SCAN_LIMIT,
    durationMs: Date.now() - started,
  };
  await writeSyncState({ cursorAfter: nextCursor, lastRunAt: new Date().toISOString(), lastResult: result });
  console.log(`🎧 Spotify sync: scanned ${result.scanned}, recorded ${result.recorded} listen(s), cursor→${result.cursorAfter}${result.hasMore ? ' (more remaining)' : ''}${persistFailed ? ' — PERSIST FAILED, cursor held' : ''} in ${result.durationMs}ms`);
  return result;
}

// Status for the settings UI: config + cursor state + auth status (no API call).
export async function getStatus() {
  const [config, state, auth] = await Promise.all([
    getSpotifyConfig(),
    readSyncState(),
    getAuthStatus(),
  ]);
  return { config, state, auth };
}
