// Voice Chief-of-Staff tool orchestrator. The tool DEFINITIONS live in the
// per-domain modules under ./tools/ (brain, meatspace, goals, system, dailylog,
// ui, ask, vision, ambient, timer, media, pipeline, code, catalog). This file
// assembles them into the single TOOLS registry, wires per-turn intent filtering
// (TOOL_GROUPS + GROUP_INTENT), and exposes the stable public API consumed by
// the voice pipeline (pipeline.js) and the ⌘K command palette (routes/palette.js):
//   getToolSpecs, getToolSpecsForIntent, getAllToolNames, getToolMetadata,
//   classifyIntent, dispatchTool, UI_KINDS, UI_INTENT_RE, UI_FILL_INTENT_RE,
//   anchorLocalMidnightUtc.
// Add a new tool by adding it to its domain module's tool array (and, if it
// should be intent-gated, mapping its name in TOOL_GROUPS to a GROUP_INTENT key).

import { BRAIN_TOOLS, BRAIN_INTENT_RE } from './tools/brain.js';
import { MEATSPACE_TOOLS, MEATSPACE_INTENT_RE } from './tools/meatspace.js';
import { GOALS_TOOLS, GOALS_INTENT_RE } from './tools/goals.js';
import { SYSTEM_TOOLS, SYSTEM_INTENT_RE, FEEDS_INTENT_RE } from './tools/system.js';
import { DAILYLOG_TOOLS, DAILYLOG_INTENT_RE } from './tools/dailylog.js';
import { UI_TOOLS, UI_INTENT_RE, UI_FILL_INTENT_RE } from './tools/ui.js';
import { ASK_TOOLS, ASK_INTENT_RE } from './tools/ask.js';
import { VISION_TOOLS, VISION_INTENT_RE } from './tools/vision.js';
import { AMBIENT_TOOLS, CALENDAR_INTENT_RE, WEATHER_INTENT_RE, anchorLocalMidnightUtc } from './tools/ambient.js';
import { TIMER_TOOLS, TIMER_INTENT_RE } from './tools/timer.js';
import { MEDIA_TOOLS, MEDIA_INTENT_RE } from './tools/media.js';
import { PIPELINE_TOOLS, PIPELINE_INTENT_RE } from './tools/pipeline.js';
import { CODE_TOOLS, CODE_INTENT_RE } from './tools/code.js';
import { CATALOG_TOOLS, CATALOG_INTENT_RE, catalogTypeEnum, matchesCustomCatalogNoun } from './tools/catalog.js';
import { WORKSPACE_TOOLS, WORKSPACE_INTENT_RE } from './tools/workspace.js';
import { UI_KINDS } from './tools/shared.js';

// Re-exported for pipeline.js (UI_KINDS, UI_INTENT_RE) and the form-fill
// suppression check; anchorLocalMidnightUtc is re-exported for the unit tests
// that exercise the DST-anchoring math directly.
export { UI_KINDS, UI_INTENT_RE, UI_FILL_INTENT_RE, anchorLocalMidnightUtc };

// The registry. Order is not load-bearing (consumers resolve by name/id) but
// kept domain-grouped for readability.
const TOOLS = [
  ...BRAIN_TOOLS,
  ...MEATSPACE_TOOLS,
  ...GOALS_TOOLS,
  ...SYSTEM_TOOLS,
  ...DAILYLOG_TOOLS,
  ...UI_TOOLS,
  ...ASK_TOOLS,
  ...VISION_TOOLS,
  ...AMBIENT_TOOLS,
  ...TIMER_TOOLS,
  ...MEDIA_TOOLS,
  ...PIPELINE_TOOLS,
  ...CODE_TOOLS,
  ...CATALOG_TOOLS,
  ...WORKSPACE_TOOLS,
];

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
  dispatch_code_agent: 'code',
  code_agent_status: 'code',
  catalog_lookup: 'catalog',
  workspace_switch: 'workspace',
  // UNGROUPED = always-on: time_now, daily_log_append, ui_navigate.
  // brain_capture used to be always-on, but that caused form-fill turns
  // ("fill description with X") to be misrouted to brain_capture because
  // "note/save/remember" in the tool description overlaps with field
  // content. Gating on the brain regex keeps capture available for every
  // natural phrasing without tempting the LLM on UI-driving turns.
};

// Intent regexes per group. Each regex is defined alongside its tools in the
// domain module and imported here so the regex and the tools it gates can't
// drift apart. The keys MUST match the group values in TOOL_GROUPS (the
// fail-fast guard below enforces it).
const GROUP_INTENT = {
  brain: BRAIN_INTENT_RE,
  meatspace: MEATSPACE_INTENT_RE,
  calendar: CALENDAR_INTENT_RE,
  weather: WEATHER_INTENT_RE,
  timer: TIMER_INTENT_RE,
  vision: VISION_INTENT_RE,
  goals: GOALS_INTENT_RE,
  system: SYSTEM_INTENT_RE,
  feeds: FEEDS_INTENT_RE,
  dailylog: DAILYLOG_INTENT_RE,
  ask: ASK_INTENT_RE,
  media: MEDIA_INTENT_RE,
  pipeline: PIPELINE_INTENT_RE,
  code: CODE_INTENT_RE,
  ui: UI_INTENT_RE,
  catalog: CATALOG_INTENT_RE,
  workspace: WORKSPACE_INTENT_RE,
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

// Fail-fast: every name in TOOL_GROUPS must reference a real registered tool.
// A renamed/removed tool that still carries a stale group mapping would
// otherwise sit silently in the map, gating a name that no longer exists.
const TOOL_NAME_SET = new Set(TOOLS.map((t) => t.name));
for (const name of Object.keys(TOOL_GROUPS)) {
  if (!TOOL_NAME_SET.has(name)) {
    throw new Error(`voice tools: TOOL_GROUPS["${name}"] references a tool that isn't registered`);
  }
}

// Resolve a tool's parameter schema at spec-build time. `catalog_lookup`'s
// `type` enum is widened to the active type registry (built-in + user-defined
// catalog types) so a user's custom kind ("faction", "wardrobe") is advertised
// to the LLM and voice "search my factions" can filter on it. Other tools pass
// their static schema through untouched.
const resolveParameters = (t) => {
  if (t.name !== 'catalog_lookup') return t.parameters;
  return {
    ...t.parameters,
    properties: {
      ...t.parameters.properties,
      type: { ...t.parameters.properties.type, enum: catalogTypeEnum() },
    },
  };
};

const toSpec = (t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: resolveParameters(t) },
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
  // The static `catalog` regex only knows the six built-in nouns. A user-defined
  // type (e.g. "wardrobe", "faction") wouldn't trip it, so "search my wardrobes"
  // would never surface `catalog_lookup` (the enum-widening in resolveParameters
  // can't help a tool that intent-gating already dropped). Activate the catalog
  // group when the utterance mentions any active user type's id or label.
  if (!active.has('catalog') && matchesCustomCatalogNoun(userText)) {
    active.add('catalog');
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
