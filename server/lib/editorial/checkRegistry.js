/**
 * Editorial Check Registry (#1284) — the backbone of the extensible
 * editorial-review system (epic #1283).
 *
 * Mirrors `server/lib/navManifest.js` and `server/lib/apiRegistry.js`: a static
 * array of declarative entries with fail-fast guards at module load so a
 * malformed check blocks boot instead of silently breaking the runner. Each
 * entry declares its scope, kind, default severity, a Zod `configSchema`, an
 * optional `gate`, and a `run(ctx)` that returns findings shaped for the
 * existing `manuscriptReview` comment store.
 *
 * This module is intentionally PURE — it pulls in only `./checkInfra.js` (which
 * itself imports nothing with side effects beyond `zod` and the pure
 * `estimateTokens` budgeter) and the per-category check definitions in
 * `./checks/*.js`. LLM-kind checks receive
 * their model caller through `ctx.callStagedLLM`, and a manuscript-consuming LLM
 * check plans the manuscript into provider-sized chunks through
 * `ctx.planManuscriptChunks` — both injected by
 * `server/services/pipeline/editorial/checkRunner.js`, so the registry stays
 * side-effect-free and unit-testable in isolation.
 *
 * A finding returned by `run(ctx)` is a partial `manuscriptReview` comment:
 *   { severity?, category?, location?, problem (required), suggestion?,
 *     anchorQuote?, issueNumber? }
 * The runner stamps each finding's `checkId` (and `sourceRunId`) before seeding
 * the review, so checks never set those themselves.
 */


// #1829: the 7,474-line god file was decomposed. Shared infra now lives in
// ./checkInfra.js and the 68 check definitions in ./checks/*.js. This module
// stays the public entry point: it re-exports the infra, assembles
// EDITORIAL_CHECKS from the check groups, and keeps the registry lookup/state
// helpers that need the assembled array.
// Re-export ONLY the infra names the original checkRegistry exposed (preserves
// the public API exactly). Promoted-private helpers used by ./checks/*.js stay
// internal to ./checkInfra.js and are imported from there directly.
export {
  ADVERSARIAL_CUTS_STAGE,
  APPEARANCE_CONTINUITY_STAGE,
  ARC_REGRESSION_STAGE,
  ARC_TRANSITIONS_STAGE,
  CHARACTER_CONSISTENCY_STAGE,
  CHECK_FIELD_TYPES,
  CHECK_KINDS,
  CHECK_SCOPES,
  CHECK_SEVERITIES,
  CHEKHOV_STAGE,
  CLIMAX_AGENCY_STAGE,
  COMIC_PAGE_TURN_STAGE,
  COMIC_PROSE_SYNC_STAGE,
  CUSTOM_CHECK_MAX_FINDINGS_DEFAULT,
  CUSTOM_CHECK_RUN_SOURCE,
  CUT_TYPES,
  DEAD_METAPHOR_STAGE,
  DIALOGUE_PLEASANTRIES_STAGE,
  EDITORIAL_PRIOR_DIGEST_BODY_CHARS,
  EDITORIAL_PRIOR_DIGEST_CHARS,
  EDITORIAL_PRIOR_DIGEST_MAX,
  EDITORIAL_PROMPT_OVERHEAD_TOKENS,
  EDITORIAL_SETUP_DIGEST_BODY_CHARS,
  EDITORIAL_SETUP_DIGEST_CHARS,
  EDITORIAL_SETUP_DIGEST_SOURCE,
  EDITORIAL_SOURCES,
  ENDINGS_CLIFFHANGER_STAGE,
  EYELINE_MATCH_STAGE,
  FACT_ACCURACY_STAGE,
  HEAD_HOPPING_STAGE,
  INFO_DUMPING_STAGE,
  INTERIORITY_BALANCE_STAGE,
  INTERIORITY_STAGE,
  KILL_YOUR_DARLINGS_STAGE,
  MIRROR_DESCRIPTION_STAGE,
  OBJECT_BACKSTORY_STAGE,
  OBJECT_MOTIVATION_STAGE,
  OBJECT_WEIGHT_STAGE,
  ON_THE_NOSE_STAGE,
  ON_THE_NOSE_SUBTYPES,
  OPENING_START_STAGE,
  PACING_ESCALATION_STAGE,
  PLOT_STRUCTURE_STAGE,
  PROSE_SYNC_PROSE_CHAR_CAP,
  REACTION_PROPORTIONALITY_STAGE,
  SAFE_CUT_TYPES,
  SECONDARY_ARC_STAGE,
  SENSORY_BALANCE_STAGE,
  STYLE_CONFORMANCE_STAGE,
  TELLING_EMOTION_STAGE,
  THEME_COHERENCE_STAGE,
  TIMELINE_CONTRADICTION_STAGE,
  UNMODELED_NAMES_STAGE,
  VOICE_CONSISTENCY_STAGE,
  VOICE_DISTINCTIVENESS_STAGE,
  WHITE_ROOM_STAGE,
  WORLD_COST_FREE_POWER_STAGE,
  WORLD_UNFORESHADOWED_SOLUTION_STAGE,
  authoredCliffhangerSummary,
  authoredPayoffsSummary,
  authoredSetupPayoffSummary,
  buildCustomCheckPrompt,
  buildSetupDigestPrompt,
  canonCharacterStatesSummary,
  canonCharacterTraitsSummary,
  canonRosterNamesSummary,
  canonWorldSummary,
  characterVoiceProfiles,
  comicIssuePages,
  comicLetteringIssues,
  conflictIntensityTally,
  continuityLedgerSummary,
  declaredThemesSummary,
  editorialFindingKey,
  editorialPriorFindingsDigest,
  editorialSetupDigest,
  intendedVoiceSummary,
  normalizeCheckScopes,
  plotlineCoverageSummary,
  primaryCheckScope,
  proseStageIssues,
  proseSyncPairs,
  renderComicForProseSync,
  sceneGroundingSummary,
  scenePovSummary,
  secondaryCharacterPresenceSummary,
} from './checkInfra.js';

