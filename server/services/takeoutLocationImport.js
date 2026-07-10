/**
 * Google Takeout Location History importer (#2160) — bulk historical backfill
 * into the human-activity timeline.
 *
 * Google's "Location History (Timeline)" Takeout export contains, per month, a
 * `Semantic Location History/YYYY/YYYY_MONTH.json` file describing where you
 * were. Two shapes exist across export vintages:
 *
 *   - Classic semantic history (server-side Timeline, pre-2024): a top-level
 *     `{ timelineObjects: [{ placeVisit: { location, duration }, ... }] }`. Each
 *     `placeVisit` carries `location.{ name, address, placeId, latitudeE7,
 *     longitudeE7, semanticType }` and `duration.{ startTimestamp, endTimestamp }`
 *     (older files use epoch-ms `startTimestampMs` / `endTimestampMs`).
 *   - On-device Timeline export (2024+): a top-level `{ semanticSegments: [{
 *     startTime, endTime, visit: { topCandidate: { placeId, semanticType,
 *     placeLocation: { latLng } } } }] }`, where `latLng` is a
 *     `"37.4°, -122.0°"` (or `"geo:lat,lng"`) string.
 *
 * We map every place VISIT (not travel/activity segments) to a `place.visit`
 * activity event under source `location`. Travel segments carry no
 * autobiographical "where was I" signal at the granularity the timeline cares
 * about, so they're dropped.
 *
 * Idempotent: every candidate carries a stable `dedupeKey` (place identity +
 * visit start instant), so re-importing the same export — or an overlapping
 * newer one — is a no-op via `recordEvents`'s `ON CONFLICT DO NOTHING`. No
 * AI-provider calls; parsing is deterministic and LLM-free.
 */
import { readFile } from 'fs/promises';
import { collectZipEntries, isZipUpload } from '../lib/zipStream.js';
import { shortSummary, recordEvents } from './humanActivity.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects).
// ---------------------------------------------------------------------------

