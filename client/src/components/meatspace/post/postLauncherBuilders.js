import { DOMAINS, DRILL_TO_DOMAIN, isTopicEnabled, selectMemoryItemForDrill, resolveTopicForDrillType } from './constants';
import { QUICK_DURATION_TOLERANCE_SEC, deriveQuickObservedDurations, composeQuickSession } from '../../../lib/postQuickSession.js';

// Canonical domain visiting order for interleaved "Full POST" composition
// (issue #2100): alternate domains — math → cognitive → memory → verbal — so a
// session is spaced/varied rather than blocked (all math, then all cognitive).
// Domains not listed here interleave after, in first-seen order.
export const INTERLEAVE_DOMAIN_ORDER = ['math', 'cognitive', 'memory', 'verbal', 'wordplay', 'imagination'];

/**
 * Round-robin interleave drill configs by their `domain` tag: one drill from
 * each domain per round, in INTERLEAVE_DOMAIN_ORDER, until every drill is
 * placed. Preserves per-domain input order. Pure — exported for unit tests.
 */
export function interleaveByDomain(drills, order = INTERLEAVE_DOMAIN_ORDER) {
  const groups = new Map();
  for (const d of drills || []) {
    const key = d.domain || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const domainOrder = [
    ...order.filter(k => groups.has(k)),
    ...[...groups.keys()].filter(k => !order.includes(k)),
  ];
  const lengths = [...groups.values()].map(g => g.length);
  const maxLen = lengths.length ? Math.max(...lengths) : 0;
  const result = [];
  for (let round = 0; round < maxLen; round++) {
    for (const key of domainOrder) {
      const list = groups.get(key);
      if (round < list.length) result.push(list[round]);
    }
  }
  return result;
}

// Pure: sanitizes the optional conditions object before submit — drops unset
// enum fields and an empty/whitespace-only note, so a session with nothing
// filled in submits `{}` (server treats an empty object as "no conditions"),
// not a placeholder-filled record. `conditions` is passed explicitly (lifted
// from the component's `conditions` state).
export function buildCleanConditions(conditions) {
  const clean = {};
  if (conditions.sleepQuality) clean.sleepQuality = conditions.sleepQuality;
  if (conditions.caffeine) clean.caffeine = conditions.caffeine;
  if (conditions.stress) clean.stress = conditions.stress;
  if (conditions.note?.trim()) clean.note = conditions.note.trim();
  return clean;
}

const mathDrillConfig = (cfg) => ({
  steps: cfg.steps,
  count: cfg.count,
  maxDigits: cfg.maxDigits,
  subtrahend: cfg.subtrahend,
  startRange: cfg.startRange,
  bases: cfg.bases,
  maxExponent: cfg.maxExponent,
  tolerancePct: cfg.tolerancePct,
  difficulty: cfg.difficulty,
  family: cfg.family,
});

const memoryDrillConfig = (enabledMemoryItems, type, count) => ({
  count,
  memoryItemId: selectMemoryItemForDrill(enabledMemoryItems, type)?.id,
});

// Only the fields each cognitive generator reads; extras are harmless.
// stimulusMs (n-back) / showMs (digit-span) are forwarded so that manual mode
// (Progressive off) actually uses the presentation-speed values the user set
// in PostDrillConfig.jsx (issue #2095) — under the progressive ladder the
// server overrides them per rung anyway, so forwarding is safe in both modes.
const cognitiveDrillConfig = (cfg) => ({
  n: cfg.n,
  length: cfg.length,
  stimulusMs: cfg.stimulusMs,
  direction: cfg.direction,
  startLength: cfg.startLength,
  maxLength: cfg.maxLength,
  showMs: cfg.showMs,
  count: cfg.count,
  incongruentPct: cfg.incongruentPct,
  size: cfg.size,
  rotationComplexity: cfg.rotationComplexity,
  optionCount: cfg.optionCount,
  mode: cfg.mode,
  minDelayMs: cfg.minDelayMs,
  maxDelayMs: cfg.maxDelayMs,
  choices: cfg.choices,
  ruleCount: cfg.ruleCount,
  switchRatePct: cfg.switchRatePct,
  cueStimulusIntervalMs: cfg.cueStimulusIntervalMs,
  responseDeadlineMs: cfg.responseDeadlineMs,
  noGoPct: cfg.noGoPct,
  lureSimilarity: cfg.lureSimilarity,
  congruentPct: cfg.congruentPct,
  flankerDistance: cfg.flankerDistance,
  flankerStrength: cfg.flankerStrength,
});


const SOURCE_TO_MODULE = { math: 'mental-math', llm: 'llm-drills', cognitive: 'cognitive', memory: 'memory' };

export function collectLauncherDrills(config, reviewReps, memoryItemsState) {
  // Practice-topic gate (issue #3252). Applied at the SOURCE of every enabled-
  // drill list so a switched-off topic disappears from composed sessions, Quick
  // sessions, domain-focus practice, and the "Up next" actions alike — that's
  // what makes "only Wordplay" a single toggle instead of unchecking eight
  // individual LLM drill types. A drill type with no registry entry has no topic
  // and is never gated.
  const topicAllowed = (type) => isTopicEnabled(config, resolveTopicForDrillType(type)?.id);

  // Maintenance review reps are drills too, so they get the same topic gate —
  // otherwise switching Cognitive off still mixed an n-back rep into a Quick
  // session (and the launcher still advertised it below).
  const allowedReviewReps = reviewReps.filter(rep => topicAllowed(rep.type));

  // Math honors its module-level `enabled` flag like the llmDrills/cognitive
  // branches below — it used to ignore it, so a `mentalMath.enabled: false`
  // config still composed every math drill.
  const enabledMathDrills = config.mentalMath?.enabled !== false
    ? Object.entries(config.mentalMath?.drillTypes || {}).filter(([type, cfg]) => cfg.enabled && topicAllowed(type))
    : [];

  const enabledLlmDrills = config.llmDrills?.enabled !== false
    ? Object.entries(config.llmDrills?.drillTypes || {}).filter(([type, cfg]) => cfg.enabled !== false && topicAllowed(type))
    : [];

  const llmProviderId = config.llmDrills?.providerId || null;
  const llmModel = config.llmDrills?.model || null;

  // Deterministic cognitive drills (n-back / digit-span / stroop). No provider.
  const enabledCognitiveDrills = config.cognitive?.enabled !== false
    ? Object.entries(config.cognitive?.drillTypes || {}).filter(([type, cfg]) => cfg.enabled !== false && topicAllowed(type))
    : [];

  const enabledMemoryItems = memoryItemsState.status === 'ready'
    ? memoryItemsState.items.filter(item => config.memory?.items?.[item.id]?.enabled !== false)
    : [];
  const enabledMemoryDrills = config.memory?.enabled !== false && enabledMemoryItems.length > 0
    ? DOMAINS.memory.drillTypes
      .map(type => [type, config.memory?.drillTypes?.[type]])
      .filter(([type, cfg]) => cfg && cfg.enabled !== false && topicAllowed(type)
        && selectMemoryItemForDrill(enabledMemoryItems, type))
    : [];

  // Composed sessions (Full POST / Quick) honor `sessionModules` (issue #2100):
  // a module's drills are only added when it's listed. The default
  // (mental-math + cognitive) excludes Memory and LLM drills, so both remain
  // deliberate opt-ins and wit/verbal work
  // is never auto-added to a default session — provider-cost consent stays
  // opt-in (AGENTS.md AI-provider policy). An absent list means "all
  // enabled" (back-compat). Focus-practice on a specific weak domain bypasses
  // this filter (it's an explicit user choice, not a default composition).
  // `null` = no sessionModules set (legacy/absent) → include all enabled
  // (back-compat). An explicit array — INCLUDING an empty one — is honored as-is:
  // unchecking every module in Config is a deliberate "no composed sessions"
  // choice, not the same as never having set it (issue #2100 review).
  const sessionModules = Array.isArray(config.sessionModules) ? config.sessionModules : null;
  const moduleAllowed = (source) => sessionModules === null || sessionModules.includes(SOURCE_TO_MODULE[source]);

  // Build domain → enabled drills map for quick session
  const allEnabledDrills = [
    ...enabledMathDrills.map(([type, cfg]) => ({ type, cfg, source: 'math' })),
    ...enabledLlmDrills.map(([type, cfg]) => ({ type, cfg, source: 'llm' })),
    ...enabledCognitiveDrills.map(([type, cfg]) => ({ type, cfg, source: 'cognitive' })),
    ...enabledMemoryDrills.map(([type, cfg]) => ({ type, cfg, source: 'memory' })),
  ];

  const enabledDomains = {};
  for (const { type, cfg, source } of allEnabledDrills) {
    const domain = DRILL_TO_DOMAIN[type];
    if (!domain) continue;
    if (!enabledDomains[domain]) enabledDomains[domain] = [];
    enabledDomains[domain].push({ type, cfg, source });
  }

  // Domains eligible for a COMPOSED (Full/Quick) session, after the
  // sessionModules filter — so a default Quick session never silently pulls in
  // an opt-out module's drills (issue #2100).
  const sessionEnabledDomains = {};
  for (const [domainKey, drills] of Object.entries(enabledDomains)) {
    const allowed = drills.filter(d => moduleAllowed(d.source));
    if (allowed.length) sessionEnabledDomains[domainKey] = allowed;
  }

  const hasAnyDrills = enabledMathDrills.length > 0 || enabledLlmDrills.length > 0 || enabledCognitiveDrills.length > 0 || enabledMemoryDrills.length > 0;
  // Quick-session domain count reflects the sessionModules-filtered set, so the
  // Quick button and preview match what the composer can actually run.
  const domainCount = Object.keys(sessionEnabledDomains).length;
  // A COMPOSED session (Full/Quick) only has drills to run if the
  // sessionModules-filtered set is non-empty — the buttons gate on this, not on
  // the unfiltered `hasAnyDrills`, so selecting only empty modules disables them
  // instead of failing with "No drills configured" (issue #2100 review).
  const hasSessionDrills = domainCount > 0;
  // Drills are configured/enabled but the Session Composition filter excludes
  // them all — surface why the start buttons are disabled.
  const compositionExcludesAll = hasAnyDrills && !hasSessionDrills;

  return {
    topicAllowed, allowedReviewReps, enabledMathDrills, enabledLlmDrills, enabledCognitiveDrills,
    enabledMemoryItems, enabledMemoryDrills, llmProviderId, llmModel, moduleAllowed,
    allEnabledDrills, enabledDomains, sessionEnabledDomains, hasAnyDrills, domainCount,
    hasSessionDrills, compositionExcludesAll,
  };
}

export function buildFullSessionDrills({
  moduleAllowed, enabledMathDrills, enabledLlmDrills, enabledCognitiveDrills,
  enabledMemoryDrills, enabledMemoryItems, llmProviderId, llmModel,
}) {
  const mathConfigs = (moduleAllowed('math') ? enabledMathDrills : []).map(([type, cfg]) => ({
    type,
    domain: DRILL_TO_DOMAIN[type],
    config: mathDrillConfig(cfg),
    timeLimitSec: cfg.timeLimitSec || 120
  }));

  const llmConfigs = (moduleAllowed('llm') ? enabledLlmDrills : []).map(([type, cfg]) => ({
    type,
    domain: DRILL_TO_DOMAIN[type],
    config: { count: cfg.count || 5 },
    timeLimitSec: cfg.timeLimitSec || 120,
    providerId: cfg.providerId || llmProviderId,
    model: cfg.model || llmModel
  }));

  const cognitiveConfigs = (moduleAllowed('cognitive') ? enabledCognitiveDrills : []).map(([type, cfg]) => ({
    type,
    domain: DRILL_TO_DOMAIN[type],
    config: cognitiveDrillConfig(cfg)
    // No timeLimitSec — cognitive drills are self-paced/stimulus-driven and
    // never enforce a countdown (see PostCognitiveDrillRunner.jsx).
  }));

  const memoryConfigs = (moduleAllowed('memory') ? enabledMemoryDrills : []).map(([type, cfg]) => ({
    type,
    domain: 'memory',
    config: memoryDrillConfig(enabledMemoryItems, type, cfg.count),
    timeLimitSec: DOMAINS.memory.timeBudgetSec,
  }));

  // Interleave across domains (math → cognitive → memory → verbal …) rather
  // than running each module blocked, so a full session spaces varied work
  // for better retention (issue #2100). Full coverage is preserved — every
  // enabled drill still runs, just reordered.
  return interleaveByDomain([...mathConfigs, ...llmConfigs, ...cognitiveConfigs, ...memoryConfigs]);
}

export function buildLauncherQuickPlan({
  sessionEnabledDomains, enabledMemoryDrills, enabledMemoryItems, allowedReviewReps,
}, { recommendations, quickDurationMin, recentSessions, recentPractice }) {
  const quickMemoryItemIds = {};
  for (const [type] of enabledMemoryDrills) {
    quickMemoryItemIds[type] = memoryDrillConfig(enabledMemoryItems, type, 3).memoryItemId;
  }
  return composeQuickSession({
    domainEntries: Object.entries(sessionEnabledDomains).map(([domain, drills]) => ({ domain, drills })),
    recommendation: recommendations[0] || null,
    reviewReps: allowedReviewReps.map(rep => ({ ...rep, domain: DRILL_TO_DOMAIN[rep.type] })),
    durationMinutes: quickDurationMin,
    toleranceSec: QUICK_DURATION_TOLERANCE_SEC,
    observedDurations: deriveQuickObservedDurations(recentSessions),
    memoryItemIds: quickMemoryItemIds,
    recentPractice,
  });
}

export function buildQuickSessionDrills(quickPlan, { llmProviderId, llmModel }) {
  return quickPlan.selected.map(candidate => {
    const domain = candidate.domain || DRILL_TO_DOMAIN[candidate.type];
    if (candidate.kind === 'review') {
      return {
        type: candidate.type,
        domain,
        config: candidate.config,
        timeLimitSec: DOMAINS[domain]?.timeBudgetSec,
        isReview: true,
        reviewLabel: candidate.reviewLabel,
        ...(candidate.providerId && { providerId: candidate.providerId }),
        ...(candidate.model && { model: candidate.model }),
      };
    }
    const drillConfig = {
      type: candidate.type,
      domain,
      config: candidate.quickConfig,
      timeLimitSec: DOMAINS[domain]?.timeBudgetSec,
    };
    if (candidate.source === 'llm') {
      drillConfig.providerId = candidate.cfg?.providerId || llmProviderId;
      drillConfig.model = candidate.cfg?.model || llmModel;
    }
    return drillConfig;
  });
}

// Build a full-length (non-abbreviated) drill config for a single enabled
// drill, shared by domain-focus and single-drill starts. `domainKey` overrides
// the drill's own domain only for consistency with the caller's grouping.
export function buildFocusDrillConfig({ type, cfg, source }, { enabledMemoryItems, llmProviderId, llmModel }, domainKey = DRILL_TO_DOMAIN[type]) {
  const domain = DOMAINS[domainKey];
  let focusConfig;
  if (source === 'math') {
    focusConfig = mathDrillConfig(cfg);
  } else if (source === 'cognitive') {
    focusConfig = cognitiveDrillConfig(cfg);
  } else {
    focusConfig = source === 'memory'
      ? memoryDrillConfig(enabledMemoryItems, type, cfg.count || 5)
      : { count: cfg.count || 5 };
  }
  const drillConfig = {
    type,
    domain: domainKey,
    config: focusConfig,
    timeLimitSec: cfg.timeLimitSec || domain?.timeBudgetSec || 120,
  };
  if (source === 'llm') {
    drillConfig.providerId = cfg.providerId || llmProviderId;
    drillConfig.model = cfg.model || llmModel;
  }
  return drillConfig;
}
