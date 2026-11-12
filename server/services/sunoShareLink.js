/**
 * Suno share links (`suno.com/s/<code>`, what Suno's Share button copies)
 * resolved to the song they point at. The share link is a redirect to the
 * song page; it is followed on Suno's own hosts only.
 */
import { fetchPublicText, resolvePublicUrl } from '../lib/safeUrlFetch.js';
import { isSunoHost, isSunoSongUrl, parseSunoSongPage, sunoSongIdFromUrl } from '../lib/sunoSong.js';

const TIMEOUT_MS = 20_000;
const SONG_PAGE_MAX_BYTES = 5 * 1024 * 1024;
// Suno serves its pages to browsers; a bare fetch user agent can get a challenge page instead.
export const SUNO_FETCH_HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };

/** The canonical song page for a song id. */
export const canonicalSunoSongUrl = (songId) => `https://suno.com/song/${songId}`;

/** A song's page the way an anonymous visitor sees it; null when Suno won't serve it. */
export const fetchSunoSongPage = (songId, deps = {}) => (deps.fetchText || fetchPublicText)(canonicalSunoSongUrl(songId), {
  timeoutMs: TIMEOUT_MS, headers: SUNO_FETCH_HEADERS, maxBytes: SONG_PAGE_MAX_BYTES, throwOnUnsafe: false,
}).catch(() => null);

/**
 * The title Suno shows for a song now, '' when its page gives none. A song
 * renamed on Suno keeps its id and not its name, so anything that looks it up
 * by name there has to ask for the current one.
 */
export async function readSunoSongTitle(songId, deps = {}) {
  return parseSunoSongPage(await fetchSunoSongPage(songId, deps) || '', songId).title;
}

/** True for a Suno share link: a Suno song link that carries no song id until resolved. */
export const isSunoShareLink = (url) => isSunoSongUrl(url) && !sunoSongIdFromUrl(url);

/** The song id a Suno song page or share link leads to; throws when a share link leads nowhere. */
export async function resolveSunoSongId(url, deps = {}) {
  const direct = sunoSongIdFromUrl(url);
  if (direct) return direct;
  const finalUrl = await (deps.resolveUrl || resolvePublicUrl)(String(url).trim(), {
    timeoutMs: TIMEOUT_MS, headers: SUNO_FETCH_HEADERS, allowUrl: (u) => u.protocol === 'https:' && isSunoHost(u.hostname),
  });
  const songId = sunoSongIdFromUrl(finalUrl);
  if (!songId) throw new Error('That Suno link did not lead to a song page');
  return songId;
}

/**
 * `url` with a share link swapped for its song page; any other value (a song
 * page, an empty or unrelated string) comes back unchanged.
 */
export async function canonicalizeSunoUrl(url, deps = {}) {
  if (!isSunoShareLink(url)) return url;
  return canonicalSunoSongUrl(await resolveSunoSongId(url, deps));
}
