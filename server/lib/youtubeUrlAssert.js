/**
 * The throwing form of the canonical YouTube single-video URL rule.
 *
 * `assertYoutubeVideoUrl(url)` — the throwing form of the `youtubeUrl.js` rule: returns the video id,
 * else throws 400 `YOUTUBE_URL_INVALID`. Separate because it needs `ServerError` (and so Node's
 * `events`), which must stay out of the pure leaf the client re-exports.
 *
 * Split out of `youtubeUrl.js` so that module stays a pure leaf the browser
 * bundle can import (`client/src/lib/youtubeUrl.js` re-exports it):
 * `ServerError` reaches for Node's `events`, which has no place in the client
 * build. Route/service callers that want the 400 keep importing this wrapper.
 */
import { ServerError } from './errorHandler.js';
import { isYoutubeVideoUrl, youtubeVideoIdFromUrl, YOUTUBE_URL_INVALID_MESSAGE } from './youtubeUrl.js';

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
