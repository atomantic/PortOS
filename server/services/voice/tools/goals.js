// Goals voice tools: list active goals, bump progress, attach a progress note.
// Goal matching is forgiving fuzzy-by-title so "my jacket goal" / "the estate
// property one" resolve from a distinctive word.

import { getGoals, updateGoalProgress, addProgressEntry } from '../../identity.js';
import { getUserTimezone, todayInTimezone } from '../../../lib/timezone.js';
import { clampLimit } from './shared.js';

export const GOALS_INTENT_RE = /\b(goals?|progress|objective)\b/i;

// Score goals against a voice query. Users say "my jacket goal", "the estate
// property one" — we need forgiving substring matching on title + any token.
const scoreGoalMatch = (goal, query) => {
  const title = (goal.title || '').toLowerCase();
  const q = query.toLowerCase().trim();
  if (!title || !q) return 0;
  if (title === q) return 100;
  if (title.includes(q)) return 80;
  const qTokens = q.split(/\s+/).filter((t) => t.length >= 3);
  if (!qTokens.length) return 0;
  const hits = qTokens.filter((t) => title.includes(t)).length;
  return hits ? (hits / qTokens.length) * 60 : 0;
};

const findGoalByQuery = (goals, query) => {
  const active = goals.filter((g) => g.status === 'active' || !g.status);
  const scored = active
    .map((g) => ({ goal: g, score: scoreGoalMatch(g, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return { match: null, candidates: [] };
  return { match: scored[0].goal, candidates: scored.slice(0, 4).map((s) => s.goal) };
};

export const GOALS_TOOLS = [
  {
    name: 'goal_list',
    description:
      'List the user\'s active goals with their current progress percent. Use when they ask "what are my goals?", "how am I doing on my goals?", "what am I working on?". Returns up to 10 goals ordered by urgency.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max goals to return (default 10).' },
      },
    },
    execute: async ({ limit = 10 } = {}) => {
      const max = clampLimit(limit, 10, 20);
      const data = await getGoals();
      const active = (data.goals || []).filter((g) => g.status === 'active' || !g.status);
      active.sort((a, b) => (b.urgency ?? 0) - (a.urgency ?? 0));
      const goals = active.slice(0, max).map((g) => ({
        title: g.title,
        horizon: g.horizon,
        category: g.category,
        progress: Math.round(g.progress ?? 0),
      }));
      return {
        ok: true,
        count: goals.length,
        goals,
        summary: goals.length
          ? `${goals.length} active goal${goals.length === 1 ? '' : 's'}.`
          : 'No active goals.',
      };
    },
  },

  {
    name: 'goal_update_progress',
    description:
      'Update the progress percent on an active goal. Use when the user says "bump my jacket goal to 40 percent", "set my estate goal to 25", "I\'m halfway done with X". Matches the goal by fuzzy title match — if multiple match, the most relevant wins but the alternatives are reported back.',
    parameters: {
      type: 'object',
      properties: {
        goalQuery: { type: 'string', description: 'A distinctive word or phrase from the goal title ("jacket", "estate property").' },
        progress: { type: 'number', description: 'New progress percentage, 0 to 100.' },
      },
      required: ['goalQuery', 'progress'],
    },
    execute: async ({ goalQuery, progress }) => {
      if (typeof goalQuery !== 'string' || !goalQuery.trim()) {
        throw new Error('goalQuery is required');
      }
      if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) {
        throw new Error('progress must be a number between 0 and 100');
      }
      const query = goalQuery.trim();
      const data = await getGoals();
      const { match, candidates } = findGoalByQuery(data.goals || [], query);
      if (!match) {
        return { ok: false, summary: `No active goal matched "${query}".` };
      }
      const prev = Math.round(match.progress ?? 0);
      const next = Math.round(progress);
      await updateGoalProgress(match.id, next);
      const alts = candidates.filter((g) => g.id !== match.id).map((g) => g.title);
      return {
        ok: true,
        title: match.title,
        previous: prev,
        current: next,
        alternatives: alts,
        summary: `"${match.title}" progress ${prev}% → ${next}%.`,
      };
    },
  },

  {
    name: 'goal_log_note',
    description:
      'Attach a free-form progress note to an EXISTING NAMED GOAL (without changing the percent). ' +
      'ONLY use when the user explicitly references a specific goal by its title or short name — phrasings like "log on my <goal> goal that I talked to Y", "add a note to my jacket goal — found the pattern", "update my estate goal: signed the papers". ' +
      'DO NOT use for generic life events like "set up the cat litter box", "I went for a walk", "the dishwasher broke" — those have no goal context and belong in daily_log_append. ' +
      'If the user did not say the word "goal" or name a specific known goal, this is the wrong tool. ' +
      'Matches the goal by fuzzy title match — but if the matched score is weak the call returns ok:false; do not invent a query that doesn\'t come from the user\'s words.',
    parameters: {
      type: 'object',
      properties: {
        goalQuery: { type: 'string', description: 'A distinctive word or phrase from the goal title.' },
        note: { type: 'string', description: 'The progress note in the user\'s words.' },
        durationMinutes: { type: 'number', description: 'Optional time spent on this activity (minutes).' },
      },
      required: ['goalQuery', 'note'],
    },
    execute: async ({ goalQuery, note, durationMinutes }) => {
      if (typeof goalQuery !== 'string' || !goalQuery.trim()) {
        throw new Error('goalQuery is required');
      }
      if (typeof note !== 'string' || !note.trim()) throw new Error('note is required');
      const query = goalQuery.trim();
      const data = await getGoals();
      const { match } = findGoalByQuery(data.goals || [], query);
      if (!match) {
        return { ok: false, summary: `No active goal matched "${query}".` };
      }
      // Server runs TZ=UTC; "today" must be the user's local date, not UTC.
      const today = todayInTimezone(await getUserTimezone());
      await addProgressEntry(match.id, { date: today, note: note.trim(), durationMinutes });
      return {
        ok: true,
        title: match.title,
        summary: `Logged a note on "${match.title}".`,
      };
    },
  },
];
