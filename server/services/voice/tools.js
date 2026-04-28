// Tool registry for the voice Chief-of-Staff. Each tool has an OpenAI-format
// function schema (fed to the LLM) plus an execute() that runs the action.
// Add a new tool by pushing another entry onto TOOLS.

import { captureThought, getInboxLog } from '../brain.js';
import { logDrink, getAlcoholSummary } from '../meatspaceAlcohol.js';
import { logNicotine, getNicotineSummary } from '../meatspaceNicotine.js';
import { addBodyEntry } from '../meatspaceHealth.js';
import { getGoals, updateGoalProgress, addProgressEntry } from '../identity.js';
import { listProcesses, restartApp } from '../pm2.js';
import { getItems, getFeeds, markItemRead, markAllRead } from '../feeds.js';
import { getUserTimezone, todayInTimezone, getLocalParts } from '../../lib/timezone.js';
import * as journal from '../brainJournal.js';
import { resolveNavCommand, normalizeLabel } from '../../lib/navManifest.js';
import { runAsk, VALID_MODES as ASK_VALID_MODES } from '../askService.js';

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

// Shared with pipeline.js (summarizeUi) and the client's domIndex.classify.
// Mirror of the client-side kinds; keep in sync.
export const UI_KINDS = ['tab', 'button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'];

// Per-turn tool filtering. Small models (qwen3-4b, granite, etc.) choke when
// given 25 tools — the schema alone is 10+ KB and routing accuracy tanks.
// Group each tool by domain; expose only the groups whose intent regex
// matches the user's utterance, plus the always-on set. "open the tasks
// page" sees ~8 tools instead of 25; "I had a beer" sees ~8 instead of 25.
const TOOL_GROUPS = {
  brain_capture: 'brain',
  brain_search: 'brain',
  brain_list_recent: 'brain',
  meatspace_log_drink: 'meatspace',
  meatspace_log_nicotine: 'meatspace',
  meatspace_summary_today: 'meatspace',
  meatspace_log_weight: 'meatspace',
  goal_list: 'goals',
  goal_update_progress: 'goals',
  goal_log_note: 'goals',
  pm2_status: 'system',
  pm2_restart: 'system',
  feeds_digest: 'feeds',
  feeds_mark_read: 'feeds',
  daily_log_open: 'dailylog',
  daily_log_start_dictation: 'dailylog',
  daily_log_stop_dictation: 'dailylog',
  daily_log_read: 'dailylog',
  ui_list_interactables: 'ui',
  ui_click: 'ui',
  ui_fill: 'ui',
  ui_select: 'ui',
  ui_check: 'ui',
  ui_ask: 'ask',
  // UNGROUPED = always-on: time_now, daily_log_append, ui_navigate.
  // brain_capture used to be always-on, but that caused form-fill turns
  // ("fill description with X") to be misrouted to brain_capture because
  // "note/save/remember" in the tool description overlaps with field
  // content. Gating on the brain regex keeps capture available for every
  // natural phrasing without tempting the LLM on UI-driving turns.
};