import {
  CHECK_FIELD_TYPES,
  CHECK_KINDS,
  CHECK_SCOPES,
  CHECK_SEVERITIES,
  CUSTOM_CHECK_MAX_FINDINGS_DEFAULT,
  EDITORIAL_SOURCES,
  SEVERITIES,
  normalizeCheckScopes,
  runManuscriptLlmCheckInline,
  z,
} from './checkInfra.js';

import { namingChecks } from './checks/naming.js';
import { castChecks } from './checks/cast.js';
import { comicChecks } from './checks/comic.js';
import { sceneChecks } from './checks/scene.js';
import { visualChecks } from './checks/visual.js';
import { povChecks } from './checks/pov.js';
import { continuityChecks } from './checks/continuity.js';
import { researchChecks } from './checks/research.js';
import { characterArcChecks } from './checks/characterArc.js';
import { proseStyleChecks } from './checks/proseStyle.js';
import { dialogueChecks } from './checks/dialogue.js';
import { slopChecks } from './checks/slop.js';
import { worldChecks } from './checks/world.js';

// Canonical display + run order of the built-in checks. Grouping the checks into
// ./checks/*.js by category (#1829) would otherwise change the observable order
// (settings list, progress events, run sequencing), so the assembled array is
// sorted back to this sequence — the exact order the single-file registry shipped.
// A built-in check missing a slot here fails fast at load, forcing an explicit
// position rather than silently appending.
const CHECK_ORDER = Object.freeze([
  'naming.dissimilar-names',
  'roster.economy',
  'roster.unmodeled-names',
  'comic.lettering-density',
  'comic.balloon-attribution',
  'comic.prose-sync',
  'cast.representation-balance',
  'scene.component-balance',
  'visual.shot-continuity',
  'visual.eyeline-match',
  'visual.appearance-continuity',
  'sensory.balance',
  'scene.white-room',
  'scene.interiority-balance',
  'pov.justified',
  'pov.economy',
  'pov.head-hopping',
  'continuity.timeline-contradiction',
  'research.fact-accuracy',
  'character.consistency',
  'character.secondary-arc',
  'arc.transitions',
  'arc.regression',
  'plot.structure-momentum',
  'world.unforeshadowed-solution',
  'world.cost-free-power',
  'pacing.escalation-curve',
  'theme.coherence',
  'arc.climax-agency',
  'emotion.reaction-proportionality',
  'relationships.reciprocity',
  'relationships.dangling-target',
  'relationships.opposition-reversal',
  'arc.ticking-clock-hygiene',
  'objects.unattached-significant',
  'objects.unmotivated-interaction',
  'objects.backstory-consistency',
  'objects.weight-proportionality',
  'prose.info-dumping',
  'interiority.protagonist',
  'style.reading-level',
  'style.conformance',
  'chekhov.setups-payoffs',
  'continuity.premature-reveal',
  'prose.cliches',
  'prose.modifier-stacking',
  'prose.filter-words',
  'prose.hedge-words',
  'prose.crutch-words',
  'prose.adverbs',
  'prose.passive-voice',
  'prose.repeated-gestures',
  'prose.word-echoes',
  'prose.sentence-rhythm',
  'prose.slop-banned-words',
  'prose.ai-tells',
  'prose.structural-tics',
  'prose.burstiness',
  'prose.telling-emotion',
  'prose.dead-metaphor',
  'opening.wrong-start',
  'prose.mirror-description',
  'dialogue.pleasantries',
  'dialogue.said-bookisms',
  'dialogue.attribution-clarity',
  'dialogue.tag-variety',
  'dialogue.on-the-nose',
  'dialogue.voice-distinctiveness',
  'style.voice-consistency',
  'style.voice-drift',
  'prose.kill-your-darlings',
  'prose.adversarial-cuts',
  'prose.italic-thoughts',
  'endings.cliffhanger',
  'endings.pov-switch',
  'comic.panel-rhythm',
  'comic.page-turn-beats',
]);
const CHECK_ORDER_INDEX = new Map(CHECK_ORDER.map((id, i) => [id, i]));

