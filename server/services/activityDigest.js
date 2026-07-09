/**
 * Activity Digest — daily-log auto-drafts (Human Activity Tracking Phase 6, #2155).
 *
 * Summarizes a day's Human Activity timeline (conversations, meetings, media
 * consumed — with tribe-person names resolved) into a compact draft, then
 * splices it as a clearly-marked auto-generated section into that day's Brain
 * daily-log entry (via brainJournal.upsertAutoSection → federates + re-embeds).
 *
 * Two modes:
 *   1. Non-LLM (always available, zero provider calls). `formatActivityDigest`
 *      renders a deterministic structured bullet list — useful on its own AND
 *      the template fed to the LLM.
 *   2. LLM narrative (opt-in). Only when a provider is configured in settings —
 *      the config UI names the provider/model. See "AI Provider Usage Policy" in
 *      CLAUDE.md: the feature is silent until the user enables it, and the
 *      scheduled run is a sanctioned automation the user set up.
 *
 * The scheduler lives in activityDigestScheduler.js; the manual "draft today
 * now" button hits POST /brain/daily-log/:date/draft (a direct user action).
 */

import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { buildMarkers } from '../lib/markedSection.js';
import { getUserTimezone } from '../lib/timezone.js';
import { getDaySummary } from './humanActivity.js';
import * as journal from './brainJournal.js';
import { getPerson } from './tribe.js';
import { getProviderById } from './providers.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';

const SETTINGS_FILE = join(PATHS.brain, 'activity-digest-settings.json');

// Stable marker pair — a re-run replaces ONLY this region in the journal entry.
export const DIGEST_MARKERS = buildMarkers('activity-digest');

const DEFAULT_SETTINGS = {
  // Scheduler opt-in. When false the feature is entirely silent — no scheduled
  // runs, no provider calls (the manual "draft now" button still works).
  enabled: false,
  // LLM provider/model for the narrative. null → non-LLM bullets only (zero
  // provider calls). The config UI names whichever provider/model is set here.
  provider: null,
  model: null,
  // Evening local time (HH:MM, user's timezone) the scheduled draft runs.
  runTime: '21:00',
  // How many prior days a missed-run catch-up will backfill (0 = today only).
  catchUpDays: 3,
  // Managed server-side — the last day successfully drafted + when.
  lastRunDate: null,
  lastRunAt: null,
};

// Keys the client may write via PUT — managed fields (lastRun*) are stripped.
const CLIENT_SETTABLE = ['enabled', 'provider', 'model', 'runTime', 'catchUpDays'];

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getSettings() {
  await ensureDir(PATHS.brain);
  const loaded = await readJSONFile(SETTINGS_FILE, null);
  return loaded ? { ...DEFAULT_SETTINGS, ...loaded } : { ...DEFAULT_SETTINGS };
}

// Persist a partial update. Only client-settable keys are honored from
// `partial`; `internal` carries server-managed fields (lastRunDate/lastRunAt).
export async function updateSettings(partial = {}, internal = {}) {
  const current = await getSettings();
  const next = { ...current };
  for (const key of CLIENT_SETTABLE) {
    if (partial[key] !== undefined) next[key] = partial[key];
  }
  if (internal.lastRunDate !== undefined) next.lastRunDate = internal.lastRunDate;
  if (internal.lastRunAt !== undefined) next.lastRunAt = internal.lastRunAt;
  await atomicWrite(SETTINGS_FILE, next);
  return next;
}

// ─── Pure helpers (exported for unit tests — no I/O) ─────────────────────────

const CONVERSATION_KINDS = new Set(['message.sent', 'message.received']);
const MEETING_KINDS = new Set(['calendar.event']);
const MEDIA_KINDS = new Set(['media.listen', 'media.watch']);

const isoRe = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (d) => typeof d === 'string' && isoRe.test(d);

