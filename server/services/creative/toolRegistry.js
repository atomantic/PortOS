// Creative Tool Registry + gated dispatch (#2183, CDO Phase 1).
//
// A single registry of creative-suite tools an orchestrating agent (the future
// Creative Director orchestrator, epic #2182) can call, plus the ONE dispatch
// chokepoint that makes autonomous use governable. Follows the voice-tools shape
// (server/services/voice/tools.js: {name, description, parameters, execute} +
// import-time integrity guards + a single dispatch fn) and the palette hydration
// pattern (server/routes/palette.js: reference existing schemas via
// getToolMetadata(), don't duplicate).
//
// Conductor, not re-implementation: every tool wraps an EXISTING service entry
// point (createUniverse, generateStep, startSeriesAutopilot, enqueueJob, …). The
// tools themselves stay UNGUARDED — direct user actions through the existing
// routes behave exactly as before. The gate lives ONLY here in
// dispatchCreativeTool: it enforces the `creative` autonomy mode, charges the
// daily action budget for llm/render tools, and appends to the calling project's
// run ledger. This is the governance point the AI Provider Usage Policy requires
// for autonomous creative work (the audit found only Series Autopilot and
// Writers-Room live mode self-gate today).

import { getCreativeAutonomyMode } from '../../lib/domainAutonomy.js';
import { getToolMetadata, getToolSpecs as getVoiceToolSpecs } from '../voice/tools.js';
import { loadState } from '../cosState.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import { appendCreativeLedgerEntry, argsDigest } from './creativeRunLedger.js';
import { COST_CLASSES, BUDGETED_COST_CLASSES } from './tools/shared.js';
import { UNIVERSE_TOOLS } from './tools/universe.js';
import { STORY_BUILDER_TOOLS } from './tools/storyBuilder.js';
import { WRITERS_ROOM_TOOLS } from './tools/writersRoom.js';
import { PIPELINE_TOOLS } from './tools/pipeline.js';
import { MEDIA_TOOLS } from './tools/media.js';
import { CATALOG_TOOLS } from './tools/catalog.js';

// The daily action budget the creative gate charges against. Creative
// orchestration mirrors the cos autonomy posture (see getCreativeAutonomyMode),
// so it also shares the cos daily budget/usage ledger rather than introducing a
// parallel one — a single autonomous-work budget. A dedicated `creative` budget
// (and its settings UI) can arrive with CDO Phase 4.
const BUDGET_DOMAIN = 'cos';

// The registry. Order isn't load-bearing (consumers resolve by name).
export const CREATIVE_TOOLS = [
  ...UNIVERSE_TOOLS,
  ...STORY_BUILDER_TOOLS,
  ...WRITERS_ROOM_TOOLS,
  ...PIPELINE_TOOLS,
  ...MEDIA_TOOLS,
  ...CATALOG_TOOLS,
];

const COST_SET = new Set(COST_CLASSES);

// OpenAI/compatible function-calling APIs only accept names matching this
// pattern — a dotted `domain.action` name would make the model request 400
// before the orchestrator could dispatch. Enforce it at load so a new tool
// can't reintroduce an unsafe name.
const SAFE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Fail-fast integrity check (navManifest / voice-tools precedent): every tool
 * must carry a unique name, a Zod schema, an execute fn, and a valid cost class;
 * a `hydrateFrom` must reference a real voice tool. Throws on the first offender.
 * Pure + exported so the guard is unit-tested directly against bad inputs, and
 * called at module load so a bad tool blocks boot loudly.
 *
 * @param {Array<object>} tools
 * @param {(id: string) => object|null} [resolveMeta] - voice metadata resolver
 */
export function assertCreativeToolIntegrity(tools, resolveMeta = getToolMetadata) {
  const seen = new Set();
  for (const t of tools) {
    if (!t || typeof t.name !== 'string' || !t.name) {
      throw new Error('creative tools: a tool is missing its name');
    }
    if (!SAFE_TOOL_NAME_RE.test(t.name)) {
      throw new Error(`creative tools: "${t.name}" is not a function-calling-safe name (letters/digits/_/-, ≤64 chars)`);
    }
    if (seen.has(t.name)) {
      throw new Error(`creative tools: duplicate tool name "${t.name}"`);
    }
    seen.add(t.name);
    if (typeof t.execute !== 'function') {
      throw new Error(`creative tools: "${t.name}" is missing execute()`);
    }
    if (!t.schema || typeof t.schema.parse !== 'function') {
      throw new Error(`creative tools: "${t.name}" is missing a Zod schema`);
    }
    if (!COST_SET.has(t.costClass)) {
      throw new Error(`creative tools: "${t.name}" has invalid costClass "${t.costClass}"`);
    }
    if (t.hydrateFrom && !resolveMeta(t.hydrateFrom)) {
      throw new Error(`creative tools: "${t.name}" hydrateFrom "${t.hydrateFrom}" is not a known voice tool`);
    }
  }
}