const ASSEMBLED_CHECKS = [
  ...namingChecks,
  ...castChecks,
  ...comicChecks,
  ...sceneChecks,
  ...visualChecks,
  ...povChecks,
  ...continuityChecks,
  ...researchChecks,
  ...characterArcChecks,
  ...worldChecks,
  ...proseStyleChecks,
  ...dialogueChecks,
  ...slopChecks,
];
for (const c of ASSEMBLED_CHECKS) {
  if (!CHECK_ORDER_INDEX.has(c.id)) {
    throw new Error(`checkRegistry: built-in check "${c.id}" has no slot in CHECK_ORDER — add one to fix its display/run position.`);
  }
}

// The built-in editorial checks, assembled from the per-category groups and
// ordered by CHECK_ORDER so the decomposition is order-preserving.
export const EDITORIAL_CHECKS = ASSEMBLED_CHECKS
  .slice()
  .sort((a, b) => CHECK_ORDER_INDEX.get(a.id) - CHECK_ORDER_INDEX.get(b.id));


// ---------------------------------------------------------------------------
// Fail-fast guards (mirror navManifest.js). Runs at module load on the real
// registry so a bad entry blocks server boot instead of silently breaking the
// runner; exported so the invariant tests can exercise the throw paths the
// valid built-in array can't reach.
// ---------------------------------------------------------------------------

