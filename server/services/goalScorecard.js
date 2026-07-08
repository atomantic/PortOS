/**
 * Goal Effectiveness Scorecard — weekly time-allocation vs stated goals
 * (Human Activity Tracking Phase 8, #2157).
 *
 * Correlates where a week's tracked time/attention actually went (the Human
 * Activity timeline — conversations, meetings, media) against the user's stated
 * goals (`data/digital-twin/goals.json`) and produces a weekly scorecard:
 *
 *   - Hours aligned to each goal vs unaligned time.
 *   - Trend vs prior weeks (aligned share over the last N weeks).
 *   - Contact-vs-goal alignment (distinct people touched per goal — e.g. tribe
 *     touch cadence against relationship goals).
 *
 * Two layers, matching the Phase 6 activity-digest split:
 *   1. **Numeric scorecard — always LLM-free, deterministic.** Events map to
 *      goals via keyword / participant / calendar rules (user-editable, stored
 *      locally). The rollup is pure arithmetic. This is the artifact rendered on
 *      the Insights page.
 *   2. **Optional LLM narrative (opt-in).** "This week you said X mattered but
 *      spent 6× more time on Y." Behind the same provider config as the activity
 *      digest (#2155) — silent until the user configures a provider AND clicks
 *      Refresh. See CLAUDE.md "AI Provider Usage Policy".
 *
 * The scorecard artifact lives under `data/insights/` alongside the cross-domain
 * insights caches. All reads are disk-only; compute is an explicit user action.
 */

import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { getUserTimezone, todayInTimezone } from '../lib/timezone.js';
import { localDayRangeUtc, localDayKey, listEvents } from './humanActivity.js';
import * as journal from './brainJournal.js';
import { buildMarkers } from '../lib/markedSection.js';
import { getProviderById, getActiveProvider } from './providers.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';

const GOALS_FILE = join(PATHS.digitalTwin, 'goals.json');
const INSIGHTS_DIR = join(PATHS.data, 'insights');
const SCORECARD_FILE = join(INSIGHTS_DIR, 'goal-scorecard.json');
const RULES_FILE = join(INSIGHTS_DIR, 'goal-scorecard-rules.json');
const SETTINGS_FILE = join(INSIGHTS_DIR, 'goal-scorecard-settings.json');

// Marker pair for the one-line slice spliced into the week-anchor day's Brain
// daily-log entry (checkbox 4 — feed a slice into the digest).
export const SCORECARD_DIGEST_MARKERS = buildMarkers('goal-scorecard');

// How many weeks (including the current one) the trend series spans.
export const TREND_WEEKS = 4;

// Deterministic time-allocation proxy per event kind. The timeline stores real
// durations for calendar/media events; conversations are point-in-time, so a
// small nominal cost keeps them from vanishing from a time-allocation view
// without letting a chatty day dwarf an all-day meeting.
export const NOMINAL_SECONDS = {
  'message.sent': 120,
  'message.received': 60,
  'calendar.event': 1800,
  'media.listen': 180,
  'media.watch': 600,
  default: 300,
};

const DEFAULT_SETTINGS = {
  // Opt-in for the LLM narrative + scheduled/digest side effects. When false the
  // numeric scorecard still computes on demand (it is LLM-free); only the
  // narrative and the Brain digest slice stay silent.
  enabled: false,
  // Provider/model for the optional narrative. null → numeric scorecard only.
  provider: null,
  model: null,
  // When true (and enabled), computing a scorecard also splices a one-line slice
  // into the week-anchor day's Brain daily-log entry.
  feedBrainDigest: false,
  // ISO day the week starts on (1 = Monday, per ISO-8601).
  weekStartsOn: 1,
};

const CLIENT_SETTABLE = ['enabled', 'provider', 'model', 'feedBrainDigest', 'weekStartsOn'];

// Tokens too generic to be useful goal keywords.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'make', 'made',
  'your', 'you', 'get', 'got', 'more', 'less', 'into', 'onto', 'over', 'been',
  'about', 'goal', 'goals', 'real', 'another', 'again', 'keep', 'stay', 'remain',
  'long', 'possible', 'first', 'finish', 'create', 'creating', 'build', 'buy',
]);

// ─── Pure helpers (exported for unit tests — no I/O) ─────────────────────────

const isoRe = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (d) => typeof d === 'string' && isoRe.test(d);

