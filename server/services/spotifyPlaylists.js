/**
 * Spotify playlist ingestion for the Brain taste library.
 *
 * Playlists are machine-local reference material. We persist bounded Spotify
 * metadata (playlist names, descriptions, track/artist/album names, artwork
 * URLs, and service links) under data/spotify/; raw API responses never leave
 * the request and this snapshot is not part of federation.
 */
import { dataPath, ensureDir, atomicWrite, readJSONFile, sleep } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { getAccessToken } from './spotifyAuth.js';

const API_BASE = 'https://api.spotify.com/v1';
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_LIMIT = 50;
const PLAYLIST_BATCH_SIZE = 5;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RATE_LIMIT_WAIT_MS = 10000;
const PLAYLISTS_FILE = dataPath('spotify', 'playlists.json');
const SNAPSHOT_VERSION = 1;

const playlistUrl = (id) => `https://open.spotify.com/playlist/${encodeURIComponent(id)}`;

const imageShape = (image) => {
  if (!image?.url || !/^https:\/\//i.test(image.url)) return null;
  return {
    url: image.url,
    ...(Number.isFinite(image.height) ? { height: image.height } : {}),
    ...(Number.isFinite(image.width) ? { width: image.width } : {}),
  };
};

const trackShape = (raw) => {
  const track = raw?.item || raw?.track;
  if (!track?.id || !track?.name) return null;
  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => ({ id: artist?.id || null, name: String(artist?.name || '').trim() }))
      .filter((artist) => artist.name)
    : [];
  return {
    id: track.id,
    name: track.name,
    artists,
    album: track.album?.name || null,
    albumId: track.album?.id || null,
    durationMs: Number.isFinite(track.duration_ms) ? track.duration_ms : null,
    explicit: typeof track.explicit === 'boolean' ? track.explicit : null,
    isLocal: track.is_local === true,
    spotifyUrl: track.external_urls?.spotify || `https://open.spotify.com/track/${encodeURIComponent(track.id)}`,
    addedAt: raw.added_at || null,
  };
};

export function normalizeSpotifyTrack(raw) {
  return trackShape(raw);
}

export function normalizeSpotifyPlaylist(raw, tracks = []) {
  if (!raw?.id || !raw?.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description || '',
    public: typeof raw.public === 'boolean' ? raw.public : null,
    collaborative: raw.collaborative === true,
    trackCount: Number.isFinite(raw.tracks?.total) ? raw.tracks.total : tracks.length,
    spotifyUrl: raw.external_urls?.spotify || playlistUrl(raw.id),
    images: Array.isArray(raw.images) ? raw.images.map(imageShape).filter(Boolean) : [],
    tracks,
  };
}

export function playlistSnapshotSummary(snapshot) {
  const playlists = Array.isArray(snapshot?.playlists) ? snapshot.playlists : [];
  return {
    playlistCount: playlists.length,
    trackCount: playlists.reduce((total, playlist) => total + (playlist.tracks?.length || 0), 0),
    syncedAt: snapshot?.syncedAt || null,
    warningCount: Array.isArray(snapshot?.warnings) ? snapshot.warnings.length : 0,
  };
}