assertCreativeToolIntegrity(CREATIVE_TOOLS);

const byName = new Map(CREATIVE_TOOLS.map((t) => [t.name, t]));

// Resolve a tool's advertised description + parameters. When a tool declares
// `hydrateFrom`, pull them from the voice tool's fully-RESOLVED spec of that name
// (single source of schemas — the palette pattern) instead of the tool's own
// authored fallback. It reads the resolved `getToolSpecs()` output rather than
// the static `getToolMetadata()` so any spec-build-time widening survives — e.g.
// `catalog_lookup` widens its `type` enum to the user's active custom catalog
// types, which the static metadata doesn't carry; hydrating from the metadata
// would advertise only the built-in types to the orchestrator.
function resolveDisplay(t) {
  if (t.hydrateFrom) {
    const spec = getVoiceToolSpecs().find((s) => s.function?.name === t.hydrateFrom);
    if (spec) return { description: spec.function.description, parameters: spec.function.parameters };
  }
  return { description: t.description, parameters: t.parameters };
}

const toSpec = (t) => {
  const { description, parameters } = resolveDisplay(t);
  return { type: 'function', function: { name: t.name, description, parameters } };
};

/**
 * OpenAI-function-style specs for the registry, suitable for inclusion in a CoS
 * agent prompt. Destructive tools (delete/overwrite) are excluded by default so
 * an orchestrator prompt can't casually invoke them; pass `includeDestructive`
 * to surface them for an explicitly-approved flow.
 *
 * @param {{includeDestructive?: boolean}} [opts]
 */
// Pure (exported for the destructive-exclusion test): the tools that belong in
// the default spec set. Destructive tools are dropped unless explicitly included.
export const filterDestructive = (tools, includeDestructive) =>
  tools.filter((t) => includeDestructive || !t.destructive);

export const getToolSpecs = ({ includeDestructive = false } = {}) =>
  filterDestructive(CREATIVE_TOOLS, includeDestructive).map(toSpec);

export const getAllCreativeToolNames = () => CREATIVE_TOOLS.map((t) => t.name);

/**
 * Plain metadata for one tool (for non-LLM consumers, e.g. a plan board or the
 * command palette). Shape-independent from getToolSpecs.
 *
 * @param {string} name
 */
export const getCreativeToolMetadata = (name) => {
  const t = byName.get(name);
  if (!t) return null;
  const { description, parameters } = resolveDisplay(t);
  return {
    id: t.name,
    description,
    parameters,
    costClass: t.costClass,
    longRunning: Boolean(t.longRunning),
    destructive: Boolean(t.destructive),
  };
};

// Best-effort audit append — a ledger write failure must never break the tool
// run. Injected `ctx.appendLedger` wins (Phase 2 will route entries onto the CD
// project record); otherwise a project-scoped file ledger is used when a
// projectId is present. A project-less dispatch simply isn't audited.
async function recordLedger(ctx, entry) {
  try {
    if (typeof ctx?.appendLedger === 'function') {
      await ctx.appendLedger(entry);
      return;
    }
    if (ctx?.projectId) {
      await appendCreativeLedgerEntry(ctx.projectId, entry);
    }
  } catch (err) {
    console.error(`❌ creative ledger append failed for ${entry.tool}: ${err.message}`);
  }
}

/**
 * The single governed dispatch chokepoint for orchestrator tool calls.
 *
 * Flow: validate args (Zod) → resolve the `creative` autonomy mode → gate →
 * (execute mode only) charge budget for llm/render → run → append to the run
 * ledger. Modes:
 *   - `off`      → reject without executing or charging.
 *   - `dry-run`  → return a plan frame describing what WOULD run; no side effects.
 *   - `execute`  → charge budget (llm/render) then run the wrapped entry point.
 *
 * @param {string} name - registered tool name
 * @param {object} args - tool arguments (validated against the tool's schema)
 * @param {{projectId?: string, appendLedger?: Function, [k: string]: unknown}} ctx
 * @returns {Promise<object>}
 */