// Resolve a Takeout visit timestamp to a UTC ISO string, or null if unparseable.
// Classic files use ISO-8601 with a `Z` (`startTimestamp`); older classic files
// use an epoch-ms string (`startTimestampMs`); on-device files use ISO with an
// offset. A bare all-digits value is treated as epoch milliseconds.
export function resolveTakeoutInstant(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const d = new Date(Number(s));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Round a coordinate to ~6 decimal places (≈0.1m) for a stable dedupe fallback
// and compact metadata; returns null for non-finite input.
function roundCoord(n) {
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

// Coerce a raw value to a finite number, rejecting nullish/blank — `Number(null)`
// and `Number('')` are both a (misleading) 0, which would otherwise turn a
// coord-less classic visit into a real {lat:0,lng:0} on the Gulf of Guinea.
function toFiniteNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Resolve a { lat, lng } pair from the several shapes Takeout uses:
//   - E7 integers: `latitudeE7` / `longitudeE7` (degrees × 1e7)
//   - a `latLng` string: "37.421°, -122.084°" or "geo:37.421,-122.084"
// Returns { lat, lng } (rounded) or null when neither yields two finite numbers.
// Raw E7 values are coerced here (rejecting nullish/blank) so callers don't have
// to pre-`Number()` them — which would smuggle a null through as 0.
export function resolveLatLng({ latitudeE7, longitudeE7, latLng } = {}) {
  const latE7 = toFiniteNumber(latitudeE7);
  const lngE7 = toFiniteNumber(longitudeE7);
  if (latE7 !== null && lngE7 !== null) {
    return { lat: roundCoord(latE7 / 1e7), lng: roundCoord(lngE7 / 1e7) };
  }
  if (typeof latLng === 'string' && latLng.trim()) {
    const nums = latLng.replace(/geo:/i, '').match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 2) {
      const lat = roundCoord(Number(nums[0]));
      const lng = roundCoord(Number(nums[1]));
      if (lat !== null && lng !== null) return { lat, lng };
    }
  }
  return null;
}

// Human-readable label for a place. Google semantic types come through as
// `TYPE_HOME` / `TYPE_WORK` / `HOME` / `INFERRED_WORK` etc. — normalize the
// common ones to a friendly word; pass anything else through title-cased.
export function friendlySemanticType(type) {
  if (!type) return null;
  const norm = String(type).replace(/^TYPE_/, '').replace(/^INFERRED_/, '').trim().toUpperCase();
  if (!norm || norm === 'UNKNOWN') return null;
  const map = { HOME: 'Home', WORK: 'Work', SEARCHED_ADDRESS: 'Searched address' };
  if (map[norm]) return map[norm];
  return norm
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Stable identity for a place, used BOTH for the dedupe key and the preview's
// unique-place count so the two never diverge. Prefer the Google placeId; fall
// back to rounded lat/lng, then to the title — so two *different* places don't
// collapse when a placeId is absent (on-device exports omit it for un-geocoded
// stops). `title` is the already-resolved display label.
export function placeIdentity({ placeId, lat, lng }, title) {
  if (placeId) return placeId;
  if (lat !== null && lat !== undefined && lng !== null && lng !== undefined) return `${lat},${lng}`;
  return title;
}

// Map ONE normalized visit intermediate to an activity candidate, or null if it
// lacks a usable start instant. Shared by both export shapes.
//   visit = { startTime, endTime, name, address, placeId, lat, lng, semanticType }
export function visitToCandidate(visit) {
  if (!visit || typeof visit !== 'object') return null;
  const happenedAt = resolveTakeoutInstant(visit.startTime);
  if (!happenedAt) return null;
  const endAt = resolveTakeoutInstant(visit.endTime);

  const friendly = friendlySemanticType(visit.semanticType);
  const title = visit.name || visit.address || friendly || 'Place visit';

  const durationS = endAt
    ? Math.max(0, Math.round((new Date(endAt).getTime() - new Date(happenedAt).getTime()) / 1000))
    : null;

  // Dedupe on the visit start + place identity.
  const dedupeKey = `location:${placeIdentity(visit, title)}:${happenedAt}`;

  // Summary keeps a short human line (address, else the friendly type) — never a
  // full record. Drop the address when it's identical to the title to avoid "X — X".
  const summaryText = visit.address && visit.address !== title ? visit.address : friendly;

  return {
    source: 'location',
    kind: 'place.visit',
    happenedAt,
    durationS: durationS && durationS > 0 ? durationS : null,
    title,
    summary: summaryText ? shortSummary(summaryText) : null,
    dedupeKey,
    metadata: {
      placeId: visit.placeId || null,
      address: visit.address || null,
      semanticType: visit.semanticType || null,
      lat: visit.lat ?? null,
      lng: visit.lng ?? null,
      endTime: endAt,
    },
  };
}

// Extract normalized visit intermediates from ONE classic `placeVisit` object.
function normalizeClassicPlaceVisit(placeVisit) {
  if (!placeVisit || typeof placeVisit !== 'object') return null;
  const loc = placeVisit.location || {};
  const dur = placeVisit.duration || {};
  // Pass the raw E7 values — resolveLatLng coerces + rejects nullish/blank, so a
  // coord-less visit stays {lat:null,lng:null} instead of collapsing to 0,0.
  const { lat, lng } = resolveLatLng({
    latitudeE7: loc.latitudeE7,
    longitudeE7: loc.longitudeE7,
  }) || {};
  return {
    startTime: dur.startTimestamp ?? dur.startTimestampMs ?? null,
    endTime: dur.endTimestamp ?? dur.endTimestampMs ?? null,
    name: loc.name || null,
    address: loc.address || null,
    placeId: loc.placeId || null,
    semanticType: loc.semanticType || null,
    lat: lat ?? null,
    lng: lng ?? null,
  };
}

// Extract normalized visit intermediates from ONE on-device `semanticSegments`
// entry that carries a `visit` (skips activity/travel segments → null).
function normalizeSegmentVisit(segment) {
  if (!segment || typeof segment !== 'object' || !segment.visit) return null;
  const cand = segment.visit.topCandidate || {};
  const { lat, lng } = resolveLatLng({ latLng: cand.placeLocation?.latLng }) || {};
  return {
    startTime: segment.startTime ?? null,
    endTime: segment.endTime ?? null,
    name: cand.name || null,
    address: cand.address || null,
    placeId: cand.placeId || null,
    semanticType: cand.semanticType || null,
    lat: lat ?? null,
    lng: lng ?? null,
  };
}

// Turn ONE parsed Takeout file object into normalized visit intermediates,
// handling both export shapes and a bare `placeVisit`/`visit` array. Non-visit
// entries (travel segments) are dropped.
export function extractVisits(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  const out = [];
  if (Array.isArray(parsed.timelineObjects)) {
    for (const obj of parsed.timelineObjects) {
      if (obj?.placeVisit) {
        const v = normalizeClassicPlaceVisit(obj.placeVisit);
        if (v) out.push(v);
      }
    }
  }
  if (Array.isArray(parsed.semanticSegments)) {
    for (const seg of parsed.semanticSegments) {
      const v = normalizeSegmentVisit(seg);
      if (v) out.push(v);
    }
  }
  return out;
}

// Map a batch of visit intermediates to candidates, dropping the unmappable ones.
export function takeoutLocationCandidates(visits = []) {
  if (!Array.isArray(visits)) return [];
  return visits.map(visitToCandidate).filter(Boolean);
}

// Summarize a candidate batch for the import preview: date range, visit count,
// unique places, and the most-visited place labels. Pure over candidates.
export function summarizeLocationCandidates(candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  let earliest = null;
  let latest = null;
  const places = new Set();
  const placeCounts = new Map();
  for (const c of list) {
    if (c.happenedAt) {
      if (!earliest || c.happenedAt < earliest) earliest = c.happenedAt;
      if (!latest || c.happenedAt > latest) latest = c.happenedAt;
    }
    // Same identity logic as the dedupe key so preview's unique count can't
    // diverge from what actually lands (placeId → lat,lng → title).
    places.add(placeIdentity(c.metadata || {}, c.title));
    placeCounts.set(c.title, (placeCounts.get(c.title) || 0) + 1);
  }
  const topPlaces = [...placeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return {
    visits: list.length,
    uniquePlaces: places.size,
    from: earliest,
    to: latest,
    topPlaces,
  };
}

// Parse the text of a single Takeout location JSON file into a parsed object.
// Throws only on malformed JSON; `extractVisits` handles the shape dispatch.
export function parseTakeoutJsonText(text) {
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// File ingestion (ZIP or single JSON) → visit intermediates.
// ---------------------------------------------------------------------------

// A semantic-location-history JSON member inside the Takeout ZIP. Google names
// per-month files `2021_JANUARY.json` under a `Semantic Location History/YYYY/`
// folder; the on-device export ships a single `location-history.json` /
// `Timeline.json`. We deliberately DON'T match `Records.json` (raw GPS points —
// enormous, no place visits) or other Takeout JSON.
const isLocationJsonEntry = (entryPath) => {
  const path = String(entryPath || '');
  if (!/\.json$/i.test(path)) return false;
  if (/(?:^|\/)Records\.json$/i.test(path)) return false;
  return (
    /Semantic Location History\//i.test(path) ||
    /(?:^|\/)\d{4}_[A-Z]+\.json$/i.test(path) ||
    /(?:^|\/)(?:location-history|Timeline)\.json$/i.test(path)
  );
};

// Read visit intermediates from an uploaded file (ZIP export or single JSON).
// The ZIP path delegates the whole streaming lifecycle (teardown, autodrain,
// per-entry await) to `collectZipEntries`, leaving only the match/parse callbacks.
export async function readTakeoutVisits(file) {
  if (!file?.path) return [];
  if (isZipUpload(file)) {
    const visits = [];
    await collectZipEntries(file.path, {
      match: isLocationJsonEntry,
      onMatch: (buf) => {
        for (const v of extractVisits(parseTakeoutJsonText(buf.toString('utf-8')))) visits.push(v);
      },
    });
    return visits;
  }
  const text = await readFile(file.path, 'utf-8');
  return extractVisits(parseTakeoutJsonText(text));
}

// End-to-end import seam: read the file → map → (preview | record). Returns
// counts + a preview summary. `dryRun` parses and summarizes WITHOUT writing so
// the UI can show the user what will be imported before they commit. Because
// `recordEvents` is idempotent, committing (or re-committing) is always safe.
export async function importTakeoutLocationHistory(file, { dryRun = false } = {}) {
  const visits = await readTakeoutVisits(file);
  const candidates = takeoutLocationCandidates(visits);
  const summary = summarizeLocationCandidates(candidates);
  if (dryRun) {
    console.log(`📍 Takeout location import preview: ${candidates.length} visit(s) from ${visits.length} record(s)`);
    return { dryRun: true, parsed: visits.length, mapped: candidates.length, recorded: 0, skipped: 0, summary };
  }
  const { recorded, skipped } = await recordEvents(candidates);
  console.log(`📍 Takeout location import: ${recorded} new visit(s) recorded, ${skipped} duplicate/invalid (from ${visits.length} record(s))`);
  return { dryRun: false, parsed: visits.length, mapped: candidates.length, recorded, skipped, summary };
}
