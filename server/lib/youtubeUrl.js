/**
 * Canonical YouTube single-video URL rule (#6014) — the ONE place the server
 * decides "is this a single YouTube video, and which one?".
 *
 * Before this module the same question was answered four different ways: the
 * Takeout importer owned the id parser (so `server/lib/` tests had to import
 * from `server/services/`, inverting the dependency rule), the brain ingest
 * declared its own accept-regex, the Music Video track import declared an OLDER
 * regex that predated `music.youtube.com` / shorts / live / embed support, and
 * the client mirrored all of it a fifth time. The drift was user-visible:
 * pasting a YouTube Music or Shorts link into track import returned
 * `400 YOUTUBE_URL_INVALID` even though yt-dlp handles it and the other two
 * pipelines accepted it.
 *
 * `client/src/lib/youtubeUrl.js` is the browser mirror of this rule (Quick
 * Capture swaps its whole submit path on it); `youtubeUrl.mirror.test.js`
 * asserts the two agree on behavior, so port any change there verbatim.
 *
 * Deliberately narrow: playlists, channels, and `/@handle` pages are NOT
 * matched — a paste that would have yt-dlp pull 300 videos must fail fast
 * rather than silently start a batch download.
 */
import { ServerError } from './errorHandler.js';

/**
 * Accepts every URL shape that carries exactly one video id, across the
 * `www.` / `m.` / `music.` hosts. Playlists, channels, and feeds are rejected.
 */
export const YOUTUBE_VIDEO_URL_RE =
  /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?[^\s#]*\bv=[\w-]{6,}|shorts\/[\w-]{6,}|live\/[\w-]{6,}|embed\/[\w-]{6,})|youtu\.be\/[\w-]{6,})/i;

/**
 * The video id in a YouTube URL, or null. Handles every shape YouTube emits:
 *   watch?v=ID · youtu.be/ID · /shorts/ID · /embed/ID · /live/ID · /v/ID
 * (`/live/` is the permalink a finished livestream keeps — Takeout watch
 * records carry it, so it must resolve rather than be dropped as unrecognized.)
 *
 * The charset is bounded so a garbage query string can't smuggle a giant "id"
 * into a dedupe key. Intentionally looser than `YOUTUBE_VIDEO_URL_RE`: it also
 * answers for URL fragments the Takeout importer meets, so validation callers
 * must test the regex too (see `isYoutubeVideoUrl`).
 */
export function youtubeVideoIdFromUrl(url) {
  if (!url) return null;
  const s = String(url).trim();
  const vParam = /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(s);
  if (vParam) return vParam[1];
  const pathId = /(?:youtu\.be\/|\/shorts\/|\/embed\/|\/live\/|\/v\/)([A-Za-z0-9_-]{6,20})/.exec(s);
  return pathId ? pathId[1] : null;
}

/** Alias matching the client mirror's naming, so both layers read alike. */
export const youtubeVideoId = youtubeVideoIdFromUrl;

/** True when `url` is a single-video YouTube URL the server will accept. */
export function isYoutubeVideoUrl(url) {
  return typeof url === 'string' && YOUTUBE_VIDEO_URL_RE.test(url.trim()) && !!youtubeVideoIdFromUrl(url);
}

/** Shared rejection copy, so the Zod schemas and the services name one rule. */
export const YOUTUBE_URL_INVALID_MESSAGE =
  'Expected a single-video YouTube URL (watch, shorts, live, embed, music.youtube.com, or youtu.be) — playlists and channels are not supported';

/**
 * Validate a URL and hand back the video id it carries — the id has to be
 * parsed to validate at all, so returning it keeps the caller from parsing the
 * same URL a second time (and from disagreeing about the answer).
 */
export function assertYoutubeVideoUrl(url) {
  const videoId = isYoutubeVideoUrl(url) ? youtubeVideoIdFromUrl(url) : null;
  if (!videoId) {
    throw new ServerError(YOUTUBE_URL_INVALID_MESSAGE, { status: 400, code: 'YOUTUBE_URL_INVALID' });
  }
  return videoId;
}
