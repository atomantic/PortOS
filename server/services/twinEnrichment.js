/**
 * Digital-Twin Enrichment from observed behavior (Human Activity Tracking
 * Phase 7, #2156).
 *
 * Turns the machine-local Human Activity timeline (#2150) into LLM-free
 * *evidence* records that supplement — never overwrite — the questionnaire-based
 * digital twin:
 *
 *   - `media.listen` / `media.watch` rollups (top artists / genres / channels /
 *     topics per week + month, novelty-vs-repeat ratio) → `taste-observed.json`,
 *     a taste-profile evidence record with `source: 'observed'` provenance.
 *   - An hourly activity histogram (messages sent, meetings, media consumed by
 *     LOCAL hour) → `chronotype-observed.json`, chronotype evidence sitting
 *     alongside the stated `chronotype.json`.
 *
 * Both files carry `source: 'observed'` and a `derivedAt` stamp, live under
 * `data/digital-twin/`, and federate via `digital-twin-sync.js` (LWW on
 * `derivedAt` — newest observation wins). The *stated* records (taste-profile
 * questionnaire, genome/behavioral chronotype) are never touched here: the UI
 * surfaces both side-by-side and flags divergence, which is signal, not error.
 *
 * Aggregation is deterministic and LLM-free — safe to run incrementally after
 * each source sync or on a daily rollup tick with no user consent (no provider
 * calls). The ONLY provider call is `interpretConsumption()`, invoked strictly
 * from an explicit user-action route (the "what does my consumption say about
 * me" button), per CLAUDE.md's AI-provider policy (no cold-bootstrap calls).
 */

import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { query, ensureSchema } from '../lib/db.js';
import { getLocalParts, getUserTimezone } from '../lib/timezone.js';
import { getProviderById } from './providers.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';

const DIR = PATHS.digitalTwin;
const TASTE_OBSERVED_FILE = join(DIR, 'taste-observed.json');
const CHRONOTYPE_OBSERVED_FILE = join(DIR, 'chronotype-observed.json');

// How far back each rollup window reaches, in days.
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
// Chronotype histogram window — a month of activity smooths day-to-day noise.
const CHRONOTYPE_WINDOW_DAYS = 30;
// Safety cap on a single windowed fetch. A month of media + messages is well
// under this; the ceiling only guards a pathological backfill from loading the
// whole table into memory.
const FETCH_CAP = 50000;

const MEDIA_LISTEN = 'media.listen';
const MEDIA_WATCH = 'media.watch';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no side effects).
// ---------------------------------------------------------------------------

