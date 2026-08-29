/**
 * YouTube playlist and saved-video reference ingestion for Brain.
 *
 * YouTube has no usable watch-history API for this feature, so this follows the
 * existing managed-browser boundary used by youtubeSync. The snapshot is local
 * to this install and contains only bounded display metadata plus source URLs;
 * video bytes are fetched only after the user explicitly starts a download.
 */
import { dataPath, ensureDir, atomicWrite, readJSONFile, sleep } from '../lib/fileUtils.js';
import { findOrOpenPage, listCdpPages, isAuthPage, evaluateOnPage } from './browserService.js';

const PLAYLISTS_URL = 'https://www.youtube.com/feed/playlists';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=';
const PLAYLISTS_FILE = dataPath('youtube', 'playlists.json');
const SNAPSHOT_VERSION = 1;
const MAX_PLAYLISTS = 100;
const MAX_VIDEOS_PER_PLAYLIST = 200;
const NAV_SETTLE_MS = 2500;
const MAX_SYNC_MS = 2 * 60 * 1000;

export function normalizeYoutubeVideo(raw) {
  if (!raw?.id || !raw?.title) return null;
  return {
    id: raw.id,
    title: raw.title,
    channel: raw.channel || null,
    thumbnail: raw.thumbnail && /^https:\/\//i.test(raw.thumbnail) ? raw.thumbnail : null,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(raw.id)}`,
    duration: raw.duration || null,
  };
}

export function normalizeYoutubePlaylist(raw, videos = []) {
  if (!raw?.id || !raw?.name) return null;
  return {
    id: raw.id,
    name: raw.name,
    videoCount: Number.isFinite(raw.videoCount) ? raw.videoCount : videos.length,
    url: `https://www.youtube.com/playlist?list=${encodeURIComponent(raw.id)}`,
    thumbnail: raw.thumbnail && /^https:\/\//i.test(raw.thumbnail) ? raw.thumbnail : null,
    videos,
  };
}

export function youtubePlaylistSnapshotSummary(snapshot) {
  const playlists = Array.isArray(snapshot?.playlists) ? snapshot.playlists : [];
  return {
    playlistCount: playlists.length,
    videoCount: playlists.reduce((total, playlist) => total + (playlist.videos?.length || 0), 0),
    syncedAt: snapshot?.syncedAt || null,
    warningCount: Array.isArray(snapshot?.warnings) ? snapshot.warnings.length : 0,
  };
}

function buildPlaylistsExtractionScript() {
  return `
    (async () => {
      const signedOut = /accounts\\.google\\.com|\\/ServiceLogin/i.test(location.href)
        || (!!document.querySelector('a[href*="ServiceLogin"]') && !document.querySelector('#avatar-btn, button#avatar-btn, #masthead #avatar'));
      if (signedOut) return { signedOut: true, playlists: [] };
      const abs = (href) => { try { return new URL(href, location.origin).href; } catch { return href || null; } };
      const seen = new Set();
      const playlists = [];
      // YouTube has shipped both the older playlist renderers and its newer
      // rich-grid/lockup cards. Keep the selectors together so a frontend
      // rollout does not make a valid signed-in library look empty.
      const collect = () => Array.from(document.querySelectorAll('ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-playlist-card-renderer, ytd-rich-item-renderer, ytd-rich-grid-media, yt-lockup-view-model')).map((card) => {
        const link = Array.from(card.querySelectorAll('a[href*="list="]'))[0];
        const url = link ? abs(link.getAttribute('href')) : null;
        let id = null;
        try { id = url ? new URL(url).searchParams.get('list') : null; } catch {}
        const titleEl = card.querySelector('a#video-title, a#video-title-link, a.yt-lockup-metadata-view-model__title, #video-title');
        const image = card.querySelector('img');
        const text = (card.textContent || '').replace(/\\s+/g, ' ').trim();
        const count = text.match(/([\\d,]+)\\s+videos?/i);
        return { id, name: (titleEl?.textContent || titleEl?.getAttribute('title') || link?.textContent || '').trim(), videoCount: count ? Number(count[1].replace(/,/g, '')) : null, thumbnail: image?.src || image?.getAttribute('data-thumb') || null };
      });
      const append = (items) => items.forEach((item) => {
        if (item.id && !seen.has(item.id)) { seen.add(item.id); playlists.push(item); }
      });
      append(collect());
      // Playlist pages hydrate additional cards as the feed scrolls. Keep the
      // scrape bounded while giving the page a chance to reveal them.
      let previousHeight = 0;
      for (let i = 0; i < 8 && playlists.length < ${MAX_PLAYLISTS}; i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const height = document.documentElement.scrollHeight;
        if (height === previousHeight) break;
        previousHeight = height;
        append(collect());
      }
      if (playlists.length === 0) return { signedOut: false, playlists: [] };
      return { signedOut: false, playlists: playlists.slice(0, ${MAX_PLAYLISTS}) };
    })()
  `;
}