// Shift a YYYY-MM-DD calendar date by N days (UTC math — a calendar day is not
// an instant, so DST doesn't apply). Returns YYYY-MM-DD.
export function shiftIsoDate(date, days) {
  const [y, m, d] = String(date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The calendar date (YYYY-MM-DD) of the start of the week containing `dateStr`.
// `weekStartsOn` uses ISO day numbers (1 = Monday … 7 = Sunday); default Monday.
// Operates on the calendar date only, so it is timezone-agnostic.
export function isoWeekStart(dateStr, weekStartsOn = 1) {
  if (!isIso(dateStr)) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
  const isoDow = dow === 0 ? 7 : dow; // 1=Mon … 7=Sun
  const start = ((weekStartsOn - 1 + 7) % 7);
  const offset = (isoDow - 1 - start + 7) % 7;
  return shiftIsoDate(dateStr, -offset);
}

// UTC [start, end) instants bounding a local week that begins on `weekStartIso`.
// Anchors on the source-of-truth local-day range so DST transitions inside the
// week keep their true length (end is the NEXT week's local midnight, not +7×24h).
export function weekRangeUtc(weekStartIso, timezone) {
  const startRange = localDayRangeUtc(weekStartIso, timezone);
  if (!startRange) return null;
  const endRange = localDayRangeUtc(shiftIsoDate(weekStartIso, 7), timezone);
  return { start: startRange.start, end: endRange.start };
}

// Extract lowercase keyword tokens from a goal's title/tags/category. Tags and
// category pass through verbatim (already meaningful); title words are split,
// length-filtered, and stopword-filtered so a title like "Buy Estate Property"
// yields ["estate", "property"], not ["buy"].
export function goalKeywords(goal) {
  const words = String(goal?.title || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const tags = Array.isArray(goal?.tags)
    ? goal.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
    : [];
  const category = goal?.category ? [String(goal.category).toLowerCase()] : [];
  return Array.from(new Set([...words, ...tags, ...category]));
}

// Build the deterministic goal→match ruleset. Each active goal gets a rule with
// derived keywords plus its linked calendars. A per-goal override (keyed by goal
// id) can add keywords, add participant personIds, replace the linked calendars,
// or disable the goal from the scorecard entirely.
//
// Note the real goal shapes (see server/services/identity/goals.js): a goal's
// `linkedActivities` are named tracked activities (`{ activityName, … }`), NOT
// tribe person ids — so their names fold into keywords. `linkedCalendars` are
// `{ subcalendarId, matchPattern }` objects (same shape dailyReview.js reads).
export function buildMappingRules(goals = [], overrides = {}) {
  const rules = [];
  for (const goal of goals || []) {
    if (!goal?.id) continue;
    if (goal.status && goal.status !== 'active') continue;
    const override = overrides[goal.id] || {};
    if (override.enabled === false) continue;

    const activityNames = Array.isArray(goal.linkedActivities)
      ? goal.linkedActivities.map((a) => String(a?.activityName || '').toLowerCase().trim()).filter(Boolean)
      : [];
    const keywords = Array.from(new Set([
      ...goalKeywords(goal),
      ...activityNames,
      ...((Array.isArray(override.keywords) ? override.keywords : []).map((k) => String(k).toLowerCase().trim()).filter(Boolean)),
    ]));

    // Linked calendars → { subcalendarId, matchPattern } (matchPattern, when
    // present, further requires the event title to contain it — like dailyReview).
    let subcalendars = Array.isArray(goal.linkedCalendars)
      ? goal.linkedCalendars
        .filter((lc) => lc?.subcalendarId != null)
        .map((lc) => ({ subcalendarId: String(lc.subcalendarId), matchPattern: lc.matchPattern ? String(lc.matchPattern).toLowerCase() : null }))
      : [];
    if (Array.isArray(override.subcalendarIds)) {
      // Override supplies plain ids (no per-calendar pattern).
      subcalendars = override.subcalendarIds.map((id) => ({ subcalendarId: String(id), matchPattern: null }));
    }

    rules.push({
      id: goal.id,
      title: goal.title || '(untitled goal)',
      category: goal.category || null,
      keywords,
      personIds: Array.isArray(override.personIds) ? override.personIds.map(String) : [],
      subcalendars,
    });
  }
  return rules;
}

// The searchable text of an event (title + summary + participant names), lowercased.
function eventText(event) {
  const parts = [event?.title, event?.summary];
  for (const p of event?.participants || []) {
    if (p?.name) parts.push(p.name);
  }
  return parts.filter(Boolean).join(' ').toLowerCase();
}

// The goal ids a single event maps to. An event aligns to a goal when ANY of:
//   - a goal keyword appears in the event's text (title/summary/participant name)
//   - an event participant's personId is in the goal's linked personIds
//   - the event's calendar subcalendarId is in the goal's linked calendars
// Returns a de-duplicated array of goal ids (possibly empty = unaligned).
export function eventGoalMatches(event, rules = []) {
  if (!event) return [];
  const text = eventText(event);
  // Whole-word set for single-token keywords so a short tag/category can't
  // substring-match unrelated text ("go" in "going", "art" in "start"). Phrase
  // keywords (containing a space) still substring-match against the full text.
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const personIds = new Set((event.participants || []).map((p) => p?.personId).filter(Boolean).map(String));
  const subcal = event?.metadata?.subcalendarId != null ? String(event.metadata.subcalendarId) : null;
  const matched = [];
  for (const rule of rules) {
    const byKeyword = rule.keywords.some((k) => k && (k.includes(' ') ? text.includes(k) : words.has(k)));
    const byPerson = rule.personIds.some((id) => personIds.has(String(id)));
    const byCalendar = subcal != null && rule.subcalendars.some((sc) => (
      sc.subcalendarId === subcal && (!sc.matchPattern || text.includes(sc.matchPattern))
    ));
    if (byKeyword || byPerson || byCalendar) matched.push(rule.id);
  }
  return Array.from(new Set(matched));
}

// Deterministic time-allocation weight (seconds) for an event: its real duration
// when present, otherwise the per-kind nominal proxy.
export function eventSeconds(event, nominal = NOMINAL_SECONDS) {
  const d = Number(event?.durationS);
  if (Number.isFinite(d) && d > 0) return Math.round(d);
  return nominal[event?.kind] ?? nominal.default;
}

// Bucket events into local weeks. Returns a Map of weekStartIso → events[].
// Events with an unparseable timestamp are dropped.
export function bucketEventsByWeek(events = [], timezone, weekStartsOn = 1) {
  const buckets = new Map();
  for (const ev of events || []) {
    const day = localDayKey(ev.happenedAt ?? ev.happened_at, timezone);
    if (!day) continue;
    const wk = isoWeekStart(day, weekStartsOn);
    if (!wk) continue;
    if (!buckets.has(wk)) buckets.set(wk, []);
    buckets.get(wk).push(ev);
  }
  return buckets;
}

// Lightweight aligned/unaligned/total seconds for a set of events — the unit the
// trend series is built from (no per-goal breakdown).
export function weekTotals(events = [], rules = [], nominal = NOMINAL_SECONDS) {
  let aligned = 0;
  let unaligned = 0;
  for (const ev of events || []) {
    const seconds = eventSeconds(ev, nominal);
    if (eventGoalMatches(ev, rules).length > 0) aligned += seconds;
    else unaligned += seconds;
  }
  return { alignedSeconds: aligned, unalignedSeconds: unaligned, totalSeconds: aligned + unaligned, eventCount: (events || []).length };
}

const secondsToHours = (s) => Math.round((s / 3600) * 100) / 100;

// A distinct-person key for contact-cadence counting: prefer personId, then
// email, then phone, then name. Returns null when the participant is anonymous.
function contactKey(p) {
  if (!p) return null;
  return p.personId ? `id:${p.personId}` : p.email ? `email:${p.email}` : p.phone ? `phone:${p.phone}` : p.name ? `name:${p.name}` : null;
}

/**
 * Compute the detailed single-week scorecard. Pure — the caller supplies just
 * that week's events plus the prior-week totals for the trend series.
 *
 * @param {object} args
 * @param {string} args.weekStart — YYYY-MM-DD (the local week's first day)
 * @param {object[]} args.events — timeline events for that week only
 * @param {object[]} args.rules — output of buildMappingRules()
 * @param {string} [args.timezone]
 * @param {Array<{weekStart,alignedSeconds,unalignedSeconds,totalSeconds}>} [args.trend]
 *   — ascending prior→current weekly totals (current week last).
 * @param {object} [args.nominal]
 */
export function computeScorecard({ weekStart, events = [], rules = [], timezone = null, trend = [], nominal = NOMINAL_SECONDS }) {
  const perGoal = new Map(rules.map((r) => [r.id, {
    id: r.id, title: r.title, category: r.category,
    alignedSeconds: 0, eventCount: 0, contacts: new Set(),
  }]));

  let alignedSeconds = 0;
  let unalignedSeconds = 0;
  for (const ev of events || []) {
    const seconds = eventSeconds(ev, nominal);
    const matches = eventGoalMatches(ev, rules);
    if (matches.length === 0) {
      unalignedSeconds += seconds;
      continue;
    }
    alignedSeconds += seconds;
    for (const goalId of matches) {
      const g = perGoal.get(goalId);
      if (!g) continue;
      g.alignedSeconds += seconds;
      g.eventCount += 1;
      for (const p of ev.participants || []) {
        const key = contactKey(p);
        if (key) g.contacts.add(key);
      }
    }
  }

  const totalSeconds = alignedSeconds + unalignedSeconds;
  const goals = Array.from(perGoal.values())
    .map((g) => ({
      id: g.id,
      title: g.title,
      category: g.category,
      alignedSeconds: g.alignedSeconds,
      alignedHours: secondsToHours(g.alignedSeconds),
      eventCount: g.eventCount,
      contactCount: g.contacts.size,
      // Share of ALIGNED time this goal claims (goals can overlap on one event,
      // so goal shares need not sum to 1 — this ranks focus, not a partition).
      share: alignedSeconds > 0 ? Math.round((g.alignedSeconds / alignedSeconds) * 1000) / 1000 : 0,
    }))
    .sort((a, b) => b.alignedSeconds - a.alignedSeconds);

  // Trend direction: this week's aligned SHARE of total vs the mean aligned
  // share of the prior weeks in the series.
  const priorWeeks = trend.slice(0, -1);
  const priorShares = priorWeeks
    .filter((w) => w.totalSeconds > 0)
    .map((w) => w.alignedSeconds / w.totalSeconds);
  const currentShare = totalSeconds > 0 ? alignedSeconds / totalSeconds : 0;
  const priorMean = priorShares.length ? priorShares.reduce((a, b) => a + b, 0) / priorShares.length : null;
  let direction = 'flat';
  // A zero-activity week has no aligned share to compare — a blank week isn't a
  // "decline" in goal alignment, so leave it neutral rather than reporting 'down'.
  if (priorMean != null && totalSeconds > 0) {
    if (currentShare > priorMean + 0.05) direction = 'up';
    else if (currentShare < priorMean - 0.05) direction = 'down';
  }

  return {
    weekStart,
    timezone,
    generatedAt: new Date().toISOString(),
    totals: {
      alignedSeconds,
      unalignedSeconds,
      totalSeconds,
      alignedHours: secondsToHours(alignedSeconds),
      unalignedHours: secondsToHours(unalignedSeconds),
      alignedShare: totalSeconds > 0 ? Math.round(currentShare * 1000) / 1000 : 0,
      eventCount: (events || []).length,
    },
    goals,
    trend: trend.map((w) => ({
      weekStart: w.weekStart,
      alignedSeconds: w.alignedSeconds,
      unalignedSeconds: w.unalignedSeconds,
      alignedShare: w.totalSeconds > 0 ? Math.round((w.alignedSeconds / w.totalSeconds) * 1000) / 1000 : 0,
    })),
    trendDirection: direction,
    narrative: null,
    narrativeGeneratedAt: null,
  };
}

// One-line digest slice for the Brain daily/weekly log. Pure — LLM-free.
export function formatScorecardDigestLine(scorecard) {
  if (!scorecard?.totals || scorecard.totals.totalSeconds === 0) return null;
  const { alignedHours, unalignedHours, alignedShare } = scorecard.totals;
  const top = scorecard.goals?.find((g) => g.alignedSeconds > 0);
  const topPart = top ? ` Most-aligned: ${top.title} (${top.alignedHours}h).` : '';
  const pct = Math.round((alignedShare || 0) * 100);
  return `**Goal scorecard (week of ${scorecard.weekStart})** — ${alignedHours}h aligned to goals vs ${unalignedHours}h unaligned (${pct}% goal-aligned).${topPart}`;
}

// ─── Settings / rules I/O ────────────────────────────────────────────────────

export async function getSettings() {
  await ensureDir(INSIGHTS_DIR);
  const loaded = await readJSONFile(SETTINGS_FILE, null);
  return loaded ? { ...DEFAULT_SETTINGS, ...loaded } : { ...DEFAULT_SETTINGS };
}

export async function updateSettings(partial = {}) {
  const current = await getSettings();
  const next = { ...current };
  for (const key of CLIENT_SETTABLE) {
    if (partial[key] !== undefined) next[key] = partial[key];
  }
  await ensureDir(INSIGHTS_DIR);
  await atomicWrite(SETTINGS_FILE, next);
  return next;
}

// User-editable per-goal mapping overrides. Shape: { [goalId]: { keywords?,
// personIds?, subcalendarIds?, enabled? } }. Stored locally, never federated.
export async function getRuleOverrides() {
  const loaded = await readJSONFile(RULES_FILE, null);
  return loaded && typeof loaded === 'object' ? loaded : {};
}

export async function saveRuleOverrides(overrides = {}) {
  const clean = overrides && typeof overrides === 'object' ? overrides : {};
  await ensureDir(INSIGHTS_DIR);
  await atomicWrite(RULES_FILE, clean);
  return clean;
}

// Load active goals from digital-twin. Returns [] when the file is missing.
async function loadGoals() {
  const data = await readJSONFile(GOALS_FILE, null);
  return Array.isArray(data?.goals) ? data.goals : [];
}

// The current effective ruleset (goals × user overrides) — powers the rules
// editor UI so the user sees the derived keywords they can extend.
export async function getEffectiveRules() {
  const [goals, overrides] = await Promise.all([loadGoals(), getRuleOverrides()]);
  return { rules: buildMappingRules(goals, overrides), overrides };
}

// ─── Read path (disk-only) ───────────────────────────────────────────────────

export async function getScorecard() {
  const cached = await readJSONFile(SCORECARD_FILE, null);
  if (!cached) return { available: false, reason: 'not_computed' };
  return { ...cached, available: true };
}

// ─── Compute (LLM-free) ──────────────────────────────────────────────────────

/**
 * Compute (and persist) the weekly goal-effectiveness scorecard. Deterministic
 * and LLM-free — safe to call on any user action. Queries the last TREND_WEEKS
 * of timeline events once, buckets them, computes the detailed target week plus
 * the trend series, persists the artifact, and (opt-in) splices a one-line slice
 * into the week-anchor day's Brain daily-log.
 *
 * @param {object} [opts]
 * @param {string} [opts.weekStart] — YYYY-MM-DD; defaults to the current week.
 * @returns {Promise<object>} the scorecard artifact (with available: true).
 */
export async function computeWeeklyScorecard({ weekStart } = {}) {
  const started = Date.now();
  const timezone = await getUserTimezone();
  const settings = await getSettings();
  const weekStartsOn = Number.isFinite(settings.weekStartsOn) ? settings.weekStartsOn : 1;

  const today = todayInTimezone(timezone);
  const targetWeek = isIso(weekStart) ? isoWeekStart(weekStart, weekStartsOn) : isoWeekStart(today, weekStartsOn);

  const [goals, overrides] = await Promise.all([loadGoals(), getRuleOverrides()]);
  const rules = buildMappingRules(goals, overrides);

  // Query the whole trend span in one pass: [oldest week start, target week end).
  const oldestWeek = shiftIsoDate(targetWeek, -(TREND_WEEKS - 1) * 7);
  const span = {
    start: weekRangeUtc(oldestWeek, timezone)?.start,
    end: weekRangeUtc(targetWeek, timezone)?.end,
  };
  const EVENT_CAP = 2000;
  const events = span.start && span.end
    ? await listEvents({ from: span.start.toISOString(), to: span.end.toISOString(), limit: EVENT_CAP })
    : [];
  // listEvents returns newest-first capped at EVENT_CAP — the target (current)
  // week is always fully covered, but a very active user could truncate the
  // OLDEST trend weeks. Surface it rather than silently under-counting a trend bar.
  if (events.length >= EVENT_CAP) {
    console.warn(`🎯 Goal scorecard hit the ${EVENT_CAP}-event query cap for ${targetWeek}; oldest trend weeks may under-count`);
  }

  const buckets = bucketEventsByWeek(events, timezone, weekStartsOn);
  const trend = [];
  for (let i = TREND_WEEKS - 1; i >= 0; i -= 1) {
    const wk = shiftIsoDate(targetWeek, -i * 7);
    trend.push({ weekStart: wk, ...weekTotals(buckets.get(wk) || [], rules) });
  }

  const scorecard = computeScorecard({
    weekStart: targetWeek,
    events: buckets.get(targetWeek) || [],
    rules,
    timezone,
    trend,
  });

  await ensureDir(INSIGHTS_DIR);
  await atomicWrite(SCORECARD_FILE, scorecard);

  if (settings.enabled && settings.feedBrainDigest) {
    const line = formatScorecardDigestLine(scorecard);
    // Splice into the week-anchor day's daily-log entry. Best-effort — a journal
    // failure must not fail the scorecard compute.
    await journal.upsertAutoSection(targetWeek, line || '', SCORECARD_DIGEST_MARKERS)
      .catch((err) => console.error(`🎯 Goal scorecard digest slice failed for ${targetWeek}: ${err.message}`));
  }

  console.log(`🎯 Goal scorecard computed for week ${targetWeek}: ${scorecard.totals.alignedHours}h aligned / ${scorecard.totals.unalignedHours}h unaligned (${goals.length} goals, ${events.length} events) in ${Date.now() - started}ms`);
  return { ...scorecard, available: true };
}

// ─── Optional LLM narrative (opt-in, user-triggered) ─────────────────────────

// Build the narrative prompt from the numeric scorecard. LLM-free callers never
// reach this.
function buildNarrativePrompt(scorecard) {
  const goalLines = (scorecard.goals || [])
    .filter((g) => g.alignedSeconds > 0)
    .slice(0, 8)
    .map((g) => `- ${g.title}${g.category ? ` (${g.category})` : ''}: ${g.alignedHours}h, ${g.eventCount} events, ${g.contactCount} distinct contacts`)
    .join('\n');
  const trendLine = (scorecard.trend || [])
    .map((w) => `${w.weekStart}: ${Math.round((w.alignedShare || 0) * 100)}% aligned`)
    .join(' → ');
  return [
    'You are an accountability coach reviewing how someone spent their week against their stated goals.',
    'Below is a deterministic scorecard of tracked time. Write 2–4 sentences, second person ("You spent…"), factual — do not invent activities or goals not listed. Call out the biggest mismatch between stated priority and time spent, if any.',
    'Do not add a heading or preamble. Do not use markdown.',
    '',
    `Week of ${scorecard.weekStart}.`,
    `Aligned to goals: ${scorecard.totals.alignedHours}h. Unaligned: ${scorecard.totals.unalignedHours}h (${Math.round((scorecard.totals.alignedShare || 0) * 100)}% aligned).`,
    '',
    'Time by goal:',
    goalLines || '(no time mapped to any goal this week)',
    '',
    `Aligned-share trend: ${trendLine}`,
  ].join('\n');
}

/**
 * Generate the optional LLM narrative for the current scorecard and persist it
 * onto the artifact. User-triggered only (a "Generate narrative" click). The
 * numeric scorecard itself is never regenerated here — the narrative is an
 * annotation on top of the deterministic artifact.
 *
 * @param {string} [providerId] — override the configured provider.
 * @param {string} [model]
 */
export async function refreshScorecardNarrative(providerId, model) {
  const scorecard = await readJSONFile(SCORECARD_FILE, null);
  if (!scorecard) return { available: false, reason: 'not_computed' };
  if (!scorecard.totals || scorecard.totals.totalSeconds === 0) {
    return { available: false, reason: 'no_activity' };
  }

  const settings = await getSettings();
  const resolvedProviderId = providerId || settings.provider;
  // Prefer an explicit/configured provider; fall back to the active provider
  // (mirrors the cross-domain narrative) so "enabled" alone is enough to run.
  const provider = resolvedProviderId
    ? await getProviderById(resolvedProviderId).catch(() => null)
    : await getActiveProvider().catch(() => null);
  if (!provider || provider.enabled === false) return { available: false, reason: 'no_provider' };

  const selectedModel = model || settings.model || provider.defaultModel;
  const providerForCall = provider.headlessArgs?.length
    ? { ...provider, args: [...(provider.args || []), ...provider.headlessArgs] }
    : provider;

  const result = await runPromptThroughProvider({
    provider: providerForCall,
    prompt: buildNarrativePrompt(scorecard),
    source: 'goal-scorecard',
    model: selectedModel,
  }).catch((err) => {
    console.error(`🎯 Goal scorecard narrative failed: ${err.message}`);
    return null;
  });

  const text = (result?.text || '').trim();
  if (!text) return { available: false, reason: 'generation_failed' };

  const updated = { ...scorecard, narrative: text, narrativeGeneratedAt: new Date().toISOString(), narrativeModel: selectedModel };
  await ensureDir(INSIGHTS_DIR);
  await atomicWrite(SCORECARD_FILE, updated);
  console.log(`🎯 Goal scorecard narrative generated (${text.length} chars, model ${selectedModel})`);
  return { ...updated, available: true };
}