// Tally an array of string keys into a sorted [{ name, count }] top-N list.
// Blank/nullish keys are skipped. Ties break alphabetically for a stable order
// (the file feeds the federation checksum — unstable order never converges).
export function topCounts(keys, limit = 10) {
  const counts = new Map();
  for (const raw of keys || []) {
    const name = String(raw ?? '').trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map(([name, count]) => ({ name, count }));
}

// Novelty vs repeat for a window of plays. `keys` is one entry per play (e.g.
// each track id every time it was played). Distinct items are the "novel" set;
// plays beyond the first of each item are "repeats". noveltyRatio = distinct /
// total (1.0 = never repeats anything; →0 = heavy repetition). total 0 → nulls
// so an empty window reads as "no signal", not "0% novel".
export function noveltyRatio(keys) {
  const list = (keys || []).map((k) => String(k ?? '').trim()).filter(Boolean);
  const total = list.length;
  if (total === 0) return { total: 0, distinct: 0, repeats: 0, noveltyRatio: null };
  const distinct = new Set(list).size;
  const ratio = Math.round((distinct / total) * 1000) / 1000;
  return { total, distinct, repeats: total - distinct, noveltyRatio: ratio };
}

// Flatten a listen event's artist names across the live-sync AND import shapes:
//   - spotifySync:   metadata.artists = [{ id, name }]
//   - spotifyImport: metadata.artist  = single (album-artist) string
// falling back to the comma-joined summary line only when neither is present.
// Reading metadata.artist directly avoids the import summary's "Artist — Album"
// form leaking the album into the artist tally.
export function listenArtistNames(ev) {
  const artists = ev?.metadata?.artists;
  if (Array.isArray(artists)) {
    const names = artists.map((a) => String((typeof a === 'string' ? a : a?.name) || '').trim()).filter(Boolean);
    if (names.length) return names;
  }
  const single = ev?.metadata?.artist;
  if (single) {
    const names = String(single).split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length) return names;
  }
  const summary = String(ev?.summary || '').trim();
  return summary ? summary.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// Genre names for a listen event (metadata.genres: [string] | [{ name }]).
// Spotify's recently-played endpoint omits genres today, so this is usually
// empty — supported now so a future genre-enriched source flows straight in.
export function listenGenreNames(ev) {
  const genres = ev?.metadata?.genres;
  if (!Array.isArray(genres)) return [];
  return genres.map((g) => String((typeof g === 'string' ? g : g?.name) || '').trim()).filter(Boolean);
}

// A stable per-play key for novelty counting. Track identity across both source
// shapes: sync's `trackId`, import's `trackUri`, then isrc, then title —
// falling to dedupeKey only as a last resort (per-play, so it never collapses
// repeats, which is the safe direction). Using trackUri keeps two different
// imported tracks that share a title from collapsing into one "repeat".
function listenNoveltyKey(ev) {
  return ev?.metadata?.trackId || ev?.metadata?.trackUri || ev?.metadata?.isrc || ev?.title || ev?.dedupeKey || '';
}
function watchNoveltyKey(ev) {
  return ev?.metadata?.videoId || ev?.url || ev?.title || ev?.dedupeKey || '';
}

// Roll up media.listen events into taste evidence: top artists, top genres,
// novelty. `topN` bounds each list.
export function rollupListen(events, topN = 10) {
  const listens = (events || []).filter((e) => e?.kind === MEDIA_LISTEN);
  const artistKeys = [];
  const genreKeys = [];
  for (const ev of listens) {
    artistKeys.push(...listenArtistNames(ev));
    genreKeys.push(...listenGenreNames(ev));
  }
  return {
    total: listens.length,
    topArtists: topCounts(artistKeys, topN),
    topGenres: topCounts(genreKeys, topN),
    novelty: noveltyRatio(listens.map(listenNoveltyKey)),
  };
}

// Roll up media.watch events into taste evidence: top channels, top topics,
// novelty.
export function rollupWatch(events, topN = 10) {
  const watches = (events || []).filter((e) => e?.kind === MEDIA_WATCH);
  const channelKeys = [];
  const topicKeys = [];
  for (const ev of watches) {
    const channel = ev?.metadata?.channel || ev?.summary;
    if (channel) channelKeys.push(channel);
    const topics = ev?.metadata?.topics;
    if (Array.isArray(topics)) topicKeys.push(...topics.map((t) => String(t ?? '').trim()).filter(Boolean));
  }
  return {
    total: watches.length,
    topChannels: topCounts(channelKeys, topN),
    topTopics: topCounts(topicKeys, topN),
    novelty: noveltyRatio(watches.map(watchNoveltyKey)),
  };
}

const MESSAGE_SENT = 'message.sent';
const MEETING = 'calendar.event';

// Bucket events into a 24-slot local-hour histogram with per-category counts:
// [{ hour, messages, meetings, media, total }]. Only OUTBOUND messages
// (message.sent) count toward the chronotype signal — received messages reflect
// others' schedules, not the user's. Media = listen + watch. Timezone drives the
// local hour so an event at 23:30 UTC lands in the user's evening, not UTC's.
export function chronotypeHistogram(events, timezone) {
  const slots = Array.from({ length: 24 }, (_, hour) => ({ hour, messages: 0, meetings: 0, media: 0, total: 0 }));
  for (const ev of events || []) {
    const d = new Date(ev?.happenedAt ?? ev?.happened_at);
    if (Number.isNaN(d.getTime())) continue;
    const { hour } = getLocalParts(d, timezone);
    if (!(hour >= 0 && hour < 24)) continue;
    const slot = slots[hour];
    if (ev.kind === MESSAGE_SENT) slot.messages += 1;
    else if (ev.kind === MEETING) slot.meetings += 1;
    else if (ev.kind === MEDIA_LISTEN || ev.kind === MEDIA_WATCH) slot.media += 1;
    else continue; // received messages / unknown kinds aren't a self-timing signal
    slot.total = slot.messages + slot.meetings + slot.media;
  }
  return slots;
}

// The hour with the highest count for a histogram field, or null when there's
// no activity in that field (sentinel: absent signal ≠ midnight).
export function peakHour(histogram, field = 'total') {
  let best = null;
  let bestCount = 0;
  for (const slot of histogram || []) {
    const count = slot?.[field] || 0;
    if (count > bestCount) { bestCount = count; best = slot.hour; }
  }
  return best;
}

// Classify an observed chronotype from the histogram's activity center-of-mass.
// A circular mean over active hours handles the midnight wrap (a night owl
// active 22:00–02:00 shouldn't average to noon). Returns morning / intermediate
// / evening, or null when there isn't enough signal. Thresholds mirror the
// stated-chronotype classifier's spirit (early center = morning, late = evening).
export function classifyObservedChronotype(histogram) {
  let sumX = 0;
  let sumY = 0;
  let total = 0;
  for (const slot of histogram || []) {
    const count = slot?.total || 0;
    if (!count) continue;
    const angle = (slot.hour / 24) * 2 * Math.PI;
    sumX += Math.cos(angle) * count;
    sumY += Math.sin(angle) * count;
    total += count;
  }
  if (total < 5) return { type: null, centerHour: null, sampleSize: total };
  let meanAngle = Math.atan2(sumY, sumX);
  if (meanAngle < 0) meanAngle += 2 * Math.PI;
  const centerHour = Math.round((meanAngle / (2 * Math.PI)) * 24) % 24;
  // Center-of-mass hour → type. The circular mean wraps a late-night cluster to
  // a LOW hour (a night owl active 22:00–02:00 centers near 0), so the
  // small-hours band (<6) must classify as evening, NOT morning — otherwise the
  // wrap that the circular mean exists to handle is undone here. Bands: evening
  // = center ≥15:00 or in the small hours (<6:00); morning = 6:00–10:59;
  // intermediate = 11:00–14:59.
  let type;
  if (centerHour >= 15 || centerHour < 6) type = 'evening';
  else if (centerHour < 11) type = 'morning';
  else type = 'intermediate';
  return { type, centerHour, sampleSize: total };
}

const DIVERGENCE_RANK = { morning: 0, intermediate: 1, evening: 2 };

// Compare a stated chronotype type against the observed one. Distance of 0 =
// agree, 1 = mild (adjacent), 2 = strong (morning vs evening). Either side null
// → 'unknown' (not enough signal / no stated value yet), never a false divergence.
export function compareChronotype(statedType, observedType) {
  const s = DIVERGENCE_RANK[statedType];
  const o = DIVERGENCE_RANK[observedType];
  if (s === undefined || o === undefined) {
    return { statedType: statedType ?? null, observedType: observedType ?? null, agree: null, divergence: 'unknown' };
  }
  const dist = Math.abs(s - o);
  const divergence = dist === 0 ? 'none' : dist === 1 ? 'mild' : 'strong';
  return { statedType, observedType, agree: dist === 0, divergence, distance: dist };
}

// ---------------------------------------------------------------------------
// DB fetch (thin — the analysis lives in the pure helpers above).
// ---------------------------------------------------------------------------

function rowToLite(row) {
  return {
    kind: row.kind,
    source: row.source,
    happenedAt: row.happened_at instanceof Date ? row.happened_at.toISOString() : row.happened_at,
    title: row.title,
    summary: row.summary,
    dedupeKey: row.dedupe_key,
    metadata: row.metadata || {},
  };
}

// Fetch a window of events (happened_at >= sinceIso), optionally filtered to a
// set of kinds. Lightweight columns only — enrichment never needs participants.
async function fetchWindow(sinceIso, kinds = null) {
  await ensureSchema();
  const params = [sinceIso];
  let where = 'happened_at >= $1';
  if (Array.isArray(kinds) && kinds.length) {
    params.push(kinds);
    where += ` AND kind = ANY($${params.length})`;
  }
  params.push(FETCH_CAP);
  const result = await query(
    `SELECT kind, source, happened_at, title, summary, metadata, dedupe_key
       FROM human_activity_events
      WHERE ${where}
      ORDER BY happened_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToLite);
}

function daysAgoIso(days, now) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Evidence read (sentinel: null = never computed, not empty).
// ---------------------------------------------------------------------------

export async function getTasteEvidence() {
  return readJSONFile(TASTE_OBSERVED_FILE, null);
}

export async function getChronotypeEvidence() {
  return readJSONFile(CHRONOTYPE_OBSERVED_FILE, null);
}

// ---------------------------------------------------------------------------
// Aggregation (LLM-free — no provider calls, safe to run unattended).
// ---------------------------------------------------------------------------

/**
 * Recompute both observed-evidence records from the activity timeline and
 * persist them under `data/digital-twin/`. Deterministic and provider-free.
 * Returns a small summary for logging / the API response. The stored records
 * preserve any prior `interpretation` block (an LLM narrative is only added by
 * `interpretConsumption`, and a plain recompute must not wipe it — the evidence
 * numbers refreshed, but the last interpretation is still the user's).
 */
export async function aggregateTwinEvidence({ now = Date.now() } = {}) {
  const timezone = await getUserTimezone();
  const derivedAt = new Date(now).toISOString();

  // Media windows for taste (listen + watch only).
  const monthMedia = await fetchWindow(daysAgoIso(MONTH_DAYS, now), [MEDIA_LISTEN, MEDIA_WATCH]);
  const weekCutoff = daysAgoIso(WEEK_DAYS, now);
  const weekMedia = monthMedia.filter((e) => e.happenedAt >= weekCutoff);

  const priorTaste = await getTasteEvidence();
  const taste = {
    source: 'observed',
    derivedAt,
    timezone,
    windows: {
      week: { days: WEEK_DAYS, listen: rollupListen(weekMedia), watch: rollupWatch(weekMedia) },
      month: { days: MONTH_DAYS, listen: rollupListen(monthMedia), watch: rollupWatch(monthMedia) },
    },
    // Preserve a prior AI interpretation across LLM-free recomputes.
    ...(priorTaste?.interpretation ? { interpretation: priorTaste.interpretation } : {}),
  };
  await ensureDir(DIR);
  await atomicWrite(TASTE_OBSERVED_FILE, taste);

  // Chronotype window: outbound messages + meetings + media by local hour.
  const chronoEvents = await fetchWindow(
    daysAgoIso(CHRONOTYPE_WINDOW_DAYS, now),
    [MESSAGE_SENT, MEETING, MEDIA_LISTEN, MEDIA_WATCH],
  );
  const histogram = chronotypeHistogram(chronoEvents, timezone);
  const observed = classifyObservedChronotype(histogram);
  const chronotype = {
    source: 'observed',
    derivedAt,
    timezone,
    windowDays: CHRONOTYPE_WINDOW_DAYS,
    histogram,
    observedType: observed.type,
    centerHour: observed.centerHour,
    sampleSize: observed.sampleSize,
    peakHours: {
      messages: peakHour(histogram, 'messages'),
      meetings: peakHour(histogram, 'meetings'),
      media: peakHour(histogram, 'media'),
      overall: peakHour(histogram, 'total'),
    },
  };
  await atomicWrite(CHRONOTYPE_OBSERVED_FILE, chronotype);

  console.log(`🧭 Twin evidence aggregated: ${monthMedia.length} media / ${chronoEvents.length} activity event(s), observed chronotype ${observed.type || 'n/a'}`);
  return {
    taste: { week: weekMedia.length, month: monthMedia.length },
    chronotype: { events: chronoEvents.length, observedType: observed.type, sampleSize: observed.sampleSize },
    derivedAt,
  };
}

/**
 * Incremental refresh hook for source syncs (Spotify / YouTube). Fire-and-guard:
 * called after a media sync records new events so the observed evidence stays
 * fresh without waiting for the daily tick. LLM-free. Never throws — it runs
 * outside the request lifecycle (scheduler / sync path), so a failure is logged
 * and swallowed rather than crashing the caller.
 */
export async function refreshTwinEvidenceAfterSync() {
  return aggregateTwinEvidence().catch((err) => {
    console.error(`🧭 Twin evidence refresh after sync failed: ${err.message}`);
    return null;
  });
}

// ---------------------------------------------------------------------------
// Stated-vs-observed comparison (pure I/O composition — no provider calls).
// ---------------------------------------------------------------------------

/**
 * Assemble the Digital-Twin UI's "observed evidence" payload: the observed
 * taste + chronotype records, and a chronotype divergence flag against the
 * stated (genome/behavioral) chronotype. Stated taste lives in the existing
 * taste-profile endpoint, so the UI overlays that separately; here we only need
 * the chronotype divergence (a single classifiable dimension).
 */
export async function getObservedEvidence() {
  const [taste, chronotype, statedChronotype] = await Promise.all([
    getTasteEvidence(),
    getChronotypeEvidence(),
    readJSONFile(join(DIR, 'chronotype.json'), null),
  ]);
  // Only treat the stated chronotype as a real answer once it's been derived —
  // an underived record carries DEFAULT_CHRONOTYPE's 'intermediate', which would
  // otherwise fake a stated value and produce a spurious divergence flag.
  const stated = statedChronotype?.derivedAt ? statedChronotype : null;
  const statedType = stated?.type ?? null;
  const observedType = chronotype?.observedType ?? null;
  return {
    taste,
    chronotype,
    chronotypeComparison: compareChronotype(statedType, observedType),
    statedChronotype: stated
      ? { type: statedType, confidence: stated.confidence ?? null }
      : null,
  };
}

// ---------------------------------------------------------------------------
// LLM interpretation — EXPLICIT USER ACTION ONLY (per AI-provider policy).
// Never called from boot, a scheduler, or a sync hook.
// ---------------------------------------------------------------------------

// Render the observed evidence into a compact deterministic brief for the LLM —
// numbers only, no raw event bodies (privacy) and no invented interpretation.
export function buildConsumptionBrief(taste, chronotype) {
  const lines = [];
  const fmtTop = (list) => (Array.isArray(list) && list.length
    ? list.map((x) => `${x.name} (${x.count})`).join(', ')
    : 'none');
  const month = taste?.windows?.month;
  if (month) {
    const days = month.days || 30;
    lines.push(`Listening (last ${days}d): ${month.listen?.total || 0} plays.`);
    lines.push(`  Top artists: ${fmtTop(month.listen?.topArtists)}.`);
    if (month.listen?.topGenres?.length) lines.push(`  Top genres: ${fmtTop(month.listen.topGenres)}.`);
    const nv = month.listen?.novelty;
    if (nv?.noveltyRatio != null) lines.push(`  Novelty ratio: ${nv.noveltyRatio} (${nv.distinct} distinct of ${nv.total}).`);
    lines.push(`Watching (last ${days}d): ${month.watch?.total || 0} videos.`);
    lines.push(`  Top channels: ${fmtTop(month.watch?.topChannels)}.`);
    if (month.watch?.topTopics?.length) lines.push(`  Top topics: ${fmtTop(month.watch.topTopics)}.`);
  }
  if (chronotype) {
    lines.push(`Observed chronotype: ${chronotype.observedType || 'unknown'} (activity center-of-mass hour ${chronotype.centerHour ?? 'n/a'}, ${chronotype.sampleSize || 0} events).`);
    const pk = chronotype.peakHours || {};
    lines.push(`  Peak hours — messages: ${pk.messages ?? 'n/a'}, media: ${pk.media ?? 'n/a'}, overall: ${pk.overall ?? 'n/a'}.`);
  }
  return lines.join('\n');
}

function buildInterpretationPrompt(brief) {
  return [
    'Below is a factual, anonymized summary of my recent media consumption and daily-activity timing, derived from my own listening/watching history.',
    'Reflect back what this pattern suggests about my tastes, interests, and daily rhythm. Write 3–5 short first-person sentences ("My ...", "I tend to ..."). Ground every claim in the numbers below — do NOT invent artists, genres, or facts not present. No heading, no preamble, no disclaimers.',
    '',
    'Consumption summary:',
    brief,
  ].join('\n');
}

/**
 * Generate an AI interpretation of the observed evidence and persist it into
 * `taste-observed.json` under `interpretation`. EXPLICIT user action only — the
 * route handler is the sole caller, gated behind a UI button that names the
 * provider/model. Throws when no evidence exists yet or the provider is missing
 * (the route surfaces a clean error); the provider call itself never throws (it
 * runs a child process — failures return null and we raise a friendly error).
 */
export async function interpretConsumption({ providerId, model } = {}) {
  const taste = await getTasteEvidence();
  const chronotype = await getChronotypeEvidence();
  if (!taste && !chronotype) {
    throw new Error('No observed evidence yet — recompute the rollups first.');
  }
  const provider = await getProviderById(providerId).catch(() => null);
  if (!provider || !provider.enabled) {
    throw new Error('Selected AI provider is not available. Configure one in AI Providers.');
  }
  const brief = buildConsumptionBrief(taste, chronotype);
  const chosenModel = model || provider.defaultModel;
  // Headless run — a CLI provider shouldn't persist a session transcript.
  const providerForCall = provider.headlessArgs?.length
    ? { ...provider, args: [...(provider.args || []), ...provider.headlessArgs] }
    : provider;
  const result = await runPromptThroughProvider({
    provider: providerForCall,
    prompt: buildInterpretationPrompt(brief),
    source: 'twin-enrichment-interpret',
    model: chosenModel,
  }).catch((err) => {
    console.error(`🧭 Twin interpretation failed: ${err.message}`);
    return null;
  });
  const text = (result?.text || '').trim();
  if (!text) throw new Error('The AI provider returned no interpretation. Try again or pick another provider.');

  // Persist the EFFECTIVE provider/model that actually ran — createRun may
  // proactively swap to a fallback, so recording the requested provider would
  // show false provenance. Fall back to the requested values if the runner
  // didn't surface them.
  const ranProvider = result.provider || provider;
  const interpretation = {
    text,
    provider: ranProvider.id || provider.id,
    providerName: ranProvider.name || ranProvider.id || provider.name || provider.id,
    model: result.model ?? chosenModel ?? null,
    usedFallback: Boolean(result.usedFallback),
    generatedAt: new Date().toISOString(),
  };
  // Re-read immediately before the write: the provider call above can take many
  // seconds, during which a sync-hook or the daily scheduler may have rewritten
  // this file with fresh rollup numbers. Overlay the interpretation onto the
  // LATEST record, not the pre-call snapshot, so we don't roll the numbers back.
  const current = await getTasteEvidence();
  const merged = { ...(current || { source: 'observed', derivedAt: interpretation.generatedAt }), interpretation };
  await ensureDir(DIR);
  await atomicWrite(TASTE_OBSERVED_FILE, merged);
  console.log(`🧭 Twin interpretation generated via ${interpretation.providerName} (${text.length} chars)`);
  return interpretation;
}
