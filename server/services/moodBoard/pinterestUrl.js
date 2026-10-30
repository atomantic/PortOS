import { ServerError } from '../../lib/errorHandler.js';
import { isPinterestHost, normalizePinterestFeedUrl } from '../../lib/pinterestFeed.js';
import { resolvePublicUrl } from '../../lib/safeUrlFetch.js';

// Only share links need network I/O; board linking and one-shot imports share
// the same bounded, SSRF-checked redirect policy.
async function resolvePinterestUrl(input) {
  const url = typeof input === 'string' && URL.canParse(input.trim()) ? new URL(input.trim()) : null;
  if (url?.hostname !== 'pin.it') return input;
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
    throw new ServerError('Could not resolve this Pinterest share link; try its full Pinterest URL', {
      status: 400, code: 'INVALID_PINTEREST_URL',
    });
  }
  return resolved;
}

export async function resolvePinterestBoardUrl(input) {
  return normalizePinterestFeedUrl(await resolvePinterestUrl(input));
}

export async function resolvePinterestImportUrl(input) {
  const resolved = await resolvePinterestUrl(input);
  const url = typeof resolved === 'string' && URL.canParse(resolved.trim()) ? new URL(resolved.trim()) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
    || !isPinterestHost(url.hostname)) {
    throw new ServerError('Use a Pinterest Pin or board URL', { status: 400, code: 'INVALID_PINTEREST_URL' });
  }
  // Share links land on /pin/<id>/sent/?invite_code=…, so tolerate one trailing segment.
  const pinId = url.pathname.match(/^\/pin\/(\d+)(?:\/[^/]*)?\/?$/)?.[1];
  if (pinId) return { pinUrl: `https://www.pinterest.com/pin/${pinId}/` };
  return normalizePinterestFeedUrl(url.href);
}
