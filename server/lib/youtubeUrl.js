/**
 * Canonical YouTube single-video URL rule (#6014): the ONE place the server decides "is this a single YouTube video, and which one?".
 *
 * It was answered four ways (the Takeout importer owned the id parser so `server/lib/` tests imported from `server/services/`, inverting the dependency rule; brain ingest had its own regex; Music Video track import had an OLDER one predating `music.youtube.com` / shorts / live / embed, so a YouTube Music or Shorts link returned `400 YOUTUBE_URL_INVALID` though yt-dlp handles it; the client mirrored it a fifth time). A pure leaf: `client/src/lib/youtubeUrl.js` re-exports it (Quick Capture swaps its submit path on the predicate), so no Node built-in and nothing outside `server/lib` (the throwing form is in `youtubeUrlAssert.js`). Deliberately narrow: playlists, channels and `/@handle` pages are NOT matched (a paste that would have yt-dlp pull 300 videos must fail fast).
 */

/** Accepts every URL shape carrying exactly one video id across the `www.` / `m.` / `music.` hosts; playlists, channels and feeds are rejected. */
export const YOUTUBE_VIDEO_URL_RE =
  /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?[^\s#]*\bv=[\w-]{6,}|shorts\/[\w-]{6,}|live\/[\w-]{6,}|embed\/[\w-]{6,})|youtu\.be\/[\w-]{6,})/i;

/**
 * The video id in a YouTube URL, or null. Handles `watch?v=ID` · `youtu.be/ID` · `/shorts/ID` · `/embed/ID` · `/live/ID` · `/v/ID` (`/live/` is a finished livestream's permalink, which Takeout watch records carry). The charset is bounded so a garbage query can't smuggle a giant "id" into a dedupe key;
 * intentionally looser than `YOUTUBE_VIDEO_URL_RE` (it also answers for URL fragments the Takeout importer meets), so validation callers must test the regex too (see `isYoutubeVideoUrl`).
 */
export function youtubeVideoIdFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  const vParam = /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(s);
  if (vParam) return vParam[1];
  const pathId = /(?:youtu\.be\/|\/shorts\/|\/embed\/|\/live\/|\/v\/)([A-Za-z0-9_-]{6,20})/.exec(s);
  return pathId ? pathId[1] : null;
}

/** True when `url` is a single-video YouTube URL the server will accept. */
export function isYoutubeVideoUrl(url) {
  return typeof url === 'string' && YOUTUBE_VIDEO_URL_RE.test(url.trim()) && !!youtubeVideoIdFromUrl(url);
}

/** Shared rejection copy, so the Zod schemas and the services name one rule. */
export const YOUTUBE_URL_INVALID_MESSAGE =
  'Expected a single-video YouTube URL (watch, shorts, live, embed, music.youtube.com, or youtu.be) — playlists and channels are not supported';