// Loose on purpose — false positives are cheap (one extra tool), false
// negatives are expensive (LLM guesses wrong or can't act).
export const UI_INTENT_RE = /\b(click|press|tap|hit|open|go to|take me|show me|navigate|select|pick|switch|choose|tab|button|dropdown|field|input|fill|enter|type|write|check|uncheck|toggle|link|option|on (?:this|the) page|what(?:'s)? (?:on|here))\b/i;
// Strong form-fill signal: when the user is clearly directing content INTO
// a specific field, brain_capture/daily_log_append must be suppressed even
// if capture verbs appear inside the value (e.g. "fill description with
// 'remember to buy milk'"). Matches a UI-fill verb within ~60 chars of a
// form-field word in either order — "fill the description with X", "type X
// in the body", "set the title to X", "put Y in description".
export const UI_FILL_INTENT_RE = /\b(?:fill|type|enter|put|write|set)\b[^.!?\n]{0,60}?\b(?:description|name|title|subject|body|content|field|input|textarea|form|label|placeholder|caption)\b/i;
const GROUP_INTENT = {
  // Expanded to cover natural capture verbs — "remember", "note", "save",
  // "jot", "file" — without which moving brain_capture out of the always-on
  // set would break "remember to buy milk" style turns.
  brain: /\b(search|find|look ?up|recall|what did I (?:say|write|note)|brain|inbox|capture|remember|remind me|jot|note (?:that|to|down)|save (?:this|that)|file (?:this|that|it)|add (?:this|that|it) to (?:my )?(?:brain|inbox|notes?))\b/i,
  meatspace: /\b(drink|drank|beer|wine|whiskey|shot|cocktail|cigarette|vape|pouch|nicotine|weigh|pound|kilo|kg|smoke|smoking|how am I|summary today|log (?:a|my) (?:drink|weight|nicotine))\b/i,
  goals: /\b(goals?|progress|objective)\b/i,
  system: /\b(restart|crash(?:ed)?|pm2|process|service|is.*(?:running|down|up)|status)\b/i,
  // "mark.*read" / "mark.*unread" pairs feeds_mark_read with feeds_digest:
  // after "what's in my feeds?" the user says "mark that one read" or "mark
  // them all as read" — the bare word "read" alone is too broad (collides
  // with "read my log"), so we require it follow "mark".
  feeds: /\b(feeds?|news|unread|articles?|rss|digest|headlines?|mark\b[^.!?\n]{0,40}\bread)\b/i,
  // `daily ?logi?n?s?` absorbs whisper/Web-Speech transcription drift on
  // "daily log": variants like "daily logs" (plural), "daily login" (heard as
  // a familiar word), "daily logins" all gate the daily-log toolset on. The
  // \b anchors keep it from matching inside unrelated words like "logging".
  dailylog: /\b(daily ?logi?n?s?|journal|dictat|log entry|log something|to my log|read (?:back )?my log)\b/i,
  // RAG questions answered by askService — phrasings that need cross-domain
  // recall (Brain + Memory + Goals + Calendar + Autobiography). Tight on
  // purpose: the tool is large (consumes a full LLM stream) and we don't
  // want it stealing turns the cheaper tools handle. Catches "advise me",
  // "draft a/an X", "what did I decide", "what's on my plate", "ask myself".
  ask: /\b(?:ask my ?self|advise me|coach me|draft (?:a|an|my|me|something)|what(?:'s| is) on my plate|what (?:did|do|should) i (?:decide|think|believe|say|want|do)|why did i|when did i|recall (?:my|that|when))\b/i,
  ui: UI_INTENT_RE,
};

// Fail-fast at import time: any group referenced in TOOL_GROUPS that has no
// matching GROUP_INTENT entry means a tool silently never reaches the LLM.
// A typo (`'daily_log'` vs `'dailylog'`) is otherwise invisible until the
// user tries that group and the LLM has no tool to call.
for (const [name, group] of Object.entries(TOOL_GROUPS)) {
  if (!(group in GROUP_INTENT)) {
    throw new Error(`voice tools: TOOL_GROUPS[${name}] = "${group}" but no GROUP_INTENT.${group} regex defined`);
  }
}


// Accepts one kind OR an array of kinds for multi-kind tools like ui_fill
// (input|textarea) and ui_check (checkbox|radio). The error pool and label
// come from the union so the LLM sees the correct "available" list.
const findUiElement = (ctx, label, kindHint) => {
  const ui = ctx?.state?.ui;
  if (!ui || !Array.isArray(ui.elements) || !ui.elements.length) {
    return {
      entry: null,
      err: {
        ok: false,
        error: 'No UI index available',
        summary: 'I don\'t see the page contents yet — reload the voice widget and try again.',
      },
    };
  }
  const kinds = Array.isArray(kindHint) ? kindHint : (kindHint ? [kindHint] : null);
  const target = normalizeLabel(label);
  const withKind = kinds ? ui.elements.filter((e) => kinds.includes(e.kind)) : ui.elements;
  const pools = kinds ? [withKind, ui.elements] : [ui.elements];
  const matchers = [
    (lab) => lab === target,
    (lab) => lab.startsWith(target),
    (lab) => lab.includes(target),
  ];
  for (const matcher of matchers) {
    for (const pool of pools) {
      const hit = pool.find((e) => matcher(normalizeLabel(e.label)));
      if (hit) return { entry: hit, err: null };
    }
  }
  const available = (kinds ? withKind : ui.elements).slice(0, 12).map((e) => e.label);
  const kindLabel = kinds ? kinds.join('/') : 'element';
  return {
    entry: null,
    err: {
      ok: false,
      error: `No ${kindLabel} matching "${label}" on this page`,
      available,
      summary: `I don't see "${label}" on this page. Available: ${available.join(', ') || 'none'}.`,
    },
  };
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
    name: 'feeds_mark_read',
    description:
      'Mark RSS feed items as read. Use when the user says "mark that one read", "mark this read", "I read the second one", or "mark them all read". ' +
      'Pass `query` with a distinctive phrase from the item\'s title (the LLM should reuse a title it just spoke from feeds_digest). ' +
      'Pass `all: true` to mark every unread item read; combine with `feedQuery` to scope to a single feed (e.g. "mark all of Hacker News as read").',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Distinctive phrase from the article title to fuzzy-match against currently unread items.',
        },
        all: {
          type: 'boolean',
          description: 'Mark every unread item as read. When true, `query` is ignored.',
        },
        feedQuery: {
          type: 'string',
          description: 'Optional: when `all` is true, restrict to a single feed by fuzzy-matching its title.',
        },
      },
    },
    execute: async ({ query, all = false, feedQuery } = {}) => {
      if (!all && (typeof query !== 'string' || !query.trim())) {
        return { ok: false, summary: 'Tell me which item — say "mark all read" or quote a phrase from the title.' };
      }

      if (all) {
        let feedId;
        let feedTitle;
        if (feedQuery && typeof feedQuery === 'string' && feedQuery.trim()) {
          const feeds = await getFeeds();
          const fq = feedQuery.trim().toLowerCase();
          const feed = feeds.find((f) => (f.title || '').toLowerCase() === fq)
            || feeds.find((f) => (f.title || '').toLowerCase().includes(fq));
          if (!feed) {
            return { ok: false, summary: `No feed matched "${feedQuery}".` };
          }
          feedId = feed.id;
          feedTitle = feed.title;
        }
        const result = await markAllRead(feedId);
        const scope = feedTitle ? ` from ${feedTitle}` : '';
        return {
          ok: true,
          marked: result.marked,
          summary: result.marked
            ? `Marked ${result.marked} item${result.marked === 1 ? '' : 's'}${scope} as read.`
            : `Nothing unread${scope}.`,
        };
      }

      // Fuzzy-match a single item by title against currently unread.
      const q = query.trim().toLowerCase();
      const unread = await getItems({ unreadOnly: true, limit: 200 });
      const exact = unread.find((i) => (i.title || '').toLowerCase() === q);
      const match = exact
        || unread.find((i) => (i.title || '').toLowerCase().includes(q))
        || unread.find((i) => {
          const tokens = q.split(/\s+/).filter((t) => t.length >= 3);
          return tokens.length && tokens.every((t) => (i.title || '').toLowerCase().includes(t));
        });
      if (!match) {
        return { ok: false, summary: `No unread item matched "${query}".` };
      }
      const result = await markItemRead(match.id);
      if (result?.error) {
        return { ok: false, summary: `Couldn't mark "${match.title}" — ${result.error}.` };
      }
      return {
        ok: true,
        title: match.title,
        summary: `Marked "${match.title}" as read.`,
      };
    },
  },

  {
    name: 'daily_log_open',
    description:
      'Open the Daily Log page AND (typically) start dictation. ONLY use when the user explicitly mentions "daily log", "log entry", "journal", or dictation — NEVER use this as a generic "take me to a page" tool; for any other destination call ui_navigate instead. ' +
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
    name: 'ui_navigate',
    description:
      'Navigate the UI to a page. Use for "take me to X" / "open X" / "go to X" — including the Daily Log when the user just wants to VIEW it without writing. ' +
      'Pass `page` as a short name the user would say: tasks, agents, gsd, briefing, calendar, goals, brain, meatspace, memory, messages, settings, shell, instances, wiki, character, health, body, alcohol, daily log, journal, etc. ' +
      'Server resolves fuzzy — "chief of staff tasks", "cos tasks", "task page" all map to tasks. If no match, the error lists valid names. ' +
      'Only prefer daily_log_open over this tool when the user clearly wants to write/dictate ("start", "new", "entry", "make", "dictate"); plain "open my daily log" or "go to the daily log" should use ui_navigate.',
    parameters: {
      type: 'object',
      properties: {
        page: {
          type: 'string',
          description: 'Short page name the user said (e.g. "tasks", "calendar"). Server fuzzy-matches.',
        },
        path: {
          type: 'string',
          description: 'Explicit route path starting with / (e.g. "/cos/tasks"). Only when page doesn\'t fit.',
        },
      },
    },
    execute: async ({ page, path } = {}, ctx = {}) => {
      let target = null;
      let resolvedKey = null;
      if (page && typeof page === 'string') {
        const hit = resolveNavCommand(page);
        if (hit) { target = hit.path; resolvedKey = hit.matched; }
      }
      if (!target && path && typeof path === 'string' && path.startsWith('/')) target = path;
      if (!target) {
        const suggestions = ['tasks', 'agents', 'gsd', 'briefing', 'calendar', 'goals', 'brain', 'meatspace', 'messages', 'settings', 'shell', 'instances'];
        return {
          ok: false,
          error: `Unknown page "${page || path || ''}"`,
          suggestions,
          summary: `I don't know that page. Try: ${suggestions.slice(0, 6).join(', ')}.`,
        };
      }
      ctx.sideEffects?.push({ type: 'navigate', path: target });
      return { ok: true, path: target, summary: `Opened ${resolvedKey || target}.` };
    },
  },

  {
    name: 'ui_list_interactables',
    description: 'List interactive elements on the current page. Fallback when the per-turn UI summary isn\'t enough.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: UI_KINDS, description: 'Optional kind filter.' },
      },
    },
    execute: async ({ kind } = {}, ctx = {}) => {
      const ui = ctx.state?.ui;
      if (!ui || !Array.isArray(ui.elements)) {
        return { ok: false, error: 'No UI index available. The user may not have the voice widget loaded.' };
      }
      const items = kind ? ui.elements.filter((e) => e.kind === kind) : ui.elements;
      return {
        ok: true,
        path: ui.path,
        title: ui.title,
        count: items.length,
        items: items.slice(0, 100),
        summary: `${items.length} interactive element${items.length === 1 ? '' : 's'} on ${ui.title || ui.path || 'this page'}.`,
      };
    },
  },

  {
    name: 'ui_click',
    description: 'Click a tab, button, or link on the current page by visible label. "Select Memory tab" → label="Memory", kind="tab".',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label.' },
        kind: { type: 'string', enum: ['tab', 'button', 'link'], description: 'Optional kind hint.' },
      },
      required: ['label'],
    },
    execute: async ({ label, kind } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, kind);
      if (!hit.entry) return hit.err;
      ctx.sideEffects?.push({ type: 'ui:click', target: { ref: hit.entry.ref, label: hit.entry.label } });
      return { ok: true, label: hit.entry.label, kind: hit.entry.kind, summary: `Clicked ${hit.entry.label}.` };
    },
  },

  {
    name: 'ui_fill',
    description: 'Type text into an input or textarea by its label. Use ui_select for dropdowns, ui_check for checkboxes.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label of the input.' },
        value: { type: 'string', description: 'Text to fill in.' },
      },
      required: ['label', 'value'],
    },
    execute: async ({ label, value } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, ['input', 'textarea']);
      if (!hit.entry) return hit.err;
      ctx.sideEffects?.push({ type: 'ui:fill', target: { ref: hit.entry.ref, label: hit.entry.label }, value: String(value ?? '') });
      return { ok: true, label: hit.entry.label, summary: `Filled ${hit.entry.label}.` };
    },
  },

  {
    name: 'ui_select',
    description: 'Pick an option from a <select> dropdown by label. "Set status to Active" → label="Status", option="Active".',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label of the select.' },
        option: { type: 'string', description: 'Option text or value.' },
      },
      required: ['label', 'option'],
    },
    execute: async ({ label, option } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, 'select');
      if (!hit.entry) return hit.err;
      ctx.sideEffects?.push({ type: 'ui:select', target: { ref: hit.entry.ref, label: hit.entry.label }, option: String(option) });
      return { ok: true, label: hit.entry.label, option, summary: `Selected ${option} on ${hit.entry.label}.` };
    },
  },

  {
    name: 'ui_check',
    description: 'Toggle a checkbox or radio by label. checked=true to check, false to uncheck.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Visible label.' },
        checked: { type: 'boolean', description: 'Desired state.' },
      },
      required: ['label', 'checked'],
    },
    execute: async ({ label, checked } = {}, ctx = {}) => {
      const hit = findUiElement(ctx, label, ['checkbox', 'radio']);
      if (!hit.entry) return hit.err;
      ctx.sideEffects?.push({ type: 'ui:check', target: { ref: hit.entry.ref, label: hit.entry.label }, checked: !!checked });
      return { ok: true, label: hit.entry.label, checked: !!checked, summary: `${checked ? 'Checked' : 'Unchecked'} ${hit.entry.label}.` };
    },
  },

  {
    name: 'ui_ask',
    description:
      'Ask the user\'s digital twin a question that needs retrieval-augmented recall across their Brain (notes, ideas, projects, inbox), Memory (semantic + BM25), Goals, Calendar, and Autobiography. Use for cross-domain questions the cheaper tools cannot answer: ' +
      '"what did I decide about X?", "advise me on Y given my goals", "draft a status update as me", "what\'s on my plate this afternoon?", "why did I prioritize Z?". ' +
      'NOT for one-shot lookups (use brain_search / goal_list / feeds_digest / time_now); NOT for capture verbs (use brain_capture / daily_log_append). ' +
      'The tool returns the answer in `content` — speak `content` directly without summarizing or rephrasing it. Skip citation markers like [1] [2] when reading aloud (they reference source chips on the Ask page).',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The user\'s question, in their own words. Pass through the substantive question — strip leading filler like "hey, can you" but keep the actual content.',
        },
        mode: {
          type: 'string',
          enum: ['ask', 'advise', 'draft'],
          description: '"ask" answers as the user (default). "advise" answers as a coach who knows the user. "draft" produces text in the user\'s voice for an external recipient (use for "draft a Slack message", "write an email as me").',
        },
      },
      required: ['question'],
    },
    execute: async ({ question, mode = 'ask' } = {}, ctx = {}) => {
      if (typeof question !== 'string' || !question.trim()) {
        throw new Error('question is required');
      }
      const trimmed = question.trim();
      const validMode = ASK_VALID_MODES.has(mode) ? mode : 'ask';
      const deltas = [];
      let doneAnswer = null;
      let sources = [];
      let providerId = null;
      let model = null;
      let errorMsg = null;
      // runAsk yields { sources, delta, done, error }. Collect deltas into an array
      // (avoids O(n²) string reallocation on long answers); the terminal `done` event
      // delivers the canonical full answer + reranked sources and supersedes deltas.
      for await (const evt of runAsk({ question: trimmed, mode: validMode, signal: ctx.signal })) {
        if (evt.type === 'sources') sources = evt.sources;
        else if (evt.type === 'delta') deltas.push(evt.text);
        else if (evt.type === 'error') { errorMsg = evt.error; break; }
        else if (evt.type === 'done') {
          doneAnswer = evt.answer;
          sources = evt.sources;
          providerId = evt.providerId;
          model = evt.model;
        }
      }
      if (errorMsg) {
        return { ok: false, error: errorMsg, summary: `I couldn't answer that — ${errorMsg}` };
      }
      // Barge-in: runAsk exits early on signal.aborted without emitting a `done`
      // event, so the loop ends with only partial deltas. Surface that as a
      // cancellation rather than a successful partial answer.
      if (ctx.signal?.aborted) {
        return { ok: false, error: 'aborted', summary: 'Cancelled before I could finish answering.' };
      }
      const finalAnswer = (doneAnswer ?? deltas.join('')).trim();
      if (!finalAnswer) {
        return { ok: false, summary: 'I came up empty on that question.' };
      }
      return {
        ok: true,
        content: finalAnswer,
        sourceCount: sources.length,
        sources: sources.map((s) => ({ kind: s.kind, title: s.title })),
        providerId,
        model,
        summary: `Answered "${trimmed.slice(0, 60)}${trimmed.length > 60 ? '…' : ''}" using ${sources.length} source${sources.length === 1 ? '' : 's'}.`,
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

const toSpec = (t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

export const getToolSpecs = () => TOOLS.map(toSpec);

// Canonical list of tool names, used by pipeline.js to detect the
// "narrate-instead-of-call" failure where the LLM emits a literal tool name
// in its prose. Exported so the regex can't drift when tools are added.
export const getAllToolNames = () => TOOLS.map((t) => t.name);

// Plain-format metadata for non-LLM consumers (the command palette) so routes
// don't need to reach through OpenAI-shaped function specs to get to the same
// fields. Shape-independent from getToolSpecs.
export const getToolMetadata = (id) => {
  const tool = TOOLS.find((t) => t.name === id);
  if (!tool) return null;
  return { id: tool.name, description: tool.description, parameters: tool.parameters };
};

// Intent-filtered spec list. Pass the user's current utterance; returns the
// filtered spec array PLUS the set of active groups so downstream consumers
// (pipeline.js → shouldIncludeUi) don't have to re-run the same regexes.
// Cuts ~25 tools to ~8–12 per turn so small tool-use models (qwen3-4b etc.)
// don't choke.
export const classifyIntent = (userText) => {
  const active = new Set();
  if (!userText) return active;
  for (const [group, re] of Object.entries(GROUP_INTENT)) {
    if (re.test(userText)) active.add(group);
  }
  return active;
};

export const getToolSpecsForIntent = (userText) => {
  if (!userText) return { specs: getToolSpecs(), activeGroups: new Set() };
  // Form-fill turns ("put Y in the body") may use verbs not in UI_INTENT_RE,
  // so compose a fresh group set: classifier result ∪ {ui, if form-fill}.
  // Mutating classifyIntent's returned set would conflate "classified" with
  // "overridden", which matters when the caller inspects activeGroups.
  const classified = classifyIntent(userText);
  const suppressCapture = UI_FILL_INTENT_RE.test(userText);
  const activeGroups = suppressCapture ? new Set([...classified, 'ui']) : classified;
  const specs = TOOLS
    .filter((t) => {
      if (suppressCapture && (t.name === 'brain_capture' || t.name === 'daily_log_append')) return false;
      const group = TOOL_GROUPS[t.name];
      return !group || activeGroups.has(group);
    })
    .map(toSpec);
  return { specs, activeGroups };
};

export const dispatchTool = async (name, args, ctx) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.execute(args || {}, ctx || { sideEffects: [] });
};
