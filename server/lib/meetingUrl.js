/**
 * Selects the one cacheable join URL (`selectMeetingUrl`) out of a raw Google Calendar event — first
 * http(s) `video` entry point, else `hangoutLink` — and owns the shared `MEETING_URL_MAX` bound.
 *
 * Lives in lib/ because route suites factory-mock the sync service wholesale, which would leave an
 * imported bound `undefined` at schema construction; nothing mocks lib/.
 */

import { isSafeHref } from './isSafeHref.js';

// Enforced at the HTTP boundary and at selection so a hostile payload can't bloat the event cache.
export const MEETING_URL_MAX = 1300;

/**
 * Only a `video` entry point's `uri` is considered (entryPoints also carry dial-in PINs and passwords);
 * `hangoutLink` is the fallback; `htmlLink` is NOT a candidate (it opens the event, not the meeting).
 *
 * Three-state so a legacy push doesn't wipe a working Join action: `undefined` = neither raw field
 * present (preserve the cache); `null` = described but nothing usable (clear); string = validated URL.
 * @param {object} event raw Google Calendar event
 * @returns {string|null|undefined}
 */
export function selectMeetingUrl(event) {
  const hangoutLink = event?.hangoutLink;
  const conferenceData = event?.conferenceData;
  if (hangoutLink === undefined && conferenceData === undefined) return undefined;

  const entryPoints = Array.isArray(conferenceData?.entryPoints) ? conferenceData.entryPoints : [];
  for (const entryPoint of entryPoints) {
    if (!isVideoEntry(entryPoint?.entryPointType)) continue;
    const url = usableMeetingUrl(entryPoint.uri);
    if (url) return url;
  }
  return usableMeetingUrl(hangoutLink) ?? null;
}

/**
 * Lenient (trim, case-insensitive) so `" video "` doesn't silently fall back to `hangoutLink`, a
 * DIFFERENT meeting; also keeps HTTP and API/MCP ingress agreeing (the push route trims).
 */
function isVideoEntry(entryPointType) {
  return typeof entryPointType === 'string' && entryPointType.trim().toLowerCase() === 'video';
}

/**
 * Returns the normalized `new URL(url).href`, or null. `isSafeHref` accepts scheme-relative forms like
 * `https:meet.example.com` that the client's `^https?://` re-check (`isHttpUrl`) rejects; storing the
 * normalized form keeps every cached link renderable. The cap applies to the stored form.
 */
function usableMeetingUrl(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MEETING_URL_MAX) return null;
  if (!isSafeHref(trimmed)) return null;
  const normalized = new URL(trimmed).href;
  return normalized.length > MEETING_URL_MAX ? null : normalized;
}
