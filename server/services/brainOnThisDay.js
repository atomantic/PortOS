/**
 * On This Day — resurface Brain journal entries, memories, and ideas written
 * on this calendar date in previous years. Machine-local read for the
 * dashboard widget; nothing here rides federation.
 *
 * The server owns the timezone-correct date key (same contract as
 * /api/calendar/agenda): journals are already keyed by local date, and
 * created-at timestamps are converted through the user's configured timezone
 * so a late-night capture lands on the day the user experienced.
 */

import * as brainStorage from './brainStorage.js';
import { getBrainProjections } from './brainSearchIndex.js';
import { getUserTimezone } from './userTimezone.js';
import { stripMarkdownEmphasis } from '../lib/markdownText.js';
import { todayInTimezone } from '../lib/timezone.js';

const SNIPPET_MAX = 160;

// Rows within the same year group in narrative order: the day's journal first,
// then captured memories, then ideas.
const TYPE_RANK = { journal: 0, memory: 1, idea: 2 };

/**
 * Collapse a markdown-ish body to one line of preview text.
 */
export function snippetOf(text, max = SNIPPET_MAX) {
  if (typeof text !== 'string') return '';
  const flat = stripMarkdownEmphasis(
    text.replace(/```[\s\S]*?```/g, ' ').replace(/!\[/g, '['),
  )
    .replace(/^[#>\-\s]+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

const yearOf = (isoDate) => Number(isoDate.slice(0, 4));

/**
 * Does this local YYYY-MM-DD share `today`'s month-day in a prior year?
 */
export const isPriorYearMonthDay = (isoDate, today) =>
  typeof isoDate === 'string'
  && isoDate.endsWith(today.slice(4))
  && Number.isInteger(yearOf(isoDate))
  && yearOf(isoDate) < yearOf(today);

/**
 * Pure collector: match records to today's month-day in prior years.
 * `today` is the local YYYY-MM-DD; `timezone` converts record timestamps to
 * local dates. Exported for tests.
 */
export function collectOnThisDay({ today, timezone, journals = [], ideas = [], memories = [] }) {
  const currentYear = yearOf(today);
  const items = [];

  // A record counts when its local date shares today's MM-DD in a PRIOR year.
  const priorYearLocalDate = (stamp) => {
    const at = Date.parse(stamp ?? '');
    if (!Number.isFinite(at)) return null;
    const localDate = todayInTimezone(timezone, new Date(at));
    return isPriorYearMonthDay(localDate, today) ? localDate : null;
  };

  for (const journal of journals) {
    if (!isPriorYearMonthDay(journal?.date, today)) continue;
    const snippet = snippetOf(journal.content);
    if (!snippet) continue;
    items.push({ type: 'journal', id: journal.date, date: journal.date, yearsAgo: currentYear - yearOf(journal.date), title: null, snippet });
  }

  for (const memory of memories) {
    // Imported memories carry the original capture time in sourceCreatedAt.
    const date = priorYearLocalDate(memory?.sourceCreatedAt || memory?.createdAt);
    if (!date || !memory.title) continue;
    items.push({ type: 'memory', id: memory.id, date, yearsAgo: currentYear - yearOf(date), title: memory.title, snippet: snippetOf(memory.content) });
  }

  for (const idea of ideas) {
    const date = priorYearLocalDate(idea?.createdAt);
    if (!date || !idea.title) continue;
    items.push({ type: 'idea', id: idea.id, date, yearsAgo: currentYear - yearOf(date), title: idea.title, snippet: snippetOf(idea.oneLiner) });
  }

  return items.sort((a, b) => a.yearsAgo - b.yearsAgo
    || TYPE_RANK[a.type] - TYPE_RANK[b.type]
    || (a.title || '').localeCompare(b.title || ''));
}

/**
 * The dashboard widget's read: today's lookbacks across journals, memories,
 * and ideas, capped at `limit` rows (total reports the uncapped match count).
 *
 * Reads the brainSearchIndex projections rather than `brainStorage.getAll` —
 * the projection cache is built once and kept fresh by brainEvents, so a
 * steady-state dashboard load costs zero disk I/O against stores that can
 * hold thousands of records. Journal projections deliberately carry no body,
 * so only the handful of matched days are loaded for their snippet.
 */
export async function getOnThisDay({ limit = 8 } = {}) {
  const timezone = await getUserTimezone();
  const today = todayInTimezone(timezone);
  const [journalIndex, ideas, memories] = await Promise.all([
    getBrainProjections('journals', { ranked: false }),
    getBrainProjections('ideas', { ranked: false }),
    getBrainProjections('memories', { ranked: false }),
  ]);
  const journals = (await Promise.all(journalIndex
    .filter((j) => j.hasBody && isPriorYearMonthDay(j.date, today))
    .map((j) => brainStorage.getById('journals', j.date))
  )).filter(Boolean);
  const items = collectOnThisDay({ today, timezone, journals, ideas, memories });
  return { date: today, timezone, total: items.length, items: items.slice(0, limit) };
}