export function assertValidChecks(checks) {
  const seen = new Set();
  for (const check of checks) {
    if (!check.id || !check.label || !check.scope || !check.kind || !check.category) {
      throw new Error(`checkRegistry: malformed entry ${JSON.stringify(check)}`);
    }
    // `scope` may be a single scope string OR a non-empty array of scopes (#1628).
    // Validate the RAW form strictly (every member known, array non-empty, no
    // duplicates) rather than leaning on normalizeCheckScopes's silent drop, so a
    // typo'd or empty scope fails boot instead of quietly losing a granularity.
    const rawScopes = Array.isArray(check.scope) ? check.scope : [check.scope];
    if (rawScopes.length === 0 || rawScopes.some((s) => !CHECK_SCOPES.includes(s))) {
      throw new Error(`checkRegistry: invalid scope ${JSON.stringify(check.scope)} for ${check.id} (must be one of ${CHECK_SCOPES.join(', ')}, or a non-empty array of them)`);
    }
    if (new Set(rawScopes).size !== rawScopes.length) {
      throw new Error(`checkRegistry: ${check.id} has duplicate scopes in ${JSON.stringify(check.scope)}`);
    }
    if (!CHECK_KINDS.includes(check.kind)) {
      throw new Error(`checkRegistry: invalid kind "${check.kind}" for ${check.id} (must be one of ${CHECK_KINDS.join(', ')})`);
    }
    if (!SEVERITIES.includes(check.severityDefault)) {
      throw new Error(`checkRegistry: invalid severityDefault "${check.severityDefault}" for ${check.id}`);
    }
    if (typeof check.run !== 'function') {
      throw new Error(`checkRegistry: ${check.id} is missing a run() function`);
    }
    if (!check.configSchema || typeof check.configSchema.safeParse !== 'function') {
      throw new Error(`checkRegistry: ${check.id} is missing a Zod configSchema`);
    }
    // `sources` declares the inputs the check reads so the runner can fingerprint
    // exactly those for staleness (#1387). Required + non-empty + known tokens.
    // A 'manuscript' source implies `needsManuscript` (the runner gates the
    // corpus-collection I/O on that flag) — keeping the two consistent prevents a
    // check that fingerprints the manuscript but never triggers its collection.
    if (!Array.isArray(check.sources) || check.sources.length === 0) {
      throw new Error(`checkRegistry: ${check.id} must declare a non-empty sources array (one of ${EDITORIAL_SOURCES.join(', ')})`);
    }
    for (const source of check.sources) {
      if (!EDITORIAL_SOURCES.includes(source)) {
        throw new Error(`checkRegistry: ${check.id} declares unknown source "${source}" (must be one of ${EDITORIAL_SOURCES.join(', ')})`);
      }
    }
    if (check.sources.includes('manuscript') && !check.needsManuscript) {
      throw new Error(`checkRegistry: ${check.id} reads the 'manuscript' source but is not marked needsManuscript`);
    }
    // configFields is optional, but when present each entry must be a renderable
    // descriptor (key + label + known type) so the UI never has to guess a
    // field's control. The Zod configSchema remains the validation authority —
    // configFields only drives the form, so we don't cross-check key coverage.
    if (check.configFields !== undefined) {
      if (!Array.isArray(check.configFields)) {
        throw new Error(`checkRegistry: ${check.id} configFields must be an array`);
      }
      for (const field of check.configFields) {
        if (!field || !field.key || !field.label || !CHECK_FIELD_TYPES.includes(field.type)) {
          throw new Error(`checkRegistry: ${check.id} has a malformed configField ${JSON.stringify(field)} (need key, label, type ∈ ${CHECK_FIELD_TYPES.join('/')})`);
        }
      }
    }
    // `dependsOn` (#1627) is optional: an array of OTHER check ids whose findings
    // this check reads from `ctx.priorFindings`. The runner topologically orders the
    // pass so a declared dependency runs first; a check sees ONLY the findings of
    // the checks it lists here (everything else stays order-independent). Shape is
    // validated at load; the *referenced* ids are NOT — a dependency on a disabled,
    // unknown, or not-yet-loaded (custom) check is tolerated at run time (the
    // dependent just runs without those findings). A self-reference is meaningless.
    if (check.dependsOn !== undefined) {
      if (!Array.isArray(check.dependsOn) || check.dependsOn.some((d) => typeof d !== 'string' || !d)) {
        throw new Error(`checkRegistry: ${check.id} dependsOn must be an array of check-id strings`);
      }
      if (check.dependsOn.includes(check.id)) {
        throw new Error(`checkRegistry: ${check.id} cannot depend on itself`);
      }
    }
    if (seen.has(check.id)) throw new Error(`checkRegistry: duplicate id ${check.id}`);
    seen.add(check.id);
  }
}

