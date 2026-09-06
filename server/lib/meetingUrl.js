/**
 * Selection of the ONE join link worth caching out of a raw Google Calendar
 * event, plus the bound both the HTTP ingress and the selector enforce.
 *
 * Pure and dependency-light on purpose: the push route (`routes/calendar.js`)
 * needs `MEETING_URL_MAX` at schema-construction time, and the sync service
 * (`services/calendarGoogleSync.js`) needs the selector — so a single copy has
 * to live somewhere neither one's test suite mocks. Route suites factory-mock
 * the sync service wholesale, which would leave an imported bound `undefined`
 * before Zod ever saw it; nothing mocks `server/lib/`.
 */

import { isSafeHref } from './isSafeHref.js';

/**
 * Upper bound for a conference URL, enforced at the HTTP boundary (a longer one
 * fails route validation) and again at selection (a longer one is not chosen).
 * Google's own join links sit two orders of magnitude below this; the cap
 * exists so a hostile or malformed payload can't push an unbounded string into
 * the local event cache.
 */
export const MEETING_URL_MAX = 1300;

/**
 * Pick the join URL to cache for a raw Google event.
 *
 * `conferenceData.entryPoints` is the modern shape — it also carries `phone`,
 * `sip` and `more` entries plus dial-in PINs and conference passwords, so only
 * a `video` entry's `uri` is considered and nothing else from that object is
 * returned. `hangoutLink` is the legacy field and the fallback. `htmlLink` is
 * deliberately NOT a candidate: it opens the calendar event, not the meeting.
 *
 * THREE-STATE by design, following the repo's sentinel convention — the caller
 * must be able to tell "this producer never described conferencing" from "this
 * producer described it and there is none", or every legacy push would read as
 * "the meeting lost its link" and wipe a working Join action:
 *
 *   `undefined` — the event carried NEITHER raw field. An older or partial
 *                 producer; preserve whatever is already cached.
 *   `null`      — conferencing WAS described, and nothing usable came of it
 *                 (absent, empty, unsafe scheme, or over-long). Clear the link.
 *   `string`    — a validated http(s) URL to cache.
 *
 * A DEFINED value on either raw field is what separates the first two, so an
 * explicit `null` from the producer still counts as "described" — which is
 * exactly why the direct-API mapper emits nulls rather than omitting the keys.
 * (A JS caller passing a literal `undefined` therefore reads as "not
 * described", the same as omitting it; across the JSON boundary every real
 * producer crosses, the two are indistinguishable anyway.)
 *
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
 * Is this the `video` entry type, ignoring surrounding whitespace and case?
 *
 * Matched leniently on purpose. A producer that sends `" video "` plainly means
 * the video entry, and an exact-match test would skip it and silently fall back
 * to the legacy `hangoutLink` — a DIFFERENT meeting, not merely a missing one.
 * It also keeps the three ingress paths agreeing: the push route trims its
 * strings, so a strict match here would make the same event resolve one way
 * over HTTP and another over the API/MCP relays.
 */
function isVideoEntry(entryPointType) {
  return typeof entryPointType === 'string' && entryPointType.trim().toLowerCase() === 'video';
}

/**
 * A trimmed, bounded, http(s) URL in NORMALIZED form — or null when the
 * candidate is unusable.
 *
 * The normalization is what keeps the write side and the read side agreeing.
 * `isSafeHref` parses with `new URL()`, which accepts scheme-relative forms
 * like `https:meet.example.com` that resolve fine in a browser; the client's
 * render-time re-check (`isHttpUrl` in `client/src/utils/urlNormalize.js`) is a
 * `^https?://` prefix regex that does not. Storing `new URL(url).href` — which
 * is always `scheme://host/…` — means anything this function accepts is
 * something the drawer will render, instead of a link silently cached and then
 * hidden. The cap is applied to the stored form for the same reason.
 */
function usableMeetingUrl(candidate) {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > MEETING_URL_MAX) return null;
  if (!isSafeHref(trimmed)) return null;
  const normalized = new URL(trimmed).href;
  return normalized.length > MEETING_URL_MAX ? null : normalized;
}
