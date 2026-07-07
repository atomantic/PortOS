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
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import { parseZip, collectZipEntry } from '../lib/zipStream.js';
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

// Resolve a { lat, lng } pair from the several shapes Takeout uses:
//   - E7 integers: `latitudeE7` / `longitudeE7` (degrees × 1e7)
//   - a `latLng` string: "37.421°, -122.084°" or "geo:37.421,-122.084"
// Returns { lat, lng } (rounded) or null when neither yields two finite numbers.
export function resolveLatLng({ latitudeE7, longitudeE7, latLng } = {}) {
  if (Number.isFinite(latitudeE7) && Number.isFinite(longitudeE7)) {
    return { lat: roundCoord(latitudeE7 / 1e7), lng: roundCoord(longitudeE7 / 1e7) };
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

  // Dedupe on the visit start + place identity. Prefer the Google placeId; fall
  // back to rounded lat/lng, then to the title, so two *different* places don't
  // collapse into one visit when a placeId is absent (on-device exports omit it
  // for un-geocoded stops).
  const identity = visit.placeId
    || (visit.lat !== null && visit.lat !== undefined && visit.lng !== null && visit.lng !== undefined
      ? `${visit.lat},${visit.lng}`
      : null)
    || title;
  const dedupeKey = `location:${identity}:${happenedAt}`;

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
  const { lat, lng } = resolveLatLng({
    latitudeE7: Number(loc.latitudeE7),
    longitudeE7: Number(loc.longitudeE7),
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
    const key = c.metadata?.placeId || c.title;
    places.add(key);
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

const isZip = (file) =>
  file?.mimetype === 'application/zip' ||
  file?.mimetype === 'application/x-zip-compressed' ||
  /\.zip$/i.test(file?.originalname || '');

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

// Extract and concatenate the visit intermediates from every location-history
// JSON member of the Takeout ZIP. Non-matching entries are drained and ignored.
async function readVisitsFromZip(filePath) {
  const visits = [];
  const reads = [];
  await new Promise((resolve, reject) => {
    let settled = false;
    const src = createReadStream(filePath);
    const parser = parseZip();
    const settle = (fn) => (...args) => {
      if (settled) return;
      settled = true;
      // On failure, tear down the read + parse pipeline so a large upload with an
      // early error (bad JSON member, corrupt ZIP) doesn't keep reading to EOF.
      if (fn === reject) { src.destroy(); parser.destroy?.(); }
      fn(...args);
    };
    src.on('error', settle(reject));
    src
      .pipe(parser)
      .on('entry', (entry) => {
        if (isLocationJsonEntry(entry.path)) {
          reads.push(
            collectZipEntry(entry)
              .then((buf) => {
                for (const v of extractVisits(parseTakeoutJsonText(buf.toString('utf-8')))) visits.push(v);
              })
              .catch(settle(reject)),
          );
        } else {
          entry.autodrain();
        }
      })
      .on('close', () => Promise.all(reads).then(settle(resolve)).catch(settle(reject)))
      .on('error', settle(reject));
  });
  return visits;
}

// Read visit intermediates from an uploaded file (ZIP export or single JSON).
export async function readTakeoutVisits(file) {
  if (!file?.path) return [];
  if (isZip(file)) return readVisitsFromZip(file.path);
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