// Shift a YYYY-MM-DD string by N days (UTC math — the string is a calendar day,
// not an instant, so DST doesn't apply). Returns YYYY-MM-DD.
export function shiftIso(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Which calendar days are due for a draft, given the last-drafted day and the
 * catch-up window. Returns an ascending list of YYYY-MM-DD (always includes
 * `today` when it hasn't been drafted yet — the scheduler decides today's
 * time-of-day gate separately). Pure + timezone-agnostic (operates on the
 * already-resolved local `today`).
 *
 *   - never run           → [today - catchUpDays … today]
 *   - last run == today   → []            (nothing due; re-draft is idempotent)
 *   - last run == earlier → [max(lastRun+1, today-catchUpDays) … today]
 */
export function computeCatchUpDates(settings, today) {
  if (!isIso(today)) return [];
  const catchUpDays = Number.isFinite(settings?.catchUpDays)
    ? Math.max(0, Math.floor(settings.catchUpDays))
    : 0;
  const earliest = shiftIso(today, -catchUpDays);
  let cursor;
  if (isIso(settings?.lastRunDate)) {
    const dayAfterLast = shiftIso(settings.lastRunDate, 1);
    cursor = dayAfterLast > earliest ? dayAfterLast : earliest;
  } else {
    cursor = earliest;
  }
  const dates = [];
  // `cursor > today` guards against a lastRunDate in the future (clock skew).
  while (cursor <= today && dates.length <= catchUpDays + 1) {
    dates.push(cursor);
    cursor = shiftIso(cursor, 1);
  }
  return dates;
}

// Resolve a participant to a display name, preferring an explicit name, then a
// tribe-resolved name (nameByPersonId), then email/phone. Returns null when the
// participant has nothing usable.
function resolveParticipantName(p, nameByPersonId) {
  if (!p) return null;
  if (p.name) return p.name;
  if (p.personId && nameByPersonId[p.personId]) return nameByPersonId[p.personId];
  return p.email || p.phone || null;
}

// Unique, order-preserving list of participant display names across events.
function collectNames(events, nameByPersonId) {
  const seen = new Set();
  const names = [];
  for (const ev of events) {
    for (const p of ev.participants || []) {
      const name = resolveParticipantName(p, nameByPersonId);
      if (name && !seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

const joinNames = (names, max = 8) => (
  names.length <= max
    ? names.join(', ')
    : `${names.slice(0, max).join(', ')} +${names.length - max} more`
);

/**
 * Render a day's activity into a deterministic Markdown bullet summary — the
 * non-LLM fallback mode AND the template fed to the LLM. Returns null when the
 * day has no tracked events (so callers skip writing an empty section).
 *
 * @param {object} daySummary — shape from humanActivity.getDaySummary()
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.nameByPersonId] — personId → tribe name
 */
export function formatActivityDigest(daySummary, { nameByPersonId = {} } = {}) {
  const events = Array.isArray(daySummary?.events) ? daySummary.events : [];
  if (events.length === 0) return null;

  const conversations = events.filter((e) => CONVERSATION_KINDS.has(e.kind));
  const meetings = events.filter((e) => MEETING_KINDS.has(e.kind));
  const media = events.filter((e) => MEDIA_KINDS.has(e.kind));

  const lines = [];

  if (conversations.length) {
    const sent = conversations.filter((e) => e.kind === 'message.sent').length;
    const received = conversations.length - sent;
    const names = collectNames(conversations, nameByPersonId);
    const withWhom = names.length ? ` with ${joinNames(names)}` : '';
    lines.push(`**Conversations** — ${conversations.length} message${conversations.length === 1 ? '' : 's'} (${sent} sent, ${received} received)${withWhom}`);
  }

  if (meetings.length) {
    lines.push(`**Meetings** — ${meetings.length}`);
    for (const ev of meetings) {
      const names = collectNames([ev], nameByPersonId);
      const withWhom = names.length ? ` (with ${joinNames(names, 5)})` : '';
      lines.push(`- ${ev.title || '(untitled event)'}${withWhom}`);
    }
  }

  if (media.length) {
    lines.push(`**Media** — ${media.length}`);
    for (const ev of media) {
      const verb = ev.kind === 'media.watch' ? 'Watched' : 'Listened';
      const detail = ev.summary ? ` — ${ev.summary}` : '';
      lines.push(`- ${verb}: ${ev.title || '(untitled)'}${detail}`);
    }
  }

  // Anything that isn't a known category still counts as activity — summarize a
  // tail count so the draft never silently drops events.
  const known = conversations.length + meetings.length + media.length;
  const other = events.length - known;
  if (other > 0) {
    lines.push(`**Other activity** — ${other} event${other === 1 ? '' : 's'}`);
  }

  return lines.join('\n');
}

// Wrap the section body with a visible header (rendered inside the markers). The
// header names the mode so the user can tell an LLM draft from raw bullets.
function buildSectionBody(date, body, { usedLlm }) {
  const badge = usedLlm ? 'AI-drafted' : 'auto-summary';
  return `### 🗓️ Activity Digest — ${date}\n_${badge} from your activity timeline. Edits above this line are preserved; this section is regenerated on each draft._\n\n${body}`;
}

// Build the LLM prompt from the non-LLM bullet template.
function buildNarrativePrompt(template, date) {
  return [
    'You are writing a brief first-person journal entry summarizing my day, based ONLY on the structured activity summary below.',
    'Write 2–4 short sentences in past tense, first person ("I ..."). Be factual — do not invent people, events, or details not present in the summary. Do not add a heading or a preamble.',
    '',
    `Date: ${date}`,
    '',
    'Structured activity summary:',
    template,
  ].join('\n');
}

// ─── Orchestration ───────────────────────────────────────────────────────────

// Build a personId → display-name map by resolving tribe people for the
// personIds present in the day's events. Best-effort: a lookup failure just
// leaves that id unresolved (formatter falls back to name/email/phone).
async function buildNameMap(events) {
  const ids = new Set();
  for (const ev of events) {
    for (const p of ev.participants || []) {
      // Only resolve ids we actually need — a participant that already carries a
      // name doesn't need a tribe round-trip.
      if (p?.personId && !p?.name) ids.add(p.personId);
    }
  }
  const map = {};
  for (const id of ids) {
    const person = await getPerson(id).catch(() => null);
    if (person?.name) map[id] = person.name;
  }
  return map;
}

// Generate the LLM narrative from the bullet template. Returns null on any
// failure (caller falls back to the non-LLM bullets). Never throws — runs on
// the scheduler path too.
async function generateNarrative(template, date, settings) {
  const provider = await getProviderById(settings.provider).catch(() => null);
  if (!provider || !provider.enabled) return null;
  const model = settings.model || provider.defaultModel;
  // Headless classification-style run — append headlessArgs so a CLI provider
  // doesn't persist a session transcript for the draft.
  const providerForCall = provider.headlessArgs?.length
    ? { ...provider, args: [...(provider.args || []), ...provider.headlessArgs] }
    : provider;
  const result = await runPromptThroughProvider({
    provider: providerForCall,
    prompt: buildNarrativePrompt(template, date),
    source: 'activity-digest',
    model,
  }).catch((err) => {
    console.error(`🗓️  Activity digest LLM narrative failed for ${date}: ${err.message}`);
    return null;
  });
  const text = (result?.text || '').trim();
  return text || null;
}

/**
 * Draft (or re-draft) the activity digest for one calendar day and splice it
 * into that day's Brain daily-log entry. Idempotent — re-runs replace only the
 * marked auto section, never user content.
 *
 * @param {string} date — YYYY-MM-DD
 * @param {object} [opts]
 * @param {boolean} [opts.recordRun=false] — stamp settings.lastRun* on success
 *   (the scheduler sets this; manual drafts don't move the scheduler cursor).
 * @returns {Promise<{ date, drafted: boolean, usedLlm: boolean, reason?: string }>}
 */
export async function runDigestForDate(date, { recordRun = false } = {}) {
  if (!journal.isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  const started = Date.now();
  const settings = await getSettings();
  const daySummary = await getDaySummary({ date });
  const events = daySummary?.events || [];

  const template = formatActivityDigest(daySummary, {
    nameByPersonId: await buildNameMap(events),
  });

  if (!template) {
    console.log(`🗓️  Activity digest ${date}: no tracked activity — nothing to draft`);
    // Clear a stale auto section from a previous draft if the day is now empty.
    await journal.upsertAutoSection(date, '', DIGEST_MARKERS);
    if (recordRun) await stampRun(date);
    return { date, drafted: false, usedLlm: false, reason: 'no-activity' };
  }

  let sectionBody = template;
  let usedLlm = false;
  if (settings.provider) {
    const narrative = await generateNarrative(template, date, settings);
    if (narrative) {
      // Prose narrative on top; keep the structured bullets beneath it for
      // provenance / at-a-glance scanning.
      sectionBody = `${narrative}\n\n${template}`;
      usedLlm = true;
    }
  }

  await journal.upsertAutoSection(date, buildSectionBody(date, sectionBody, { usedLlm }), DIGEST_MARKERS);
  if (recordRun) await stampRun(date);
  console.log(`🗓️  Activity digest drafted ${date} (${events.length} event(s), ${usedLlm ? 'LLM' : 'non-LLM'}) in ${Date.now() - started}ms`);
  return { date, drafted: true, usedLlm };
}

// Advance the scheduler cursor to the drafted day.
async function stampRun(date) {
  await updateSettings({}, { lastRunDate: date, lastRunAt: new Date().toISOString() });
}
