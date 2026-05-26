// Tool registry for the voice Chief-of-Staff. Each tool has an OpenAI-format
// function schema (fed to the LLM) plus an execute() that runs the action.
// Add a new tool by pushing another entry onto TOOLS.

import { captureThought, getInboxLog } from '../brain.js';
import { NAVIGABLE_STAGE_IDS as PIPELINE_STAGE_IDS } from '../pipeline/issues.js';
import { logDrink, getAlcoholSummary } from '../meatspaceAlcohol.js';
import { logNicotine, getNicotineSummary } from '../meatspaceNicotine.js';
import { addBodyEntry, addWorkout } from '../meatspaceHealth.js';
import { getGoals, updateGoalProgress, addProgressEntry } from '../identity.js';
import { listProcesses, restartApp } from '../pm2.js';
import { getItems, getFeeds, markItemRead, markAllRead } from '../feeds.js';
import { getEvents as getCalendarEvents } from '../calendarSync.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { scheduleTimer } from './timers.js';
import { getUserTimezone, todayInTimezone, getLocalParts, getUtcOffsetMs } from '../../lib/timezone.js';
import * as journal from '../brainJournal.js';
import { resolveNavCommand, normalizeLabel } from '../../lib/navManifest.js';
import { runAsk, VALID_MODES as ASK_VALID_MODES } from '../askService.js';
import * as imageGen from '../imageGen/index.js';
import { createImageGenWaiter } from '../imageGenWaiter.js';
import { getSettings } from '../settings.js';
import { isDestructiveLabel, buildPending } from './confirmGate.js';

const DAILY_LOG_PATH = '/brain/daily-log';

// Clamp an LLM-supplied `limit` to [1, hi]. Tool-call args can arrive as
// strings ("10") or non-numeric junk; `Math.min(hi, "abc")` is NaN, which would
// silently slice an empty result. Coerce with Number() and fall back to
// `fallback` when the value isn't a finite positive number (preserving the old
// `limit || fallback` behavior for 0 / blank).
const clampLimit = (raw, fallback, hi) => {
  const n = Number(raw);
  return Math.max(1, Math.min(hi, Number.isFinite(n) && n > 0 ? n : fallback));
};

