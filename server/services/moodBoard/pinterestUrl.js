import { ServerError } from '../../lib/errorHandler.js';
import { isPinterestHost, normalizePinterestFeedUrl } from '../../lib/pinterestFeed.js';
import { resolvePublicUrl } from '../../lib/safeUrlFetch.js';

// Keep ordinary board URLs synchronous/pure; only a user-supplied share link
// needs network I/O. The API shortener hop is on Pinterest's own domain.
export async function resolvePinterestBoardUrl(input) {
  const url = typeof input === 'string' && URL.canParse(input.trim()) ? new URL(input.trim()) : null;
  if (url?.hostname !== 'pin.it') return normalizePinterestFeedUrl(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new ServerError('Use an http(s) Pinterest share link', { status: 400, code: 'INVALID_PINTEREST_URL' });
  }
  url.protocol = 'https:';
  const resolved = await resolvePublicUrl(url.href, {
    timeoutMs: 8000,
    maxRedirects: 3,
    blockPrivate: true,
    allowUrl: (hop) => hop.protocol === 'https:' && !hop.username && !hop.password && !hop.port
      && (hop.hostname === 'pin.it' || isPinterestHost(hop.hostname)),
  });
  if (!resolved) {
    throw new ServerError('Could not resolve this Pinterest share link to a board; try its full board URL', {
      status: 400, code: 'INVALID_PINTEREST_URL',
    });
  }
  return normalizePinterestFeedUrl(resolved);
}