export async function dispatchCreativeTool(name, args = {}, ctx = {}) {
  const tool = byName.get(name);
  if (!tool) throw new Error(`Unknown creative tool: ${name}`);

  // Validate up front — a Zod parse failure throws before any gating/side effect.
  const parsed = tool.schema.parse(args ?? {});

  const state = await loadState().catch(() => ({ config: {} }));
  const mode = getCreativeAutonomyMode(state.config);
  const base = { tool: name, argsDigest: argsDigest(parsed), costClass: tool.costClass, mode };

  if (mode === 'off') {
    console.log(`🚫 creative dispatch ${name} rejected (creative autonomy: off)`);
    await recordLedger(ctx, { ...base, outcome: 'rejected', timingMs: 0 });
    return { ok: false, rejected: true, reason: 'autonomy-off', mode, tool: name };
  }

  if (mode === 'dry-run') {
    console.log(`📝 creative dispatch ${name} planned (dry-run)`);
    await recordLedger(ctx, { ...base, outcome: 'planned', timingMs: 0 });
    return {
      ok: true,
      planned: true,
      mode,
      tool: name,
      costClass: tool.costClass,
      longRunning: Boolean(tool.longRunning),
      destructive: Boolean(tool.destructive),
      args: parsed,
    };
  }

  // execute mode — charge the daily action budget for llm/render tools first,
  // EXCEPT self-budgeting tools: a long-running coordinator (Series Autopilot)
  // budget-gates and records each of its own LLM/render steps against the same
  // cos budget internally, so charging one action here would double-count and,
  // under a tight cap, consume the last action before the run does any work.
  let charged = false;
  if (BUDGETED_COST_CLASSES.has(tool.costClass) && !tool.selfBudgeted) {
    const status = await getDomainBudgetStatus(BUDGET_DOMAIN);
    if (!status.withinBudget) {
      console.log(`⛔ creative dispatch ${name} over budget (${BUDGET_DOMAIN} ${status.exceeded})`);
      await recordLedger(ctx, { ...base, outcome: 'budget-exceeded', timingMs: 0, exceeded: status.exceeded });
      return { ok: false, rejected: true, reason: 'budget', exceeded: status.exceeded, mode, tool: name };
    }
    await recordDomainUsage(BUDGET_DOMAIN, { actions: 1 });
    charged = true;
  }

  const startedAt = Date.now();
  // Outside the Express request lifecycle (called by the orchestrator / CoS
  // agent) — catch so a thrown tool records an `error` ledger entry, then rethrow.
  try {
    const result = await tool.execute(parsed, ctx);
    const timingMs = Date.now() - startedAt;
    // A wrapped service that self-gates returns `{ rejected: true, ... }` instead
    // of throwing (e.g. Series Autopilot when cos autonomy is `off`, reachable
    // when creative is explicitly overridden to `execute` over an `off` cos).
    // Surface that honestly through the one chokepoint rather than reporting a
    // clean `executed` — otherwise the ledger and orchestrator record a
    // successful start for a run the inner gate refused.
    if (result && result.rejected === true) {
      console.log(`🚫 creative dispatch ${name} rejected by wrapped service (${result.mode ?? 'gate'})`);
      // The tool did no work — refund the action charged before execute so a
      // self-gated (non-selfBudgeted) tool doesn't burn budget on a no-op. Today
      // only the selfBudgeted autopilot self-rejects (never charged), so this is
      // defensive for future self-gating tools that keep the registry charge.
      if (charged) await recordDomainUsage(BUDGET_DOMAIN, { actions: -1 });
      await recordLedger(ctx, { ...base, outcome: 'rejected', timingMs });
      return { ok: false, rejected: true, reason: result.reason || 'tool-rejected', mode, tool: name, result, timingMs };
    }
    console.log(`✅ creative dispatch ${name} executed in ${timingMs}ms`);
    await recordLedger(ctx, { ...base, outcome: 'executed', timingMs });
    return { ok: true, mode, tool: name, longRunning: Boolean(tool.longRunning), result, timingMs };
  } catch (err) {
    const timingMs = Date.now() - startedAt;
    console.error(`❌ creative dispatch ${name} failed: ${err.message}`);
    await recordLedger(ctx, { ...base, outcome: 'error', timingMs, error: err.message });
    throw err;
  }
}