function buildPlaylistVideosExtractionScript() {
  return `
    (async () => {
      const signedOut = /accounts\\.google\\.com|\\/ServiceLogin/i.test(location.href)
        || (!!document.querySelector('a[href*="ServiceLogin"]') && !document.querySelector('#avatar-btn, button#avatar-btn, #masthead #avatar'));
      if (signedOut) return { signedOut: true, videos: [] };
      const abs = (href) => { try { return new URL(href, location.origin).href; } catch { return href || null; } };
      const seen = new Set();
      const videos = [];
      // Playlist pages can render the same video rows as either legacy rows
      // or rich-grid/lockup cards, depending on the active YouTube frontend.
      const collect = () => Array.from(document.querySelectorAll('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer, ytd-rich-grid-media, yt-lockup-view-model')).map((row) => {
        const titleEl = row.querySelector('a#video-title, a#video-title-link, a.yt-lockup-metadata-view-model__title, #video-title');
        const videoLink = titleEl || row.querySelector('a[href*="watch?v="]');
        const url = videoLink ? abs(videoLink.getAttribute('href')) : null;
        let id = null;
        try { id = url ? new URL(url).searchParams.get('v') : null; } catch {}
        const channelEl = row.querySelector('#byline a, ytd-channel-name a, #channel-name a');
        const image = row.querySelector('img');
        const durationEl = row.querySelector('ytd-thumbnail-overlay-time-status-renderer span, #text.ytd-thumbnail-overlay-time-status-renderer');
        return { id, title: (titleEl?.textContent || titleEl?.getAttribute('title') || '').trim(), channel: (channelEl?.textContent || '').trim() || null, thumbnail: image?.src || image?.getAttribute('data-thumb') || null, duration: (durationEl?.textContent || '').trim() || null };
      });
      const append = (items) => items.forEach((item) => {
        if (item.id && !seen.has(item.id)) { seen.add(item.id); videos.push(item); }
      });
      append(collect());
      let previousHeight = 0;
      for (let i = 0; i < 12 && videos.length < ${MAX_VIDEOS_PER_PLAYLIST}; i++) {
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const height = document.documentElement.scrollHeight;
        if (height === previousHeight) break;
        previousHeight = height;
        append(collect());
      }
      return { signedOut: false, videos: videos.slice(0, ${MAX_VIDEOS_PER_PLAYLIST}) };
    })()
  `;
}

async function loadPage(url) {
  let page = await findOrOpenPage(url).catch(() => null);
  if (!page || isAuthPage(page)) return { page: null, status: page ? 'auth-required' : 'no-browser' };
  if (!/\/feed\/playlists/.test(page.url || '')) {
    // A navigation can tear down the CDP execution context after location.assign
    // runs, which makes evaluateOnPage resolve null even though the page moved.
    await evaluateOnPage(page, `location.assign(${JSON.stringify(url)}); true`).catch(() => null);
    await sleep(NAV_SETTLE_MS);
    const refreshed = (await listCdpPages().catch(() => [])).find((candidate) => candidate.id === page.id);
    if (refreshed) page = refreshed;
  }
  if (isAuthPage(page)) return { page: null, status: 'auth-required' };
  return { page, status: 'ok' };
}

export async function getStoredYoutubePlaylists() {
  return readJSONFile(PLAYLISTS_FILE, null, { strict: true });
}

let syncInFlight = null;

