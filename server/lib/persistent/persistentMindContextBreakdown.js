/**
 * Per-category context-window breakdown for the next Persistent Mind wake.
 *
 * Pure per-category token breakdown of the next wake's context (identity, instructions, memories, rollups, tool schemas, output reserve, free headroom) with occupancy and window provenance. No I/O.
 *
 * Inputs are aggregate counts only (section character counts from
 * `assemblePersistentMindContext`, tool-family schema characters, the resolved
 * window, the latest turn receipt's usage). No prompt text or memory body ever
 * enters the payload. Unknown stays `null`, never `0`: an unknown window has
 * no percent, and a call that reported no cache telemetry has `promptCache: null`.
 */
import { CHARS_PER_TOKEN, localOutputReserveTokens } from '../contextBudget.js';
import { PERSISTENT_MIND_OUTPUT_RESERVE_TOKENS } from './persistentMindPromptBudget.js';

export const CONTEXT_BREAKDOWN_OCCUPANCY_SOURCES = Object.freeze(['provider_usage', 'provider_usage_plus_estimate', 'local_estimate']);
export const CONTEXT_BREAKDOWN_WINDOW_SOURCES = Object.freeze(['pinned', 'advertised', 'fallback', 'unknown']);

/** Occupancy above this share of the window earns the panel's non-blocking notice. */
export const CONTEXT_BREAKDOWN_HIGH_OCCUPANCY_PERCENT = 85;

const tokensForChars = (chars) => Math.ceil((Number.isFinite(chars) && chars > 0 ? chars : 0) / CHARS_PER_TOKEN);
const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : null);
const reported = (value) => (Number.isFinite(value) && value >= 0 ? value : null);

/**
 * Classify where the window came from. A manual pin always reads `pinned`
 * (and surfaces the advertised window when it differs); otherwise a window the
 * provider/catalog declared is `advertised`, a resolved-but-undeclared one is
 * `fallback`, and no window at all is `unknown`.
 */
export function resolvePersistentMindWindowProvenance({ provider = null, model = null, effectiveWindow = null } = {}) {
  const pin = positive(model ? provider?.modelNumCtx?.[model] : null) ?? positive(provider?.numCtx);
  const advertisedWindow = positive(provider?.contextWindow)
    ?? positive(model ? provider?.modelContextWindows?.[model] : null);
  const effective = positive(effectiveWindow);
  if (pin) {
    return {
      windowSource: 'pinned',
      contextMax: effective ?? pin,
      pinnedWindow: pin,
      advertisedWindow,
      pinDisagreesWithAdvertised: advertisedWindow !== null && advertisedWindow !== pin,
    };
  }
  if (advertisedWindow) {
    return { windowSource: 'advertised', contextMax: effective ?? advertisedWindow, pinnedWindow: null, advertisedWindow, pinDisagreesWithAdvertised: false };
  }
  return {
    windowSource: effective ? 'fallback' : 'unknown',
    contextMax: effective,
    pinnedWindow: null,
    advertisedWindow: null,
    pinDisagreesWithAdvertised: false,
  };
}

/**
 * Cache telemetry from the latest call, or `null` when the call reported none
 * (an absent field is not a zero hit rate).
 */
function promptCacheFrom(usage) {
  const cacheReadTokens = reported(usage?.cacheReadTokens);
  const cacheWriteTokens = reported(usage?.cacheWriteTokens);
  if (cacheReadTokens === null && cacheWriteTokens === null) return null;
  const input = reported(usage?.inputTokens);
  const denominator = input !== null && cacheReadTokens !== null ? input + cacheReadTokens : null;
  return {
    cacheReadTokens,
    cacheWriteTokens,
    hitRatio: denominator && denominator > 0 ? cacheReadTokens / denominator : null,
  };
}

/**
 * @param {object} args
 * @param {object} [args.preview] - `assemblePersistentMindContext` result (needs `sectionChars`).
 * @param {{totalChars:number, overheadChars:number, families:{family:string, tools:number, chars:number}[]}|null} [args.toolCost]
 * @param {object} [args.window] - `resolvePersistentMindWindowProvenance` result.
 * @param {{purpose?:string, usage?:object}|null} [args.lastCall] - latest completed turn receipt.
 */