// ----- Pipeline stage navigation helpers (used by pipeline_next_stage etc) -----
const PIPELINE_STAGE_LABELS = {
  idea: 'Idea',
  prose: 'Prose',
  comicScript: 'Comic Script',
  teleplay: 'Teleplay',
  comicPages: 'Comic Pages',
  storyboards: 'Storyboards',
  episodeVideo: 'Episode Video',
};
// Spoken aliases → canonical stage ids. `resolveNavCommand` covers top-level
// pages but not in-route stage names, so this is a dedicated table.
const PIPELINE_STAGE_ALIASES = {
  idea: 'idea',
  prose: 'prose', story: 'prose',
  'comic script': 'comicScript', comicscript: 'comicScript', comics: 'comicScript',
  'tv script': 'teleplay', tvscript: 'teleplay', teleplay: 'teleplay',
  'comic pages': 'comicPages', 'comic page': 'comicPages', comicpages: 'comicPages', pages: 'comicPages', page: 'comicPages',
  storyboards: 'storyboards', storyboard: 'storyboards', scenes: 'storyboards',
  'episode video': 'episodeVideo', episodevideo: 'episodeVideo', episode: 'episodeVideo', video: 'episodeVideo',
};
const parsePipelineIssuePath = (path) => {
  if (typeof path !== 'string') return null;
  // Strip query/hash before matching — `[^/]+` would otherwise greedily
  // absorb `?foo=bar` or `#anchor` into the captured id/stage segments
  // (the path "/pipeline/issues/abc?x" would parse as id="abc?x").
  const clean = path.split(/[?#]/)[0];
  const m = clean.match(/^\/pipeline\/issues\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  const stage = PIPELINE_STAGE_IDS.includes(m[2]) ? m[2] : 'idea';
  return { issueId: m[1], stage };
};
const NOT_ON_PIPELINE_ISSUE_PAGE = {
  ok: false,
  error: 'Not on a pipeline issue page',
  summary: 'I can only switch stages from a /pipeline/issues/... page. Open an issue first.',
};
const navigateToPipelineStage = (issueId, stage, ctx) => {
  const path = `/pipeline/issues/${issueId}/${stage}`;
  ctx.sideEffects?.push({ type: 'navigate', path });
  return { ok: true, path, stage, label: PIPELINE_STAGE_LABELS[stage], summary: `Opened ${PIPELINE_STAGE_LABELS[stage]}.` };
};
const PIPELINE_STAGE_TOOLS = [
  {
    name: 'pipeline_next_stage',
    description: 'Advance to the next stage of the current pipeline issue (Idea → Prose → Comic Script → Teleplay → Comic Pages → Storyboards → Episode Video). Only works on a /pipeline/issues/... page.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const idx = PIPELINE_STAGE_IDS.indexOf(cur.stage);
      if (idx === PIPELINE_STAGE_IDS.length - 1) {
        return { ok: false, error: 'Already on last stage', summary: `Already on ${PIPELINE_STAGE_LABELS[cur.stage]} — that's the last stage.` };
      }
      return navigateToPipelineStage(cur.issueId, PIPELINE_STAGE_IDS[idx + 1], ctx);
    },
  },
  {
    name: 'pipeline_prev_stage',
    description: 'Go back to the previous stage of the current pipeline issue. Only works on a /pipeline/issues/... page.',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const idx = PIPELINE_STAGE_IDS.indexOf(cur.stage);
      if (idx === 0) {
        return { ok: false, error: 'Already on first stage', summary: `Already on ${PIPELINE_STAGE_LABELS[cur.stage]} — that's the first stage.` };
      }
      return navigateToPipelineStage(cur.issueId, PIPELINE_STAGE_IDS[idx - 1], ctx);
    },
  },
  {
    name: 'pipeline_open_stage',
    description: 'Open a specific stage of the current pipeline issue by name. Pass `stage` as the user spoke it: "prose", "comic script", "storyboards", "episode video", etc. Only works on a /pipeline/issues/... page.',
    parameters: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Stage name (idea, prose, comic script, tv script, comic pages, storyboards, episode video).',
        },
      },
      required: ['stage'],
    },
    execute: async ({ stage } = {}, ctx = {}) => {
      const cur = parsePipelineIssuePath(ctx.state?.ui?.path);
      if (!cur) return NOT_ON_PIPELINE_ISSUE_PAGE;
      const key = String(stage || '').trim().toLowerCase();
      // Build a case-insensitive canonical lookup so "Prose", "PROSE",
      // "prose" all resolve. PIPELINE_STAGE_IDS is mixed-case ('idea',
      // 'comicScript', ...) so a direct .includes(key) wouldn't match;
      // compare lowercased forms instead.
      const canonicalById = PIPELINE_STAGE_IDS.find((id) => id.toLowerCase() === key);
      const canonical = PIPELINE_STAGE_ALIASES[key] || canonicalById || null;
      if (!canonical) {
        return {
          ok: false,
          error: `Unknown stage "${stage}"`,
          summary: `I don't know a stage named "${stage}". Try: idea, prose, comic script, tv script, comic pages, storyboards, or episode video.`,
        };
      }
      return navigateToPipelineStage(cur.issueId, canonical, ctx);
    },
  },
];

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
  meatspace_log_workout: 'meatspace',
  calendar_today: 'calendar',
  calendar_next: 'calendar',
  weather_now: 'weather',
  timer_set: 'timer',
  ui_describe_visually: 'vision',
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
  ui_read: 'ui',
  ui_click: 'ui',
  ui_fill: 'ui',
  ui_select: 'ui',
  ui_check: 'ui',
  ui_ask: 'ask',
  image_generate: 'media',
  pipeline_next_stage: 'pipeline',
  pipeline_prev_stage: 'pipeline',
  pipeline_open_stage: 'pipeline',
  // UNGROUPED = always-on: time_now, daily_log_append, ui_navigate.
  // brain_capture used to be always-on, but that caused form-fill turns
  // ("fill description with X") to be misrouted to brain_capture because
  // "note/save/remember" in the tool description overlaps with field
  // content. Gating on the brain regex keeps capture available for every
  // natural phrasing without tempting the LLM on UI-driving turns.
};