assertValidChecks(EDITORIAL_CHECKS);

// ---------------------------------------------------------------------------
// Lookup + state resolution helpers.
// ---------------------------------------------------------------------------

const CHECK_BY_ID = new Map(EDITORIAL_CHECKS.map((c) => [c.id, c]));

export const getCheck = (id) => CHECK_BY_ID.get(id) || null;

export const listChecks = () => EDITORIAL_CHECKS.slice();

// Validate (and default-fill) a persisted per-check config blob through the
// check's Zod schema. Falls back to the schema's defaults when the stored blob
// is absent or invalid, so a hand-edited settings.json can't make a check throw
// (re-parsing `{}` materializes the schema defaults).
export function resolveCheckConfig(check, storedConfig) {
  const parsed = check.configSchema.safeParse(storedConfig ?? {});
  return parsed.success ? parsed.data : (check.configSchema.safeParse({}).data ?? {});
}

// Read the persisted per-check map from settings, tolerant of a hand-edited /
// older-peer file. Exported so the route reads the slice through the same guard.
export const readChecksSlice = (settings) => {
  const slice = settings?.pipelineEditorialChecks?.checks;
  return slice && typeof slice === 'object' && !Array.isArray(slice) ? slice : {};
};

// The editorial-health readiness gate (#1316) the autopilot loop + UI read as
// "manuscript clean". Returns the raw stored value (or null) — the caller
// resolves an unknown/absent value to the default via `resolveReadinessGate` in
// editorialScore.js (kept there so the gate vocabulary lives with the scorer).
export const readReadinessGate = (settings) => {
  const gate = settings?.pipelineEditorialChecks?.readinessGate;
  return typeof gate === 'string' && gate ? gate : null;
};

// Resolve a check's EFFECTIVE severity from its persisted per-check row: a valid
// stored `severity` override (#1596) wins, otherwise the registry default. Kept
// pure + tiny so resolveCheckState and the runner agree on the same fallback.
export const resolveCheckSeverity = (check, row) =>
  (SEVERITIES.includes(row?.severity) ? row.severity : check.severityDefault);

/**
 * Merge the static registry with persisted per-check state from settings.
 * Returns one row per registered check:
 *   { id, label, description, scope, scopes, kind, category, severityDefault,
 *     severity, enabled, config, configFields }
 * `enabled` falls back to the check's `defaultEnabled`; `config` is validated
 * through the check's schema (with defaults); `severity` is the EFFECTIVE level
 * (a valid stored override or `severityDefault`); `configFields` is the wire-safe
 * render descriptor the UI builds its config form from (empty array when the
 * check declares none).
 */
export function resolveCheckState(settings) {
  const stored = readChecksSlice(settings);
  // Built-ins + the user's synthesized custom checks (#1346) — a custom check
  // resolves identically; `isCustom` (and the authored `prompt`) mark it so the
  // UI can offer edit/delete and prefill the author form.
  return getAllChecks(settings).map((check) => {
    const row = stored[check.id] || {};
    const enabled = typeof row.enabled === 'boolean' ? row.enabled : check.defaultEnabled !== false;
    // Normalize the declared scope ONCE: `scopes` (#1628) is the full declared set
    // the catalog/plan fan a dual-scope check across; `scope` is the PRIMARY scope
    // (a string) so every single-value consumer keeps working unchanged. For a
    // single-scope check the two agree (`scope === scopes[0]`).
    const scopes = normalizeCheckScopes(check.scope);
    return {
      id: check.id,
      label: check.label,
      description: check.description,
      scope: scopes[0] || null,
      scopes,
      kind: check.kind,
      category: check.category,
      // `severityDefault` is the registry baseline (what the override resets to);
      // `severity` (#1596) is the effective level the runner stamps onto findings;
      // `severityOverride` is the raw stored override (or null when falling
      // through to the default), so the catalog can show "Default" distinctly
      // from a level pinned to the same value as the default.
      severityDefault: check.severityDefault,
      severity: resolveCheckSeverity(check, row),
      severityOverride: SEVERITIES.includes(row.severity) ? row.severity : null,
      enabled,
      config: resolveCheckConfig(check, row.config),
      configFields: Array.isArray(check.configFields) ? check.configFields : [],
      isCustom: !!check.isCustom,
      ...(check.isCustom ? { prompt: check.prompt } : {}),
    };
  });
}