export async function syncYoutubePlaylists() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doSyncYoutubePlaylists().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doSyncYoutubePlaylists() {
  const loaded = await loadPage(PLAYLISTS_URL);
  if (!loaded.page) {
    return loaded.status === 'auth-required'
      ? { ok: false, status: loaded.status, needsAuth: true, error: 'Signed out of YouTube', remediation: 'Log into YouTube in the managed browser, then sync playlists again.' }
      : { ok: false, status: loaded.status, error: 'Managed browser is not running', remediation: 'Start the managed browser, then sync playlists again.' };
  }

  const extracted = await evaluateOnPage(loaded.page, buildPlaylistsExtractionScript()).catch(() => null);
  if (!extracted || !Array.isArray(extracted.playlists)) {
    return { ok: false, status: 'extraction-failed', error: 'Could not read YouTube playlists — the page layout may have changed.' };
  }
  if (extracted.signedOut) {
    return { ok: false, status: 'auth-required', needsAuth: true, error: 'Signed out of YouTube', remediation: 'Log into YouTube in the managed browser, then sync playlists again.' };
  }

  const storedResult = await getStoredYoutubePlaylists()
    .then((value) => ({ value }))
    .catch((error) => ({ error }));
  if (storedResult.error) {
    return { ok: false, status: 'snapshot-unreadable', error: 'Could not read the stored YouTube playlist snapshot; not overwriting it.' };
  }
  const previous = storedResult.value;
  const playlists = [];
  const warnings = [];
  const sourcePlaylists = extracted.playlists.filter((playlist) => playlist?.id && playlist?.name);
  if (!sourcePlaylists.length && previous?.playlists?.length) {
    return {
      ok: false,
      status: 'extraction-empty',
      error: 'No playlists found — keeping the previous snapshot.',
      ...youtubePlaylistSnapshotSummary(previous),
      scanned: extracted.playlists.length,
      failed: 0,
    };
  }
  const deadline = Date.now() + MAX_SYNC_MS;
  const cursorIndex = previous?.nextPlaylistId
    ? sourcePlaylists.findIndex((playlist) => playlist.id === previous.nextPlaylistId)
    : -1;
  const orderedPlaylists = cursorIndex > 0
    ? [...sourcePlaylists.slice(cursorIndex), ...sourcePlaylists.slice(0, cursorIndex)]
    : sourcePlaylists;
  let nextPlaylistId = null;
  let scanned = 0;
  for (let index = 0; index < orderedPlaylists.length; index += 1) {
    const rawPlaylist = orderedPlaylists[index];
    if (Date.now() >= deadline) {
      nextPlaylistId = rawPlaylist.id;
      warnings.push(`Sync stopped after ${Math.round(MAX_SYNC_MS / 60000)} minutes; remaining playlists were not refreshed`);
      orderedPlaylists.slice(index).forEach((remaining) => {
        const stale = previous?.playlists?.find((playlist) => playlist.id === remaining.id);
        playlists.push(stale || normalizeYoutubePlaylist(remaining, []));
      });
      break;
    }
    scanned += 1;
    // Do not use the evaluate result as the navigation verdict: CDP can report
    // a context error while the requested navigation is already in progress.
    await evaluateOnPage(loaded.page, `location.assign(${JSON.stringify(`${PLAYLIST_URL}${encodeURIComponent(rawPlaylist.id)}`)}); true`).catch(() => null);
    await sleep(NAV_SETTLE_MS);
    const refreshed = (await listCdpPages().catch(() => [])).find((candidate) => candidate.id === loaded.page.id);
    if (refreshed) loaded.page = refreshed;
    const detail = await evaluateOnPage(loaded.page, buildPlaylistVideosExtractionScript()).catch(() => null);
    if (!detail || !Array.isArray(detail.videos) || detail.signedOut) {
      warnings.push(`${rawPlaylist.name || 'Playlist'}: could not read videos`);
      const stale = previous?.playlists?.find((playlist) => playlist.id === rawPlaylist.id);
      if (stale) playlists.push(stale);
      continue;
    }
    const normalizedVideos = detail.videos.map(normalizeYoutubeVideo).filter(Boolean);
    if (!normalizedVideos.length && Number.isFinite(rawPlaylist.videoCount) && rawPlaylist.videoCount > 0) {
      warnings.push(`${rawPlaylist.name || 'Playlist'}: no videos read`);
      const stale = previous?.playlists?.find((playlist) => playlist.id === rawPlaylist.id);
      if (stale) playlists.push(stale);
      continue;
    }
    const expectedVideoCount = Number.isFinite(rawPlaylist.videoCount)
      ? Math.min(rawPlaylist.videoCount, MAX_VIDEOS_PER_PLAYLIST)
      : 0;
    if (expectedVideoCount > 0 && normalizedVideos.length < expectedVideoCount * 0.5) {
      warnings.push(`${rawPlaylist.name || 'Playlist'}: only read ${normalizedVideos.length} of ${expectedVideoCount} video(s)`);
      const stale = previous?.playlists?.find((playlist) => playlist.id === rawPlaylist.id);
      if (stale) {
        playlists.push(stale);
        continue;
      }
    }
    const playlist = normalizeYoutubePlaylist(rawPlaylist, normalizedVideos);
    if (playlist) playlists.push(playlist);
  }

  const snapshot = {
    schemaVersion: SNAPSHOT_VERSION,
    syncedAt: new Date().toISOString(),
    playlists,
    warnings,
    ...(nextPlaylistId ? { nextPlaylistId } : {}),
  };
  await ensureDir(dataPath('youtube'));
  await atomicWrite(PLAYLISTS_FILE, snapshot);

  const summary = youtubePlaylistSnapshotSummary(snapshot);
  const result = {
    ok: warnings.length === 0,
    ...summary,
    scanned,
    failed: warnings.length,
    ...(warnings.length ? { warnings } : {}),
  };
  console.log(`📺 YouTube playlists: synced ${summary.playlistCount} playlist(s), ${summary.videoCount} video(s)${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
  return result;
}