// Loose on purpose — false positives are cheap (one extra tool), false
// negatives are expensive (LLM guesses wrong or can't act).
export const UI_INTENT_RE = /\b(click|press|tap|hit|open|go to|take me|show me|navigate|select|pick|switch|choose|tab|button|dropdown|field|input|fill|enter|type|write|check|uncheck|toggle|link|option|on (?:this|the) page|what(?:'s)? (?:on|here|does (?:this|the page))|read (?:this|the page|me (?:this|the page|what))|read (?:it )?(?:aloud|out))\b/i;
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
  // Bare `run`/`ran` were dropped — they collide with common command phrasing
  // ("run the pipeline", "I ran the report") and would expose the workout tool
  // on non-fitness turns. Genuine run-logging is recovered via the "went
  // for/on a … run" phrasing and the "ran …" branch below, which requires a
  // fitness OBJECT — a distance/race ("ran a 5k", "ran 3 miles", "ran a
  // marathon"), a route ("ran my usual route", "ran my loop"), or a duration
  // WITH a time unit ("ran for 30 minutes", "ran for an hour"). The duration
  // branch insists on a minute/hour/second unit so "ran for a report", "ran for
  // office", and "ran for president" no longer match, just as "I ran a report",
  // "ran an errand", and "ran my mouth" don't. Other activity nouns
  // (jog/yoga/cardio/gym/…) rarely collide in voice commands.
  meatspace: /\b(drink|drank|beer|wine|whiskey|shot|cocktail|cigarette|vape|pouch|nicotine|weigh|pound|kilo|kg|smoke|smoking|workout|exercise|exercised|jog|yoga|lift(?:ed|ing)?|cardio|gym|cycling|cycled|swim|swam|how am I|summary today|log (?:a|my) (?:drink|weight|nicotine|workout|run|exercise))\b|\bwent (?:for|on) (?:a |an )?(?:\w+ ){0,2}(?:run|jog|swim|ride|walk|hike|workout)\b|\bran (?:a |an |my )?(?:\w+ ){0,2}(?:\d+\s?k\b|\d+\s?km\b|miles?\b|marathons?\b|half[- ]?marathons?\b|5k\b|10k\b|loops?\b|routes?\b|trails?\b|laps?\b)|\bran for (?:\w+ ){0,3}(?:hours?|hrs?|mins?|minutes?|seconds?|secs?)\b/i,
  // Calendar reads — "what's on my calendar", "what do I have today",
  // "next meeting", "what's next", "upcoming", "any appointments". Tight-ish
  // so plain "open calendar" still routes to ui_navigate, not calendar_today.
  calendar: /\b(calendar|agenda|meeting|appointment|event)s?\b|\bwhat(?:'s| is| do i have)?\b[^.!?\n]{0,30}\b(today|next|coming up|upcoming|scheduled|on my (?:plate|schedule|calendar))\b|\bwhat'?s next\b/i,
  // Weather — "what's the weather", "is it raining", "how hot/cold",
  // "temperature outside", "forecast".
  weather: /\b(weather|forecast|temperature|raining|snowing|sunny|cloudy|how (?:hot|cold|warm)|degrees? (?:out|outside))\b/i,
  // Timers / reminders — "set a timer", "remind me in N minutes", "ping me in".
  timer: /\b(set a timer|start a timer|timer for|remind me (?:in|to)|ping me in|alarm|countdown|wake me)\b/i,
  // Visual description — needs a vision model on a screenshot. "what's on this
  // chart/graph", "describe this", "what am I looking at", "what does this
  // look like". Kept distinct from `ui` (text read) so the LLM can choose
  // ui_read vs ui_describe_visually.
  vision: /\b(chart|graph|diagram|cyber ?city|3d|render(?:ing)?|visualization|picture|image|screenshot)\b|\b(?:what(?:'s| does| am i)?|describe)\b[^.!?\n]{0,30}\b(?:look(?:ing|s)? like|on (?:this|the) (?:chart|graph|screen|map)|visual(?:ly)?)\b/i,
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
  // Imagery verbs that should surface image_generate. Tight-ish: avoids
  // common false positives like "imagine if" or "show me a picture of the
  // page" by anchoring on creation verbs paired with visual nouns.
  media: /\b(?:generate|render|create|draw|sketch|paint|illustrate|make|design|produce)\b[^.!?\n]{0,30}\b(?:image|picture|photo|illustration|art(?:work)?|render|drawing|sketch|portrait|wallpaper|scene|asset|graphic|logo|icon)\b|\bimagegen\b/i,
  // Pipeline stage navigation — fires on "next stage", "previous stage",
  // "back to prose", "open the storyboards", "open prose", "open teleplay",
  // and the stage names + their spoken aliases (idea, prose, story,
  // comic script, teleplay, comic pages, pages, storyboards, scenes,
  // episode video, episode, video). The stage-name alternation is shared
  // across open/go-to/back-to so users don't need to say "stage" as a
  // suffix. The leading anchors keep "take me to pipeline" out of this
  // group — that still routes to ui_navigate.
  //
  // Alias list must mirror PIPELINE_STAGE_ALIASES below so any alias
  // accepted by pipeline_open_stage actually triggers the group.
  pipeline: /\b(?:next stage|previous stage|prev stage|stage (?:advance|forward|back)|(?:open|go to|back to)(?: the)? (?:idea|prose|story|comic ?script|comicscript|comics|tv ?script|tvscript|teleplay|comic ?pages?|comicpages|pages?|storyboards?|scenes|episode ?video|episodevideo|episode|video)(?: stage)?)\b/i,
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

// ----- Calendar helpers (calendar_today / calendar_next) -----
// The calendar cache stores ISO `startTime`/`endTime` (UTC or with offset) plus
// `title`, `location`, and `isAllDay` (the cache field name — see
// calendarGoogleSync.js / calendarApiSync.js; the tool's own output uses
// `allDay`). We format times in the user's TZ so a spoken "10 AM" matches the
// wall clock, not the server's UTC.
const formatEventTime = (iso, tz) => {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
};
const summarizeEvent = (e, tz) => {
  const start = formatEventTime(e?.startTime, tz);
  const when = e?.isAllDay ? 'all day' : (start || 'time TBD');
  const loc = e?.location ? ` at ${e.location}` : '';
  return `${e?.title || 'Untitled event'} (${when})${loc}`;
};
// UTC timestamp (ms) of local midnight for the `YYYY-MM-DD` day string in `tz`.
// The server runs TZ=UTC, so we subtract the TZ offset from the naive UTC parse
// of the day string. Evaluate the offset AT the target day's midnight (not at
// `now`) so a DST transition elsewhere in the day can't shift the result by an
// hour. The naive parse lands within ~14h of local midnight — close enough that
// re-evaluating the offset at that candidate instant converges to the correct
// offset across a DST boundary.
export const anchorLocalMidnightUtc = (dayStr, tz) => {
  const naiveUtc = Date.parse(`${dayStr}T00:00:00Z`);
  const firstOffset = getUtcOffsetMs(new Date(naiveUtc), tz);
  const candidate = naiveUtc - firstOffset;
  const refinedOffset = getUtcOffsetMs(new Date(candidate), tz);
  return naiveUtc - refinedOffset;
};

// ----- Weather helpers (weather_now) -----
// WMO weather interpretation codes → short spoken text. Open-Meteo returns the
// integer `weather_code`; this small table avoids pulling in a weather lib.
const WEATHER_CODES = {
  0: 'clear sky',
  1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};
const describeWeatherCode = (code) => WEATHER_CODES[code] ?? 'unknown conditions';
// Fallback location when the user hasn't set one and didn't pass lat/lon.
// San Francisco — a sensible documented default; the tool description tells
// the LLM to pass lat/lon when the user names a place.
const DEFAULT_LAT = 37.7749;
const DEFAULT_LON = -122.4194;

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
      const max = clampLimit(limit, 5, 10);
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
      const max = clampLimit(limit, 5, 10);
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
      const max = clampLimit(limit, 5, 10);
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
    name: 'ui_read',
    description:
      'Read back the visible text on the current page. Use when the user asks "what does this say?", "read this aloud", "what\'s on the page?", "read me the page". ' +
      'Returns the user-visible textual content of the main content area (excluding nav rails, asides, and the voice widget itself). ' +
      'Output is capped at ~8 KB; longer pages are tail-trimmed on a word boundary with an ellipsis. ' +
      'Default behavior (summarize=false): read the returned `content` verbatim — do NOT summarize. ' +
      'When the user asks for a summary instead ("what is this page about?", "summarize this page"), pass summarize=true and produce a short summary of `content` rather than reading it verbatim.',
    parameters: {
      type: 'object',
      properties: {
        summarize: {
          type: 'boolean',
          description: 'If true, the LLM may summarize before reading aloud (use when the user asks "what is this page about?" rather than "read this to me"). Default false — speak `content` verbatim.',
        },
      },
    },
    execute: async ({ summarize = false } = {}, ctx = {}) => {
      const ui = ctx?.state?.ui;
      // The client no longer ships the visible-text blob with every index —
      // it sets `textOnDemand` and we fetch it lazily here, only when ui_read
      // actually runs. Resolution order:
      //   1. Eager/legacy text already on the snapshot (older client, or a
      //      prior ui_read in this turn cached it) → use it directly.
      //   2. textOnDemand client → request it now via ctx.requestUiText().
      //   3. Neither (very old / no widget) → "no text available".
      let text = typeof ui?.text === 'string' && ui.text.trim() ? ui.text : null;
      if (!text && ui?.textOnDemand && typeof ctx?.requestUiText === 'function') {
        const fetched = await ctx.requestUiText();
        if (typeof fetched === 'string' && fetched.trim()) text = fetched;
      }
      if (!text) {
        return {
          ok: false,
          error: 'No page text available',
          summary: "I can't see the page content right now — make sure the voice widget is loaded and try again.",
        };
      }
      return {
        ok: true,
        path: ui?.path,
        title: ui?.title,
        content: text,
        chars: text.length,
        summarize: !!summarize,
        // Keep `summary` short so the LLM message history isn't doubled — the
        // full body lives in `content`.
        summary: `Read page "${ui?.title || ui?.path || 'current page'}" (${text.length} chars).`,
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
      // Destructive-action confirmation gate. If the resolved label looks
      // destructive (delete/remove/discard/reset/clear), stash a pending
      // record on the per-session state and ask the LLM to prompt the user
      // for spoken confirmation. The next user turn is intercepted by
      // pipeline.js → resolvePending() which either re-issues the click or
      // cancels. Skip if the caller already confirmed (re-issue path).
      if (ctx.state && !ctx.confirmed && isDestructiveLabel(hit.entry.label)) {
        ctx.state.pendingDestructive = buildPending({
          tool: 'ui_click',
          args: { label: hit.entry.label, kind: hit.entry.kind },
          target: { ref: hit.entry.ref, label: hit.entry.label, kind: hit.entry.kind },
        });
        return {
          ok: true,
          confirmation_required: true,
          label: hit.entry.label,
          kind: hit.entry.kind,
          summary: `That looks destructive — confirm by saying "yes" or "confirm" to ${hit.entry.label}, or "cancel" to skip.`,
        };
      }
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
    name: 'image_generate',
    description:
      'Generate an image from a text prompt and save it to the user\'s gallery. Defaults to the user\'s saved Image Gen backend (Local mflux, External SD API, or Codex CLI). Pass `provider` to override per-call: "local" for fast Flux drafts, "external" for an A1111-compatible server, "codex" for the Codex CLI built-in image_gen tool (subject to the user enabling it in Settings). Returns the saved file path.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to draw, in natural language. Be specific about subject, style, and mood.',
        },
        provider: {
          type: 'string',
          enum: ['auto', ...imageGen.IMAGE_GEN_MODES],
          description: '"auto" (default) uses the user\'s saved backend. Override only when the user explicitly asks for a specific one or the task strongly favors it.',
        },
        negativePrompt: {
          type: 'string',
          description: 'Optional list of things to avoid (e.g. "watermark, low quality").',
        },
        width: { type: 'integer', description: 'Optional pixel width (64-2048).' },
        height: { type: 'integer', description: 'Optional pixel height (64-2048).' },
      },
      required: ['prompt'],
    },
    execute: async ({ prompt, provider, negativePrompt, width, height } = {}) => {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return { ok: false, summary: 'prompt is required' };
      }
      // Match the /api/image-gen/generate Zod schema (max 2000 chars).
      // Voice tool calls bypass the route entirely, so without this an
      // oversized prompt would propagate to providers and fail with a
      // less helpful error (codex CLI in particular hits OS ARG_MAX
      // limits before the model even sees the prompt).
      if (prompt.length > 2000) {
        return { ok: false, summary: 'prompt must be 2000 characters or fewer' };
      }
      const requestedMode = (provider && provider !== 'auto') ? provider : undefined;
      // Codex is gated separately — it costs against the user's Codex plan,
      // and not every plan exposes image_gen. The dispatcher would also
      // reject this, but catching it here lets us return a friendlier
      // summary to the voice agent / palette.
      if (requestedMode === imageGen.IMAGE_GEN_MODE.CODEX) {
        const s = await getSettings();
        if (!s?.imageGen?.codex?.enabled) {
          return { ok: false, summary: 'Codex Imagegen is disabled — enable it in Settings → Image Gen first.' };
        }
      }
      // LLMs/tool callers often hand back numeric args as strings ("512").
      // Coerce + bounds-check before forwarding — the route's Zod schema
      // also gates these, but voice tool calls bypass the route, so an
      // unvalidated string would propagate to providers that build
      // payloads with raw width values (external SD API: "width": "512").
      const normalizeDimension = (value, name) => {
        if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 64 || parsed > 2048) {
          return { ok: false, summary: `${name} must be an integer between 64 and 2048` };
        }
        return { ok: true, value: parsed };
      };
      const w = normalizeDimension(width, 'width');
      if (!w.ok) return w;
      const h = normalizeDimension(height, 'height');
      if (!h.ok) return h;
      // Local + codex backends return a job descriptor synchronously and
      // emit 'completed'/'failed' on imageGenEvents when the file actually
      // lands. Subscribe BEFORE calling generateImage so a fast job can't
      // emit 'completed' before we attach. External backends await the
      // upstream HTTP call internally and the file is on disk by the time
      // generateImage resolves — wait() is a no-op there.
      // 5-min cap mirrors the codex provider's own timeout — a stuck job
      // shouldn't leak listeners into the voice/palette dispatcher forever.
      const waiter = createImageGenWaiter({ timeoutMs: 5 * 60 * 1000 });

      let result;
      try {
        result = await imageGen.generateImage({
          prompt: prompt.trim(),
          negativePrompt: negativePrompt?.trim() || undefined,
          width: w.value,
          height: h.value,
          mode: requestedMode,
        });
      } catch (err) {
        waiter.cleanup();
        return { ok: false, summary: `Image generation failed: ${err?.message || err}` };
      }

      const usedMode = result?.mode || requestedMode || 'default';
      const isAsync = usedMode === imageGen.IMAGE_GEN_MODE.LOCAL || usedMode === imageGen.IMAGE_GEN_MODE.CODEX;
      // External resolves with the file already on disk — short-circuit.
      if (!isAsync) {
        waiter.cleanup();
        return {
          ok: true,
          path: result?.path,
          filename: result?.filename,
          mode: usedMode,
          summary: `Generated image (${usedMode}): ${result?.filename || 'pending'}`,
        };
      }

      waiter.register(result.generationId);
      const ev = await waiter.promise.catch((errEv) => ({ __failed: true, ...errEv }));
      if (ev?.__failed) {
        return { ok: false, summary: `Image generation failed: ${ev.error || 'unknown'}` };
      }
      // The 'completed' event carries the canonical path/filename — prefer
      // it over the descriptor returned by generateImage (which may not
      // have the final filename in some providers).
      return {
        ok: true,
        path: ev?.path || result?.path,
        filename: ev?.filename || result?.filename,
        mode: usedMode,
        summary: `Generated image (${usedMode}): ${ev?.filename || result?.filename}`,
      };
    },
  },

  ...PIPELINE_STAGE_TOOLS,

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

  {
    name: 'calendar_today',
    description:
      "Report today's calendar events. Use when the user asks \"what's on my calendar today?\", \"what do I have today?\", \"any meetings today?\". Reads from the user's synced calendar accounts (Google etc.). Returns up to 10 events with title, time, and location.",
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max events to return (default 10, max 20).' },
      },
    },
    execute: async ({ limit = 10 } = {}) => {
      const max = clampLimit(limit, 10, 20);
      const tz = await getUserTimezone();
      const today = todayInTimezone(tz); // YYYY-MM-DD in the user's TZ
      // The server runs TZ=UTC and event startTimes carry an offset/Z, so the
      // [startDate, endDate] bounds must be the user's LOCAL day expressed in
      // UTC — otherwise a late-evening PT event lands on the next UTC day and
      // gets dropped. Anchor midnight-local by subtracting the TZ offset, but
      // evaluate that offset at the TARGET day's midnight (not at `now`): on a
      // DST-transition day the offset at `now` can differ from the offset at
      // midnight by an hour, shifting the window and dropping/duplicating
      // boundary events. Two passes converge (the first guess lands within
      // ~14h of local midnight; the second re-evaluates at that instant).
      const localMidnightUtc = anchorLocalMidnightUtc(today, tz);
      const startDate = new Date(localMidnightUtc).toISOString();
      const endDate = new Date(localMidnightUtc + 86399999).toISOString();
      const { events = [] } = await getCalendarEvents({ startDate, endDate, limit: max });
      const items = events.map((e) => ({
        title: e.title,
        startTime: e.startTime,
        time: e.isAllDay ? 'all day' : formatEventTime(e.startTime, tz),
        location: e.location || null,
        allDay: !!e.isAllDay,
      }));
      return {
        ok: true,
        date: today,
        count: items.length,
        events: items,
        summary: items.length
          ? `${items.length} event${items.length === 1 ? '' : 's'} today: ${events.slice(0, max).map((e) => summarizeEvent(e, tz)).join('; ')}.`
          : 'Nothing on your calendar today.',
      };
    },
  },

  {
    name: 'calendar_next',
    description:
      'Report the next upcoming calendar event. Use when the user asks "what\'s next?", "what\'s my next meeting?", "when\'s my next appointment?". Reads from the user\'s synced calendar accounts and returns the soonest event starting from now.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const tz = await getUserTimezone();
      const nowIso = new Date().toISOString();
      // Look ahead 30 days; getEvents returns events sorted ascending by
      // startTime, so the first one at/after now is "next". Pull a small
      // window and filter in-memory rather than relying on exact boundary.
      const horizon = new Date(Date.now() + 30 * 86400000).toISOString();
      const { events = [] } = await getCalendarEvents({
        startDate: nowIso,
        endDate: horizon,
        limit: 50,
      });
      // Match calendarSync.getEvents' range semantics (it keeps events whose
      // endTime >= startDate), so an in-progress meeting and an all-day event
      // that began at local midnight today both still count as "next" — a
      // strict startTime >= now would drop them. Use endTime when present,
      // falling back to startTime for events that carry only a start.
      const nowMs = Date.now();
      const next = events.find((e) => {
        const ref = new Date(e?.endTime || e?.startTime);
        return !Number.isNaN(ref.getTime()) && ref.getTime() >= nowMs;
      });
      if (!next) {
        return { ok: true, found: false, summary: 'Nothing coming up on your calendar in the next 30 days.' };
      }
      const startDate = new Date(next.startTime);
      const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(startDate);
      const timeLabel = next.isAllDay ? 'all day' : (formatEventTime(next.startTime, tz) || 'time TBD');
      const loc = next.location ? ` at ${next.location}` : '';
      return {
        ok: true,
        found: true,
        title: next.title,
        startTime: next.startTime,
        location: next.location || null,
        allDay: !!next.isAllDay,
        summary: `Next up: ${next.title || 'Untitled event'} — ${dayLabel}, ${timeLabel}${loc}.`,
      };
    },
  },

  {
    name: 'meatspace_log_workout',
    description:
      'Log a workout / exercise session to Meatspace tracking. Use when the user says "log a workout", "I went for a 30 minute run", "did an hour of yoga", "lifted weights for 45 minutes". The `type` is free-form (run, yoga, lifting, cycling, swim, etc.). Duration and intensity are optional.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Workout type (e.g. "run", "yoga", "weightlifting", "cycling").' },
        durationMinutes: { type: 'number', description: 'How long, in minutes. Omit if unknown.' },
        intensity: { type: 'string', enum: ['light', 'moderate', 'vigorous'], description: 'Optional perceived intensity.' },
        notes: { type: 'string', description: 'Optional free-form notes about the session.' },
        date: { type: 'string', description: 'ISO date (YYYY-MM-DD). Omit for today.' },
      },
      required: ['type'],
    },
    execute: async ({ type, durationMinutes, intensity, notes, date } = {}) => {
      if (typeof type !== 'string' || !type.trim()) throw new Error('type is required');
      let resolvedDuration;
      if (durationMinutes !== undefined && durationMinutes !== null && durationMinutes !== '') {
        const parsed = Number(durationMinutes);
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1440) {
          throw new Error('durationMinutes must be a positive number (≤1440)');
        }
        resolvedDuration = parsed;
      }
      if (intensity !== undefined && intensity !== null && !['light', 'moderate', 'vigorous'].includes(intensity)) {
        throw new Error('intensity must be light, moderate, or vigorous');
      }
      const entry = await addWorkout({
        date,
        type: type.trim(),
        durationMinutes: resolvedDuration,
        intensity,
        notes,
      });
      const durPart = entry.durationMinutes ? ` (${entry.durationMinutes} min)` : '';
      return {
        ok: true,
        date: entry.date,
        type: entry.type,
        summary: `Logged ${entry.type}${durPart} on ${entry.date}.`,
      };
    },
  },

  {
    name: 'weather_now',
    description:
      'Report the current weather (temperature + conditions) for a location. Use when the user asks "what\'s the weather?", "is it raining?", "how hot is it outside?". Pass `lat`/`lon` for a specific place; with no coordinates it uses a saved location if one is configured, otherwise a default location. Uses the free Open-Meteo service (no API key).',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude (-90 to 90). Omit to use the configured/default location.' },
        lon: { type: 'number', description: 'Longitude (-180 to 180). Omit to use the configured/default location.' },
      },
    },
    execute: async ({ lat, lon } = {}) => {
      // Resolve location: explicit params > settings.location > default.
      // numOrNull guards both paths so a null/empty/cleared coordinate falls
      // through to the default — `Number(null)` is 0 (a valid-but-wrong 0,0
      // coordinate), so reusing this helper for the config values is what keeps
      // a cleared `settings.location` from pinning the Gulf of Guinea.
      const numOrNull = (v) => {
        if (v === undefined || v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const settings = await getSettings().catch(() => ({}));
      const cfgLat = numOrNull(settings?.location?.lat);
      const cfgLon = numOrNull(settings?.location?.lon);
      const resolvedLat = numOrNull(lat) ?? cfgLat ?? DEFAULT_LAT;
      const resolvedLon = numOrNull(lon) ?? cfgLon ?? DEFAULT_LON;
      if (resolvedLat < -90 || resolvedLat > 90 || resolvedLon < -180 || resolvedLon > 180) {
        return { ok: false, summary: 'Latitude must be -90..90 and longitude -180..180.' };
      }
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${resolvedLat}&longitude=${resolvedLon}`
        + '&current=temperature_2m,weather_code&temperature_unit=fahrenheit';
      const res = await fetchWithTimeout(url, {}, 10000).catch((err) => ({ ok: false, error: err?.message }));
      if (!res || !res.ok) {
        return { ok: false, summary: `Couldn't reach the weather service${res?.error ? ` (${res.error})` : ''}.` };
      }
      const data = await res.json().catch(() => null);
      const current = data?.current;
      if (!current || typeof current.temperature_2m !== 'number') {
        return { ok: false, summary: 'The weather service returned no current conditions.' };
      }
      const temp = Math.round(current.temperature_2m);
      const conditions = describeWeatherCode(current.weather_code);
      return {
        ok: true,
        lat: resolvedLat,
        lon: resolvedLon,
        temperatureF: temp,
        weatherCode: current.weather_code,
        conditions,
        summary: `It's ${temp}°F and ${conditions} right now.`,
      };
    },
  },

  {
    name: 'timer_set',
    description:
      'Set a one-shot timer or reminder. Use when the user says "set a timer for 10 minutes", "remind me in 30 minutes to call mom", "ping me in an hour". When the timer fires, PortOS raises a notification with the label. Specify the duration in minutes (or seconds for short timers).',
    parameters: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Timer duration in minutes. Use this for most timers.' },
        seconds: { type: 'number', description: 'Timer duration in seconds. Use for short timers; added to minutes if both given.' },
        label: { type: 'string', description: 'What to remind the user about (e.g. "tea is ready", "call mom").' },
      },
    },
    execute: async ({ minutes, seconds, label } = {}) => {
      const mins = Number.isFinite(Number(minutes)) ? Number(minutes) : 0;
      const secs = Number.isFinite(Number(seconds)) ? Number(seconds) : 0;
      const totalMs = Math.round((mins * 60 + secs) * 1000);
      // Bound: at least 1s, at most 24h. An LLM-supplied NaN/negative or an
      // absurd duration shouldn't schedule a runaway timer.
      if (!Number.isFinite(totalMs) || totalMs < 1000) {
        return { ok: false, summary: 'Tell me how long — e.g. "set a timer for 10 minutes".' };
      }
      if (totalMs > 24 * 60 * 60 * 1000) {
        return { ok: false, summary: 'Timers are capped at 24 hours. For longer reminders, add a calendar event.' };
      }
      const trimmedLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : 'Timer';
      // Delegate to the persistent scheduler — it survives a restart (re-armed
      // at boot, overdue ones fired once) and dedups an LLM re-issuing the same
      // timer inside one reasoning loop.
      const scheduled = scheduleTimer({ totalMs, label: trimmedLabel });
      const totalSecs = Math.round(totalMs / 1000);
      const human = totalSecs >= 60
        ? `${Math.round(totalSecs / 60)} minute${Math.round(totalSecs / 60) === 1 ? '' : 's'}`
        : `${totalSecs} second${totalSecs === 1 ? '' : 's'}`;
      console.log(`⏰ Timer set for ${human}: "${trimmedLabel}"${scheduled?.deduped ? ' (deduped — already armed)' : ''}`);
      return {
        ok: true,
        durationMs: totalMs,
        label: trimmedLabel,
        summary: `Timer set for ${human}${trimmedLabel !== 'Timer' ? ` — I'll remind you to ${trimmedLabel}` : ''}.`,
      };
    },
  },

  {
    name: 'ui_describe_visually',
    description:
      "Take a screenshot of what the user is currently looking at and describe it using a vision model. Use when the user asks about VISUAL content the text-based ui_read can't capture — \"what's on this chart?\", \"describe this graph\", \"what does the CyberCity look like right now?\", \"what am I looking at?\". For plain text content prefer ui_read; only reach for this when the answer requires SEEING pixels (charts, 3D/WebGL views, images, diagrams). The screenshot is captured client-side (the browser may prompt for screen-capture permission the first time).",
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What the user wants to know about the screen (e.g. "what does this chart show?"). Defaults to a general description.',
        },
      },
    },
    execute: async ({ question } = {}, ctx = {}) => {
      if (typeof ctx.captureScreenshot !== 'function') {
        return {
          ok: false,
          error: 'No screenshot channel',
          summary: "I can't capture the screen right now — this only works through the live voice widget.",
        };
      }
      const prompt = (typeof question === 'string' && question.trim())
        ? `${question.trim()}\n\nAnswer concisely based only on what is visible in this screenshot.`
        : 'Describe what is visible in this screenshot of an app screen, concisely.';
      // Ask the client to capture the active tab. Returns a data URL (base64
      // PNG/JPEG) or null if the user denied / capture failed.
      const dataUrl = await ctx.captureScreenshot().catch(() => null);
      if (!dataUrl || typeof dataUrl !== 'string') {
        return {
          ok: false,
          error: 'Screenshot capture failed',
          summary: "I couldn't capture the screen — the browser may have blocked screen capture. Try again and allow it.",
        };
      }
      const description = await ctx.describeImage(dataUrl, prompt).catch((err) => ({ __error: err?.message || String(err) }));
      if (description?.__error) {
        return { ok: false, error: description.__error, summary: `I captured the screen but the vision model failed: ${description.__error}` };
      }
      const text = typeof description === 'string' ? description.trim() : '';
      if (!text) {
        return { ok: false, summary: 'I captured the screen but the vision model returned nothing.' };
      }
      return {
        ok: true,
        content: text,
        path: ctx.state?.ui?.path || null,
        // Keep summary short — the full description is in `content` for the LLM
        // to speak verbatim (mirrors ui_read / ui_ask).
        summary: `Described the current screen (${text.length} chars).`,
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