/**
 * The resolved-state rows for the checks that should run: enabled, narrowed to
 * `subsetIds` when provided. Shared by `getEnabledChecks` (execution) and the
 * runner's dry-run plan (preview), so the enable/subset filter lives once.
 */
export function getEnabledCheckRows(settings, subsetIds = null) {
  const subset = Array.isArray(subsetIds) && subsetIds.length ? new Set(subsetIds) : null;
  return resolveCheckState(settings).filter((row) => row.enabled && (!subset || subset.has(row.id)));
}

/**
 * The checks that should actually run for a given settings + optional subset.
 * Returns `{ check, config, severity, severityOverride }` pairs (the live
 * registry entry, its resolved config, its EFFECTIVE severity, and the RAW
 * per-check override — null when defaulting, #1596) for every enabled check,
 * narrowed to `subsetIds` when provided. The runner uses `severity` as the
 * base (`ctx.severityDefault`) and, when `severityOverride` is set, force-stamps
 * it onto every finding so a pin is authoritative even for LLM / explicit-
 * severity checks (not just escalation-from-default ones).
 */
export function getEnabledChecks(settings, subsetIds = null) {
  // Resolve against built-ins + custom checks (getCheck only knows built-ins).
  const byId = new Map(getAllChecks(settings).map((c) => [c.id, c]));
  return getEnabledCheckRows(settings, subsetIds)
    .map((row) => ({
      check: byId.get(row.id), config: row.config, severity: row.severity, severityOverride: row.severityOverride,
    }))
    .filter((x) => x.check);
}

/**
 * Overlay a series' per-check config overrides (#1591) onto the GLOBAL
 * `{ check, config }` pairs from `getEnabledChecks`, returning new pairs with
 * the merged config. For each enabled check that carries an override, the
 * override keys win over the (already resolved + valid) global config; the
 * merged blob is re-validated through the check's own `configSchema` so a
 * malformed / out-of-range per-series value can't corrupt the run — on a failed
 * parse the global config is kept unchanged (NOT reset to schema defaults).
 *
 * Pure + side-effect-free. Returns the input array unchanged when `seriesOverrides`
 * is absent/non-object, so a series that tunes nothing pays no allocation. The
 * severity fields carried by each pair (`severity` / `severityOverride`, #1596)
 * are preserved verbatim — the per-series override layer only tunes `config`.
 *
 * @param {Array<{check: object, config: object, severity?: string, severityOverride?: string|null}>} enabled  pairs from getEnabledChecks
 * @param {Record<string, object>|null|undefined} seriesOverrides  series.editorialCheckConfig
 * @returns {Array<{check: object, config: object, severity?: string, severityOverride?: string|null}>}
 */
export function applySeriesCheckConfig(enabled, seriesOverrides) {
  if (!Array.isArray(enabled)) return [];
  if (!seriesOverrides || typeof seriesOverrides !== 'object' || Array.isArray(seriesOverrides)
    || Object.keys(seriesOverrides).length === 0) {
    return enabled;
  }
  return enabled.map((pair) => {
    const { check, config } = pair;
    const override = seriesOverrides[check.id];
    if (!override || typeof override !== 'object' || Array.isArray(override)) return pair;
    const parsed = check.configSchema.safeParse({ ...config, ...override });
    // Spread `pair` so the effective `severity` (and any future per-pair field)
    // rides through unchanged; only `config` is overlaid.
    return { ...pair, config: parsed.success ? parsed.data : config };
  });
}

