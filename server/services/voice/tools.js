// Tool registry for the voice Chief-of-Staff. Each tool has an OpenAI-format
// function schema (fed to the LLM) plus an execute() that runs the action.
// Add a new tool by pushing another entry onto TOOLS.

import { captureThought, getInboxLog } from '../brain.js';
import { logDrink, getAlcoholSummary } from '../meatspaceAlcohol.js';
import { logNicotine, getNicotineSummary } from '../meatspaceNicotine.js';
import { addBodyEntry } from '../meatspaceHealth.js';
import { getGoals, updateGoalProgress, addProgressEntry } from '../identity.js';
import { listProcesses, restartApp } from '../pm2.js';
import { getItems, getFeeds } from '../feeds.js';
import { getUserTimezone, todayInTimezone, getLocalParts } from '../../lib/timezone.js';
import * as journal from '../brainJournal.js';

const DAILY_LOG_PATH = '/brain/daily-log';

// Shorthand presets for voice logging. A user saying "I had a beer" should
// not need to recite oz + ABV — these defaults match typical US servings.
const DRINK_PRESETS = {
  beer:    { oz: 12,  abv: 5  },
  wine:    { oz: 5,   abv: 13 },
  whiskey: { oz: 1.5, abv: 40 },
  shot:    { oz: 1.5, abv: 40 },
  cocktail:{ oz: 3,   abv: 20 },
};

const NICOTINE_PRESETS = {
  cigarette: { mgPerUnit: 1 },
  vape:      { mgPerUnit: 1 },
  pouch:     { mgPerUnit: 6 },
};

const resolveDrinkPreset = (name) => {
  const key = Object.keys(DRINK_PRESETS).find((k) => name.toLowerCase().includes(k));
  return key ? DRINK_PRESETS[key] : DRINK_PRESETS.beer;
};

const resolveNicotinePreset = (product) => {
  const key = Object.keys(NICOTINE_PRESETS).find((k) => product.toLowerCase().includes(k));
  return key ? NICOTINE_PRESETS[key] : NICOTINE_PRESETS.cigarette;
};

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