export function buildPersistentMindContextBreakdown({ preview = null, toolCost = null, window = {}, lastCall = null } = {}) {
  const chars = preview?.sectionChars || null;
  const contextMax = positive(window.contextMax);
  const windowSource = CONTEXT_BREAKDOWN_WINDOW_SOURCES.includes(window.windowSource) ? window.windowSource : 'unknown';
  const entry = (id, label, tokens, detail) => ({ id, label, tokens, ...(detail?.length ? { detail } : {}) });

  const categories = [];
  if (chars) {
    categories.push(entry('identity', 'Identity', tokensForChars(chars.identity)));
    categories.push(entry('instructions', 'Instructions & playbook', tokensForChars(chars.instructions)));
    if (chars.continuationNote > 0) categories.push(entry('continuation_note', 'Continuation note', tokensForChars(chars.continuationNote)));
    const memoryDetail = [
      ['protected', 'Protected', chars.memoriesProtected],
      ['recalled', 'Recalled for this message', chars.memoriesRecalled],
      ['standard', 'Standard', chars.memoriesOrdinary],
      ['reflection', 'Memory reflection', chars.reflection],
    ].filter(([, , value]) => value > 0).map(([id, label, value]) => ({ id, label, tokens: tokensForChars(value) }));
    categories.push(entry('memories', 'Memories', tokensForChars(chars.memories + (chars.reflection || 0)), memoryDetail));
    categories.push(entry('journal_digest', 'Decision journal digest', tokensForChars(chars.journalDigest)));
    const hasHistory = !['empty', 'not-needed'].includes(preview.summaryState);
    if (hasHistory) categories.push(entry('rollups', 'Sealed rollups', tokensForChars(chars.rollups)));
    // Always reported, even at 0, so empty history reads as measured-empty.
    categories.push(entry('recent_trajectory', 'Recent trajectory', tokensForChars(chars.recentTrajectory)));
  }
  if (toolCost) {
    const toolDetail = toolCost.families
      .map((family) => ({ id: family.family, label: family.family, tokens: tokensForChars(family.chars), tools: family.tools }))
      .concat(toolCost.overheadChars > 0
        ? [{ id: 'overhead', label: 'Catalog framing & discoverable index', tokens: tokensForChars(toolCost.overheadChars) }]
        : []);
    categories.push(entry('tool_definitions', 'Tool definitions', tokensForChars(toolCost.totalChars), toolDetail));
  }

  const estimatedPrompt = categories.reduce((sum, category) => sum + category.tokens, 0);

  // A measured input-token count from the latest completed turn calibrates the
  // estimate; it describes the previous wake's prompt, so the result is still an
  // estimate of the next one (`provider_usage_plus_estimate`). With nothing to
  // estimate from, the measured figure alone is the occupancy (`provider_usage`).
  const measuredInput = lastCall?.purpose === 'turn' ? reported(lastCall?.usage?.inputTokens) : null;
  let occupancySource = 'local_estimate';
  let contextUsed = estimatedPrompt;
  if (measuredInput !== null && measuredInput > 0) {
    if (estimatedPrompt > 0) {
      const scale = measuredInput / estimatedPrompt;
      for (const category of categories) {
        category.tokens = Math.round(category.tokens * scale);
        for (const part of category.detail || []) part.tokens = Math.round(part.tokens * scale);
      }
      occupancySource = 'provider_usage_plus_estimate';
    } else {
      occupancySource = 'provider_usage';
    }
    contextUsed = measuredInput;
  }

  const outputReserve = positive(localOutputReserveTokens(PERSISTENT_MIND_OUTPUT_RESERVE_TOKENS, contextMax))
    ?? PERSISTENT_MIND_OUTPUT_RESERVE_TOKENS;
  categories.push(entry('output_reserve', 'Output reserve', outputReserve));
  // Unknown window has no headroom figure rather than an invented one.
  const free = contextMax === null ? null : Math.max(0, contextMax - contextUsed - outputReserve);
  if (free !== null) categories.push(entry('free', 'Free headroom', free));

  const percentOf = (tokens) => (contextMax ? Math.round((tokens / contextMax) * 1000) / 10 : null);
  const withPercent = categories.map((category) => ({ ...category, percent: percentOf(category.tokens) }));
  const contextPercent = percentOf(contextUsed + outputReserve);

  return {
    categories: withPercent,
    contextUsed,
    contextMax,
    contextPercent,
    overBudget: contextMax !== null && contextUsed + outputReserve > contextMax,
    highOccupancy: contextPercent !== null && contextPercent > CONTEXT_BREAKDOWN_HIGH_OCCUPANCY_PERCENT,
    occupancySource,
    windowSource,
    pinnedWindow: window.pinnedWindow ?? null,
    advertisedWindow: window.advertisedWindow ?? null,
    pinDisagreesWithAdvertised: window.pinDisagreesWithAdvertised === true,
    promptCache: promptCacheFrom(lastCall?.usage),
  };
}
