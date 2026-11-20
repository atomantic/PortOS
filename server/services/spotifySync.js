/**
 * Spotify listening-history ingestion (#2152) — poll the Web API's
 * recently-played endpoint and feed the machine-local human-activity timeline
 * (#2150) with `media.listen` events.
 *
 * Design constraints (docs/plans/archive/2026-07-04-human-activity-tracking.md):
 *
 * - **Incremental pagination.** Spotify returns up to 50 plays per page.
 *   Each sync drains the available pages above the saved `after` cursor.
 * - **Machine-local + idempotent.** The cursor lives in a `data/spotify/` JSON
 *   file (per-machine, unsynced). Each event carries a stable
 *   `spotify:<played_at>:<trackId>` dedupe key, so re-polls are no-ops.
 * - **LLM-free.** Track/artist/genre metadata is stored verbatim for later twin
 *   enrichment (Phase 7); no AI-provider calls happen on this path.
 * - **Raw-response cache.** The first (most recent) API page is cached under
 *   `data/spotify/cache/` (local, unsynced) for debugging / re-derivation.
 *
 * The pure mappers (candidate mapping and dedupe keys) are exported
 * and unit-tested with fixture payloads — no network or DB required.
 */
import { dataPath, ensureDir, atomicWrite } from '../lib/fileUtils.js';
import { readSyncCursorState, readSyncCursorStateForStatus } from '../lib/syncCursorState.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { getSettings } from './settings.js';
import { getAccessToken, getAuthStatus } from './spotifyAuth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECENTLY_PLAYED_URL = new URL('https://api.spotify.com/v1/me/player/recently-played');
const RECENTLY_PLAYED_TIMEOUT_MS = 15_000;

// The API caps each page at 50.
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
    // Whole-second key: the history export's `ts` has no milliseconds, so a ms key
    // would never meet the imported copy of this play (#15309). The `after` cursor
    // stays full-precision.
    dedupeKey: `spotify:${new Date(Math.floor(at.getTime() / 1000) * 1000).toISOString()}:${track.id}`,
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

// Only the history endpoint can receive the bearer token from this sync.
function parseContinuation(next) {
  const url = typeof next === 'string' ? URL.parse(next) : null;
  if (url?.origin !== RECENTLY_PLAYED_URL.origin || url.pathname !== RECENTLY_PLAYED_URL.pathname
    || url.username || url.password || url.hash) return null;
  return url;
}

function pageKey(url) {
  const params = new URLSearchParams(url.search);
  params.sort();
  return params.toString();
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
  return readSyncCursorState(stateFilePath(), 'cursorAfter');
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
  const state = await readSyncState();
  const started = Date.now();

  const fail = async (failure) => {
    const lastResult = { ok: false, failedAt: new Date().toISOString(), ...failure };
    await writeSyncState({
      cursorAfter: state.cursorAfter,
      lastRunAt: state.lastRunAt,
      lastResult,
    });
    return lastResult;
  };

  let accessToken = null;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    const reason = err?.message || String(err);
    console.error(`❌ Spotify sync auth failed: ${reason}`);
    const isInvalidGrant = err?.code === 'INVALID_GRANT'
      || err?.context?.isInvalidGrant === true
      || (typeof reason === 'string' && reason.toLowerCase().includes('invalid_grant'))
      || (typeof reason === 'string' && reason.includes('Spotify rejected the saved authorization'));
    return fail({
      needsAuth: isInvalidGrant,
      error: isInvalidGrant
        ? 'Spotify rejected the saved authorization — reconnect Spotify.'
        : `Spotify auth failed: ${reason}`,
    });
  }

  if (!accessToken) {
    return fail({
      needsAuth: true,
      error: 'Spotify not connected — authorize in Brain → Spotify.',
    });
  }

  let url = new URL(RECENTLY_PLAYED_URL);
  url.searchParams.set('limit', String(SCAN_LIMIT));
  if (state.cursorAfter) url.searchParams.set('after', String(state.cursorAfter));

  const failHistory = (error, details = {}) => {
    console.error(`❌ Spotify recently-played sync failed: ${error}`);
    return fail({ error, ...details });
  };

  const candidates = [];
  const visitedPages = new Set();
  let scanned = 0;
  let nextCursor = state.cursorAfter;
  while (url) {
    const key = pageKey(url);
    if (visitedPages.has(key)) return failHistory('Spotify repeated a recently-played page URL.');
    visitedPages.add(key);

    let res;
    try {
      res = await fetchWithTimeout(
        url,
        { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error' },
        RECENTLY_PLAYED_TIMEOUT_MS,
      );
    } catch (err) {
      return failHistory(`Spotify API request failed: ${err?.message || err}`, { needsAuth: false });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return failHistory(`Spotify API returned ${res.status}`, { status: res.status });
    }

    const payload = await res.json().catch(() => null);
    if (!Array.isArray(payload?.items)) return failHistory('Spotify returned an invalid recently-played page.');
    const { items, next } = payload;
    if (visitedPages.size === 1) {
      await writeRawCache(payload).catch((err) => console.error(`⚠️ Spotify raw-cache write failed: ${err?.message || err}`));
    }

    // A continuation may change cursor direction. Keep the original exclusive
    // floor for every page and only checkpoint plays mapped for persistence.
    scanned += items.length;
    for (const candidate of spotifyListenCandidates(items)) {
      const playedAt = Date.parse(candidate.happenedAt);
      if (playedAt <= state.cursorAfter) continue;
      candidates.push(candidate);
      nextCursor = Math.max(nextCursor, playedAt);
    }

    if (next == null) break;
    url = parseContinuation(next);
    if (!url || items.length === 0) return failHistory('Spotify returned an invalid recently-played continuation.');
  }

  // Commit the cursor only after the continuation was exhausted and every write
  // succeeded. Activity writes are idempotent if a partial batch must replay.
  const { recordEvents } = await import('./humanActivity.js');
  let recordResult;
  try {
    recordResult = await recordEvents(candidates);
  } catch (err) {
    console.error(`❌ Spotify activity record failed: ${err?.message || err}`);
    return fail({
      error: 'Persistence failed — cursor held so the batch retries next sync',
      cursorAfter: state.cursorAfter,
      scanned,
      recorded: 0,
      skipped: candidates.length,
      hasMore: false,
      durationMs: Date.now() - started,
    });
  }

  // Incrementally refresh observed twin evidence when new listens landed (#2156).
  // LLM-free + self-guarded — never fails the sync.
  if (recordResult.recorded > 0) {
    const { refreshTwinEvidenceAfterSync } = await import('./twinEnrichment.js');
    await refreshTwinEvidenceAfterSync();
  }

  const result = {
    ok: true,
    scanned,
    recorded: recordResult.recorded,
    skipped: recordResult.skipped,
    cursorAfter: nextCursor,
    hasMore: false,
    durationMs: Date.now() - started,
  };
  await writeSyncState({ cursorAfter: nextCursor, lastRunAt: new Date().toISOString(), lastResult: result });
  console.log(`🎧 Spotify sync: scanned ${result.scanned}, recorded ${result.recorded} listen(s), cursor→${result.cursorAfter} in ${result.durationMs}ms`);
  return result;
}

// Status for the settings UI: config + cursor state + auth status (no API call).
export async function getStatus(options = {}) {
  const [config, { state, stateError }, auth] = await Promise.all([
    getSpotifyConfig(),
    readSyncCursorStateForStatus(stateFilePath(), 'cursorAfter'),
    getAuthStatus(options),
  ]);
  return { config, state, auth, ...(stateError ? { stateError } : {}) };
}