const TOOLS = [
  {
    name: 'brain_capture',
    description:
      'Capture a thought, note, idea, todo, reminder, or any free-form information to the user\'s brain inbox for later classification. Use whenever the user asks you to remember, add, save, note, or jot something down. The text should be in the user\'s own words with enough detail that it\'s useful later.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The content to capture, phrased naturally. Include who/what/when/why details if the user mentioned them.',
        },
      },
      required: ['text'],
    },
    execute: async ({ text }) => {
      if (!text || typeof text !== 'string') throw new Error('text is required');
      const trimmed = text.trim();
      if (!trimmed) throw new Error('text must not be empty');
      // captureThought returns { inboxLog, message } — the inbox record id
      // lives inside inboxLog; returning `entry.id` was `undefined`.
      const { inboxLog } = await captureThought(trimmed);
      return {
        ok: true,
        id: inboxLog?.id,
        summary: `Captured "${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}"`,
      };
    },
  },

  {
    name: 'brain_search',
    description:
      'Search the user\'s brain inbox for previously captured thoughts, notes, or ideas. Use when the user asks "what did I say about X?", "do I have any notes on Y?", or wants to recall something they captured earlier. Returns up to 5 matching entries with their capture text and date.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Substring to search for in captured text (case-insensitive). Use the most distinctive keyword the user mentioned.',
        },
        limit: {
          type: 'integer',
          description: 'Max results to return (default 5, max 10).',
        },
      },
      required: ['query'],
    },
    execute: async ({ query, limit = 5 }) => {
      if (!query || typeof query !== 'string') throw new Error('query is required');
      const q = query.trim().toLowerCase();
      // `String.includes('')` matches everything, so an all-whitespace query
      // would return unrelated entries — reject instead of surprising the user.
      if (!q) throw new Error('query must not be empty');
      const max = Math.max(1, Math.min(10, limit || 5));
      // Load a reasonable window — the brain inbox is small enough that an
      // in-memory filter is fine and avoids a second storage pass for ranking.
      const records = await getInboxLog({ limit: 200 });
      const hits = records
        .filter((r) => (r.capturedText || '').toLowerCase().includes(q))
        .slice(0, max)
        .map((r) => ({
          id: r.id,
          date: (r.capturedAt || '').slice(0, 10),
          text: r.capturedText,
        }));
      return {
        ok: true,
        count: hits.length,
        hits,
        summary: hits.length
          ? `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for "${query}"`
          : `No captures matched "${query}"`,
      };
    },
  },

  {
    name: 'meatspace_log_drink',
    description:
      'Log an alcoholic drink to MortalLoom / Meatspace tracking. Use when the user says things like "I had a beer", "log a glass of wine", "I just had two whiskeys". The "name" field takes free-form ("IPA", "Cabernet", "Old Fashioned") — known categories (beer/wine/whiskey/shot/cocktail) get sensible oz+ABV defaults, otherwise the user should specify oz+abv explicitly.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Drink name or category (e.g. "beer", "IPA", "Cabernet", "whiskey").' },
        count: { type: 'number', description: 'How many (default 1).' },
        oz: { type: 'number', description: 'Serving size in ounces. Omit to use category default.' },
        abv: { type: 'number', description: 'Alcohol by volume percent (e.g. 5 for 5%). Omit to use category default.' },
      },
      required: ['name'],
    },
    execute: async ({ name, count = 1, oz, abv }) => {
      if (!name || typeof name !== 'string') throw new Error('name is required');
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('name must not be empty');
      // Tool args come from an LLM — guard against negative/NaN counts, absurd
      // serving sizes (gallons), and impossible ABV (>100%) before persistence.
      if (!Number.isFinite(count) || count <= 0 || count > 50) {
        throw new Error('count must be a positive number (≤50)');
      }
      const preset = resolveDrinkPreset(trimmedName);
      const resolvedOz = oz ?? preset.oz;
      const resolvedAbv = abv ?? preset.abv;
      if (!Number.isFinite(resolvedOz) || resolvedOz <= 0 || resolvedOz > 128) {
        throw new Error('oz must be a positive number (≤128)');
      }
      if (!Number.isFinite(resolvedAbv) || resolvedAbv < 0 || resolvedAbv > 100) {
        throw new Error('abv must be between 0 and 100');
      }
      const result = await logDrink({
        name: trimmedName,
        oz: resolvedOz,
        abv: resolvedAbv,
        count,
      });
      return {
        ok: true,
        summary: `Logged ${count} ${trimmedName} (${result.standardDrinks.toFixed(1)} std drinks). Day total: ${result.dayTotal.toFixed(1)} std drinks.`,
      };
    },
  },

  {
    name: 'meatspace_log_nicotine',
    description:
      'Log nicotine use (cigarette, vape puff, pouch) to MortalLoom / Meatspace tracking. Use when the user says "I had a cigarette", "two pouches", "just vaped". Known categories (cigarette/vape/pouch) get sensible mgPerUnit defaults; otherwise specify mgPerUnit explicitly.',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product type (e.g. "cigarette", "vape", "Zyn pouch", "cigar").' },
        count: { type: 'number', description: 'How many units (default 1).' },
        mgPerUnit: { type: 'number', description: 'Nicotine milligrams per unit. Omit to use category default.' },
      },
      required: ['product'],
    },
    execute: async ({ product, count = 1, mgPerUnit }) => {
      if (!product || typeof product !== 'string') throw new Error('product is required');
      const trimmedProduct = product.trim();
      if (!trimmedProduct) throw new Error('product must not be empty');
      if (!Number.isFinite(count) || count <= 0 || count > 100) {
        throw new Error('count must be a positive number (≤100)');
      }
      const preset = resolveNicotinePreset(trimmedProduct);
      const resolvedMg = mgPerUnit ?? preset.mgPerUnit;
      if (!Number.isFinite(resolvedMg) || resolvedMg < 0 || resolvedMg > 200) {
        throw new Error('mgPerUnit must be between 0 and 200');
      }
      const result = await logNicotine({
        product: trimmedProduct,
        mgPerUnit: resolvedMg,
        count,
      });
      return {
        ok: true,
        summary: `Logged ${count} ${trimmedProduct} (${result.totalMg}mg). Day total: ${result.dayTotal.toFixed(1)}mg nicotine.`,
      };
    },
  },

  {
    name: 'meatspace_summary_today',
    description:
      'Report today\'s alcohol and nicotine totals against rolling averages. Use when the user asks "how am I doing today?", "what\'s my drink count?", "have I had any cigarettes today?".',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const [alcohol, nicotine] = await Promise.all([getAlcoholSummary(), getNicotineSummary()]);
      const parts = [
        alcohol.today > 0
          ? `${alcohol.today.toFixed(1)} standard drinks today`
          : 'No drinks logged today',
        nicotine.today > 0
          ? `${nicotine.today.toFixed(1)}mg nicotine today`
          : 'No nicotine logged today',
      ];
      if (alcohol.avg7day) parts.push(`7-day avg ${alcohol.avg7day.toFixed(1)} drinks/day`);
      if (nicotine.avg7day) parts.push(`${nicotine.avg7day.toFixed(1)}mg/day nicotine avg`);
      return { ok: true, summary: parts.join('. ') + '.' };
    },
  },

  {
    name: 'brain_list_recent',
    description:
      'Read back the user\'s most recently captured brain-inbox entries. Use when they ask "what are my last notes?", "read me my recent captures", "what did I jot down today?".',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many entries to return (default 5, max 10).',
        },
      },
    },
    execute: async ({ limit = 5 } = {}) => {
      const max = Math.max(1, Math.min(10, limit || 5));
      const records = await getInboxLog({ limit: max });
      const items = records.map((r) => ({
        date: (r.capturedAt || '').slice(0, 10),
        text: r.capturedText,
      }));
      return {
        ok: true,
        count: items.length,
        items,
        summary: items.length
          ? `Last ${items.length} capture${items.length === 1 ? '' : 's'}.`
          : 'Brain inbox is empty.',
      };
    },
  },

  {
    name: 'meatspace_log_weight',
    description:
      'Log a body weight entry to MortalLoom / Meatspace tracking. Use when the user says "log my weight at 180", "I weigh 175 today", "weigh-in at eighty kilos". Defaults to today. Unit is lb unless the user explicitly mentions kg.',
    parameters: {
      type: 'object',
      properties: {
        weight: { type: 'number', description: 'Body weight value.' },
        unit: { type: 'string', enum: ['lb', 'kg'], description: 'Unit (lb or kg). Default lb.' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD). Omit for today.' },
      },
      required: ['weight'],
    },
    execute: async ({ weight, unit = 'lb', date }) => {
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
        throw new Error('weight must be a positive number');
      }
      // Validate unit explicitly — tool args come from an LLM, so "kgs"
      // or "pounds" would otherwise silently be treated as lb and corrupt
      // the body-weight log.
      if (unit !== 'lb' && unit !== 'kg') {
        throw new Error('unit must be either "lb" or "kg"');
      }
      const weightLb = unit === 'kg' ? weight * 2.2046226218 : weight;
      // Upper guard catches STT mis-transcriptions ("eighty" → "1800") before
      // they silently corrupt body-weight history.
      if (weightLb > 800) throw new Error(`weight ${weight}${unit} is out of realistic range`);
      const entry = await addBodyEntry({ date, weight: weightLb });
      return {
        ok: true,
        summary: `Logged ${weight}${unit} on ${entry.date}.`,
      };
    },
  },

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
      const max = Math.max(1, Math.min(20, limit || 10));
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
      'Attach a free-form progress note to an active goal (without changing the percent). Use when the user says "log on my X goal that I talked to Y", "add a note to my jacket goal — found the pattern". Matches the goal by fuzzy title match.',
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

  {
    name: 'pm2_status',
    description:
      'Report the status of PortOS PM2 processes. Use when the user asks "is anything crashed?", "is everything running?", "any errors?". Reports total, healthy, and any processes in errored/stopped states.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const procs = await listProcesses();
      const unhealthy = procs.filter((p) => p.status !== 'online');
      const online = procs.length - unhealthy.length;
      const parts = [`${online} of ${procs.length} processes online`];
      if (unhealthy.length) {
        parts.push(
          `issues: ${unhealthy.map((p) => `${p.name} (${p.status})`).join(', ')}`,
        );
      }
      return {
        ok: true,
        total: procs.length,
        online,
        unhealthy: unhealthy.map((p) => ({ name: p.name, status: p.status, restarts: p.restarts })),
        summary: parts.join('. ') + '.',
      };
    },
  },

  {
    name: 'pm2_restart',
    description:
      'Restart a PortOS PM2 process by name. Use when the user says "restart the whisper server", "restart portos-api", "bounce the cos runner". Only restart — never kill or delete.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'PM2 process name (or a distinctive substring).' },
      },
      required: ['name'],
    },
    execute: async ({ name }) => {
      if (typeof name !== 'string' || !name.trim()) throw new Error('name is required');
      const trimmed = name.trim();
      const lower = trimmed.toLowerCase();
      const procs = await listProcesses();
      const exact = procs.find((p) => p.name === trimmed);
      const match = exact
        || procs.find((p) => p.name?.toLowerCase() === lower)
        || procs.find((p) => p.name?.toLowerCase().includes(lower));
      if (!match) {
        return { ok: false, summary: `No PM2 process matched "${trimmed}".` };
      }
      await restartApp(match.name);
      return { ok: true, name: match.name, summary: `Restarted ${match.name}.` };
    },
  },

  {
    name: 'feeds_digest',
    description:
      'Summarize the user\'s unread RSS feed items. Use when the user asks "what\'s new in my feeds?", "any news?", "read me my headlines". Returns up to 5 of the newest unread items with title and feed name.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max items (default 5, max 10).' },
      },
    },
    execute: async ({ limit = 5 } = {}) => {
      const max = Math.max(1, Math.min(10, limit || 5));
      const [items, feeds] = await Promise.all([getItems({ unreadOnly: true }), getFeeds()]);
      const feedName = (id) => feeds.find((f) => f.id === id)?.title || 'feed';
      const picks = items.slice(0, max).map((i) => ({
        title: i.title,
        feed: feedName(i.feedId),
        date: (i.pubDate || i.fetchedAt || '').slice(0, 10),
      }));
      return {
        ok: true,
        totalUnread: items.length,
        count: picks.length,
        items: picks,
        summary: picks.length
          ? `${items.length} unread. Top ${picks.length}: ${picks.map((p) => `"${p.title}" (${p.feed})`).join('; ')}.`
          : 'No unread feed items.',
      };
    },
  },

  {
    name: 'daily_log_open',
    description:
      'Open the Daily Log page in the UI and optionally start voice dictation mode. ' +
      'Use when the user says "open my daily log", "take me to my daily log", "go to daily log", "let\'s make a daily log", "let\'s make a new daily log", "I want to make a log entry", "start my daily log", "new daily log", "let me add to my log". ' +
      'Set startDictation=true (DEFAULT for create-intent phrasings) when the user wants to write content right now — i.e., they said any of: "make"/"start"/"new"/"create"/"dictate"/"record"/"talk into"/"log something". ' +
      'Set startDictation=false ONLY when the user explicitly just wants to LOOK at the page without writing — i.e., they said "show me", "open"/"go to" without any create/write verb. ' +
      'When in doubt, prefer startDictation=true — voice users almost always want to write, and they can say "stop dictation" to exit. ' +
      'After calling, confirm briefly in one short sentence and stay quiet so the dictation system can capture freely.',
    parameters: {
      type: 'object',
      properties: {
        startDictation: {
          type: 'boolean',
          description: 'Immediately enter dictation mode — subsequent speech is appended to the log verbatim instead of sent to you as conversation. DEFAULT TRUE for create/write intent ("make"/"start"/"new"/"dictate"); only false when the user explicitly just wants to view the page.',
        },
      },
    },
    execute: async ({ startDictation = false } = {}, ctx = {}) => {
      const date = await journal.getToday();
      const entry = await journal.getJournal(date);
      ctx.sideEffects?.push({ type: 'navigate', path: DAILY_LOG_PATH });
      if (startDictation) {
        ctx.sideEffects?.push({ type: 'dictation', enabled: true, date });
      }
      const existingLen = entry?.content?.length || 0;
      const parts = [`Opened daily log for ${date}`];
      if (startDictation) parts.push('Dictation mode on — everything you say now will be added to today\'s log. Say "stop dictation" when done.');
      else if (existingLen) parts.push(`(${entry.segments?.length || 1} segment${entry.segments?.length === 1 ? '' : 's'} so far).`);
      else parts.push('(empty so far).');
      return { ok: true, date, dictation: !!startDictation, summary: parts.join(' ') };
    },
  },

  {
    name: 'daily_log_start_dictation',
    description:
      'Begin voice dictation into the Daily Log: subsequent user speech is transcribed and appended verbatim to today\'s log until they say stop. Use when the user says "start dictation", "record my log", "begin logging", "dictate this", "I want to start talking into my daily log". After calling, do not comment further — just confirm briefly.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Target date YYYY-MM-DD; defaults to today.' },
      },
    },
    execute: async ({ date } = {}, ctx = {}) => {
      const target = await journal.resolveDate(date);
      ctx.sideEffects?.push({ type: 'navigate', path: DAILY_LOG_PATH });
      ctx.sideEffects?.push({ type: 'dictation', enabled: true, date: target });
      return { ok: true, date: target, summary: `Dictation on for ${target}. Everything you say will be added to the log. Say "stop dictation" when finished.` };
    },
  },

  {
    name: 'daily_log_stop_dictation',
    description:
      'End voice dictation and return to normal conversation mode. Only useful if dictation is currently active. Use when the user says "stop dictation", "end dictation", "I\'m done", "exit dictation mode".',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      ctx.sideEffects?.push({ type: 'dictation', enabled: false });
      return { ok: true, summary: 'Dictation off.' };
    },
  },

  {
    name: 'daily_log_append',
    description:
      'Append a text segment to a Daily Log entry (does NOT enter dictation mode — one-shot). Use when the user says "add to my daily log: X", "write in my daily log that X", "note in today\'s log: X". Exact text goes in; do not summarize.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The exact text to append, in the user\'s words.' },
        date: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
      },
      required: ['text'],
    },
    execute: async ({ text, date }) => {
      if (!text || !text.trim()) throw new Error('text is required');
      const target = await journal.resolveDate(date);
      const entry = await journal.appendJournal(target, text.trim(), { source: 'voice' });
      return {
        ok: true,
        date: target,
        segments: entry.segments.length,
        summary: `Added to daily log for ${target}.`,
      };
    },
  },

  {
    name: 'daily_log_read',
    description:
      'Read back the full content of a Daily Log entry aloud. Use when the user says "read me my daily log", "what did I write today?", "play back yesterday\'s log". Defaults to today. Returns content so the LLM can read it verbatim — do NOT summarize, speak the content as-is.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD; defaults to today.' },
      },
    },
    execute: async ({ date } = {}, ctx = {}) => {
      const target = await journal.resolveDate(date);
      ctx.sideEffects?.push({ type: 'navigate', path: DAILY_LOG_PATH });
      const entry = await journal.getJournal(target);
      if (!entry || !entry.content?.trim()) {
        return { ok: true, date: target, empty: true, summary: `Daily log for ${target} is empty.` };
      }
      // Keep `summary` short — tool results are JSON-stringified into the
      // LLM message history, and duplicating the full content here would
      // double the token cost of every subsequent turn for no benefit.
      // Content is returned once in `content`.
      return {
        ok: true,
        date: target,
        content: entry.content,
        segments: entry.segments?.length || 0,
        summary: `Daily log for ${target} (${entry.segments?.length || 0} segments).`,
      };
    },
  },

  {
    name: 'time_now',
    description:
      'Report the current local date, time, and day of week. Use when the user asks "what time is it?", "what day is today?", "what\'s the date?". LLMs don\'t know the current time on their own — always call this tool rather than guessing.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      // Server runs TZ=UTC, so formatting must be scoped to the user's TZ.
      const tz = await getUserTimezone();
      const now = new Date();
      const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(now);
      const parts = getLocalParts(now, tz);
      return {
        ok: true,
        iso: now.toISOString(),
        timezone: tz,
        date: `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
        dayOfWeek: fmt({ weekday: 'long' }),
        time: fmt({ hour: 'numeric', minute: '2-digit' }),
        summary: `${fmt({ weekday: 'long' })}, ${fmt({ month: 'long', day: 'numeric', year: 'numeric' })} at ${fmt({ hour: 'numeric', minute: '2-digit' })}.`,
      };
    },
  },
];

export const getToolSpecs = () => TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export const dispatchTool = async (name, args, ctx) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(args || {}, ctx || { sideEffects: [] });
};