/**
 * Stable topological ordering of enabled check pairs by their declared
 * `dependsOn` (#1627). A check that names another *enabled* check in `dependsOn`
 * is emitted AFTER it, so when the runner injects a dependency's findings into the
 * dependent's `ctx.priorFindings` the dependency has already run this pass. Checks
 * that declare no dependencies keep their exact registry order (stable) — so a run
 * where nothing opts in is byte-identical to before this existed.
 *
 * Robustness:
 *  - A dependency on a check ABSENT from `pairs` (disabled, or outside a targeted
 *    subset run) is ignored — the dependent still runs, just without those findings
 *    (the runner's injection is likewise degrade-tolerant).
 *  - A dependency CYCLE (or a chain that transitively waits on one) can't be
 *    ordered; rather than drop a check or spin forever, the still-unplaced members
 *    are flushed in registry order and the cycle is logged once. The runner then
 *    simply can't guarantee a cyclic dependency's findings are present — acceptable,
 *    since a cycle is a registry bug a human must fix.
 *
 * Pure + side-effect-free (aside from the one cycle warning). O(n²) over the
 * enabled set, which is tiny (≈ the registry size).
 *
 * @param {Array<{check: object}>} pairs  enabled pairs (from getEnabledChecks / applySeriesCheckConfig)
 * @returns {Array<{check: object}>} the same pairs, dependency-ordered
 */