async function fetchJson(url, accessToken) {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }, REQUEST_TIMEOUT_MS);
    if (!response.ok && response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfterHeader = response.headers?.get?.('retry-after');
      const retryAfter = retryAfterHeader == null ? NaN : Number(retryAfterHeader);
      const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 1000;
      if (waitMs > MAX_RATE_LIMIT_WAIT_MS) throw new Error(`Spotify rate limited; retry after ${retryAfter}s`);
      await sleep(waitMs);
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Spotify API returned ${response.status}${payload?.error?.message ? `: ${payload.error.message}` : ''}`);
    }
    return payload;
  }
}

async function fetchPages(path, accessToken) {
  const items = [];
  let offset = 0;
  let total = null;
  let pageItems = [];
  do {
    const page = await fetchJson(`${API_BASE}${path}?limit=${PAGE_LIMIT}&offset=${offset}`, accessToken);
    pageItems = Array.isArray(page?.items) ? page.items : [];
    items.push(...pageItems);
    if (!pageItems.length) break;
    total = Number.isFinite(page?.total) ? page.total : null;
    offset += pageItems.length;
  } while (total === null ? pageItems.length >= PAGE_LIMIT : offset < total);
  return items;
}

async function fetchPlaylist(playlist, accessToken) {
  const items = await fetchPages(`/playlists/${encodeURIComponent(playlist.id)}/items`, accessToken);
  const tracks = items.map(normalizeSpotifyTrack).filter(Boolean);
  return normalizeSpotifyPlaylist(playlist, tracks);
}

export async function getStoredPlaylists() {
  return readJSONFile(PLAYLISTS_FILE, null, { strict: true });
}

let syncInFlight = null;

export async function syncSpotifyPlaylists() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSyncSpotifyPlaylists().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doSyncSpotifyPlaylists() {
  const accessToken = await getAccessToken().catch((error) => {
    console.error(`❌ Spotify playlist sync auth failed: ${error?.message || error}`);
    return null;
  });
  if (!accessToken) {
    return { ok: false, needsAuth: true, error: 'Spotify not connected — authorize in Brain → Spotify.' };
  }

  const storedResult = await getStoredPlaylists()
    .then((value) => ({ value }))
    .catch((error) => ({ error }));
  if (storedResult.error) {
    return { ok: false, status: 'snapshot-unreadable', error: 'Could not read the stored Spotify playlist snapshot; not overwriting it.' };
  }
  const previous = storedResult.value;
  const playlistResult = await fetchPages('/me/playlists', accessToken)
    .then((value) => ({ value }))
    .catch((error) => ({ error }));
  if (playlistResult.error) {
    const error = playlistResult.error;
    console.error(`❌ Spotify playlist list failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
  const playlistSummaries = playlistResult.value.filter((playlist) => playlist?.id && playlist?.name);
  if (!playlistSummaries.length && previous?.playlists?.length) {
    return {
      ok: false,
      status: 'list-empty',
      error: 'No playlists returned — keeping the previous snapshot.',
      ...playlistSnapshotSummary(previous),
      scanned: 0,
      failed: 0,
    };
  }

  const results = [];
  for (let index = 0; index < playlistSummaries.length; index += PLAYLIST_BATCH_SIZE) {
    const batch = playlistSummaries.slice(index, index + PLAYLIST_BATCH_SIZE);
    results.push(...await Promise.allSettled(batch.map((playlist) => fetchPlaylist(playlist, accessToken))));
  }
  const previousById = new Map((previous?.playlists || []).map((playlist) => [playlist.id, playlist]));
  const warnings = [];
  const playlists = [];
  results.forEach((result, index) => {
    const summary = playlistSummaries[index];
    if (result.status === 'fulfilled' && result.value) {
      playlists.push(result.value);
      return;
    }
    const message = result.reason?.message || 'Could not read playlist items';
    warnings.push(`${summary?.name || 'Playlist'}: ${message}`);
    const stale = previousById.get(summary?.id);
    if (stale) playlists.push(stale);
  });

  const snapshot = {
    schemaVersion: SNAPSHOT_VERSION,
    syncedAt: new Date().toISOString(),
    playlists,
    warnings,
  };
  await ensureDir(dataPath('spotify'));
  await atomicWrite(PLAYLISTS_FILE, snapshot);

  const summary = playlistSnapshotSummary(snapshot);
  const result = {
    ok: warnings.length === 0,
    ...summary,
    scanned: playlistSummaries.length,
    failed: warnings.length,
    ...(warnings.length ? { warnings } : {}),
  };
  console.log(`🎧 Spotify playlists: synced ${summary.playlistCount} playlist(s), ${summary.trackCount} track(s)${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
  return result;
}