export function orderChecksByDependencies(pairs) {
  if (!Array.isArray(pairs)) return [];
  if (pairs.length < 2) return pairs.slice();
  // Only deps actually present in this run gate ordering — an absent dep can't be
  // waited on (and would otherwise wedge the dependent forever).
  const present = new Set();
  for (const p of pairs) { const id = p?.check?.id; if (typeof id === 'string') present.add(id); }
  const waits = pairs.map((p) => {
    const id = p?.check?.id;
    const declared = Array.isArray(p?.check?.dependsOn) ? p.check.dependsOn : [];
    return new Set(declared.filter((d) => typeof d === 'string' && d !== id && present.has(d)));
  });
  // Common case — nothing in this run waits on anything → the input is already a
  // valid order. Skip the O(n²) Kahn scan and return registry order untouched.
  if (waits.every((w) => w.size === 0)) return pairs.slice();
  const used = new Array(pairs.length).fill(false);
  const emitted = new Set();
  const result = [];
  while (result.length < pairs.length) {
    // Kahn's algorithm, but always take the LOWEST registry index among the ready
    // nodes — that's what makes the sort stable (independent checks never move).
    let pick = -1;
    for (let i = 0; i < pairs.length; i += 1) {
      if (used[i]) continue;
      let ready = true;
      for (const dep of waits[i]) { if (!emitted.has(dep)) { ready = false; break; } }
      if (ready) { pick = i; break; }
    }
    if (pick === -1) {
      // No ready node ⇒ every remaining node waits on another remaining node: a
      // cycle. Flush the rest in registry order so nothing is dropped.
      const stuck = [];
      for (let i = 0; i < pairs.length; i += 1) {
        if (used[i]) continue;
        used[i] = true;
        result.push(pairs[i]);
        const id = pairs[i]?.check?.id;
        if (typeof id === 'string') stuck.push(id);
      }
      console.warn(`⚠️ editorial check dependency cycle — running in registry order: ${stuck.join(', ')}`);
      break;
    }
    used[pick] = true;
    result.push(pairs[pick]);
    const id = pairs[pick]?.check?.id;
    if (typeof id === 'string') emitted.add(id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// User-defined checks (#1346) — definition storage + synthesis.
//
// A custom check's DEFINITION lives in settings
// (`pipelineEditorialChecks.customChecks`), while its enable/config override
// reuses the SAME `checks[id]` slice the built-ins use — so the existing
// toggle/config PATCH path works unchanged. `buildCustomCheck` synthesizes a
// definition into the exact shape the registry/runner consume, so a custom check
// flows through resolveCheckState / getEnabledChecks / the runner like a built-in.
// ---------------------------------------------------------------------------

export const CUSTOM_CHECK_ID_PREFIX = 'custom.';
export const isCustomCheckId = (id) => typeof id === 'string' && id.startsWith(CUSTOM_CHECK_ID_PREFIX);

// One tunable (the per-run cap), mirroring the built-in LLM checks so the
// existing config form renders for custom checks with no special-casing.
const customCheckConfigSchema = z.object({
  maxFindings: z.number().int().min(1).max(50).default(CUSTOM_CHECK_MAX_FINDINGS_DEFAULT),
});
const CUSTOM_CHECK_CONFIG_FIELDS = Object.freeze([
  {
    key: 'maxFindings',
    label: 'Max findings per run',
    type: 'number',
    min: 1,
    max: 50,
    step: 1,
    help: 'Cap findings so a long manuscript can not flood the review.',
  },
]);

// True when a stored definition has the minimum viable shape. Defensive against
// a hand-edited settings.json or an older/newer peer — an invalid def is skipped
// (never throws), so one bad row can't break the whole catalog.
export function isValidCustomCheckDef(def) {
  return !!def
    && typeof def === 'object'
    && isCustomCheckId(def.id)
    && typeof def.label === 'string' && def.label.trim().length > 0
    && typeof def.prompt === 'string' && def.prompt.trim().length > 0
    && CHECK_SCOPES.includes(def.scope)
    && CHECK_SEVERITIES.includes(def.severityDefault);
}

// Synthesize a runnable check from a stored definition (or null when malformed).
// The result matches the built-in shape so the runner/resolver treat it the
// same; `isCustom` + `prompt` mark it for the UI. Custom checks are always
// manuscript-consuming LLM checks (the useful editorial case), gated on prose.
export function buildCustomCheck(def) {
  if (!isValidCustomCheckDef(def)) return null;
  const instructions = def.prompt;
  const category = typeof def.category === 'string' && def.category.trim() ? def.category.trim() : 'custom';
  return {
    id: def.id,
    label: def.label.trim(),
    description: typeof def.description === 'string' ? def.description.trim() : '',
    scope: def.scope,
    kind: 'llm',
    category,
    severityDefault: def.severityDefault,
    defaultEnabled: true,
    needsManuscript: true,
    // Custom checks read only the stitched manuscript (the inline prompt is fed
    // the corpus, nothing else), so their findings stale on a prose edit alone (#1387).
    sources: ['manuscript'],
    isCustom: true,
    prompt: instructions,
    configSchema: customCheckConfigSchema,
    configFields: CUSTOM_CHECK_CONFIG_FIELDS,
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: (ctx) => runManuscriptLlmCheckInline(ctx, { category, instructions }),
  };
}

// The stored custom-check definitions, tolerant of a hand-edited / older-peer
// file (returns [] when absent or not an array).
export const readCustomCheckDefs = (settings) => {
  const defs = settings?.pipelineEditorialChecks?.customChecks;
  return Array.isArray(defs) ? defs : [];
};

// Synthesized custom checks for the current settings (invalid defs skipped).
export const buildCustomChecks = (settings) =>
  readCustomCheckDefs(settings).map(buildCustomCheck).filter(Boolean);

// All checks (built-in + custom) for the current settings.
export const getAllChecks = (settings) => [...EDITORIAL_CHECKS, ...buildCustomChecks(settings)];

// Settings-aware lookup spanning built-ins + custom checks. `getCheck` only
// knows built-ins, so the route + staleness path use this to resolve a custom id.
export function getCheckById(settings, id) {
  return CHECK_BY_ID.get(id) || buildCustomChecks(settings).find((c) => c.id === id) || null;
}
