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
 * This module is intentionally PURE — it imports nothing with side effects
 * (only `zod`). LLM-kind checks receive their model caller through
 * `ctx.callStagedLLM`, injected by `server/services/pipeline/editorial/checkRunner.js`,
 * so the registry stays side-effect-free and unit-testable in isolation.
 *
 * A finding returned by `run(ctx)` is a partial `manuscriptReview` comment:
 *   { severity?, category?, location?, problem (required), suggestion?,
 *     anchorQuote?, issueNumber? }
 * The runner stamps each finding's `checkId` (and `sourceRunId`) before seeding
 * the review, so checks never set those themselves.
 */

import { z } from 'zod';

export const CHECK_SCOPES = Object.freeze(['series', 'issue', 'scene', 'noun']);
export const CHECK_KINDS = Object.freeze(['deterministic', 'llm']);
const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

// Stage name for the info-dumping LLM check. The prompt ships in
// data.reference/prompts/stages/ and its config in stage-config.json; both
// propagate to existing installs via setup-data.js (missing-file copy +
// JSON_MERGE_TARGETS stage merge), so no migration is needed for a NEW stage.
export const INFO_DUMPING_STAGE = 'pipeline-editorial-info-dumping';

// ---------------------------------------------------------------------------
// Deterministic helpers for the character-name dissimilarity check.
// ---------------------------------------------------------------------------

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const vowelSkeleton = (s) => letters(s).replace(/[^aeiou]/g, '');

// The similarity signals two character names can share. Two names that trip
// enough of these are easy for a reader to confuse on the page.
function nameSimilaritySignals(a, b) {
  const la = letters(a);
  const lb = letters(b);
  if (!la || !lb) return [];
  const signals = [];
  if (la[0] === lb[0]) signals.push('same first letter');
  if (la.length === lb.length) signals.push('same length');
  if (vowelSkeleton(a) && vowelSkeleton(a) === vowelSkeleton(b)) signals.push('same vowel pattern');
  if (la.length >= 3 && lb.length >= 3 && la.slice(0, 3) === lb.slice(0, 3)) signals.push('same opening');
  if (la.endsWith(lb.slice(-2)) && la.slice(-2) === lb.slice(-2)) signals.push('same ending');
  return signals;
}

// ---------------------------------------------------------------------------
// Registry entries.
// ---------------------------------------------------------------------------

export const EDITORIAL_CHECKS = [
  {
    id: 'naming.dissimilar-names',
    label: 'Character name dissimilarity',
    description:
      'Flags pairs of character names a reader could confuse — sharing a first letter, length, vowel pattern, opening, or ending.',
    scope: 'series',
    kind: 'deterministic',
    category: 'naming',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({
      // How many similarity signals two names must share before they're flagged.
      minSharedSignals: z.number().int().min(1).max(5).default(2),
    }),
    run: (ctx) => {
      const min = ctx.config?.minSharedSignals ?? 2;
      const names = (ctx.canon?.characters || [])
        .map((c) => (typeof c?.name === 'string' ? c.name.trim() : ''))
        .filter(Boolean);
      const findings = [];
      for (let i = 0; i < names.length; i += 1) {
        for (let j = i + 1; j < names.length; j += 1) {
          if (names[i].toLowerCase() === names[j].toLowerCase()) continue;
          const signals = nameSimilaritySignals(names[i], names[j]);
          if (signals.length < min) continue;
          findings.push({
            severity: ctx.severityDefault,
            category: 'naming',
            location: `Characters: ${names[i]} / ${names[j]}`,
            problem: `Character names "${names[i]}" and "${names[j]}" are easy to confuse (${signals.join(', ')}).`,
            suggestion: 'Rename one of these characters so readers can tell them apart at a glance.',
            anchorQuote: names[i],
            issueNumber: null,
          });
        }
      }
      return findings;
    },
  },
  {
    id: 'prose.info-dumping',
    label: 'Info-dumping / "as you know, Bob" exposition',
    description:
      'Flags passages that dump backstory or world rules through unnatural exposition — characters telling each other what they both already know.',
    scope: 'issue',
    kind: 'llm',
    category: 'exposition',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
    }),
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: async (ctx) => {
      const { content } = await ctx.callStagedLLM(
        INFO_DUMPING_STAGE,
        { manuscript: ctx.manuscript },
        { returnsJson: true, source: INFO_DUMPING_STAGE },
      );
      const raw = Array.isArray(content?.findings) ? content.findings : [];
      const max = ctx.config?.maxFindings ?? 12;
      return raw.slice(0, max).map((f) => ({
        severity: SEVERITIES.includes(f?.severity) ? f.severity : ctx.severityDefault,
        category: 'exposition',
        location: typeof f?.location === 'string' ? f.location : '',
        problem: typeof f?.problem === 'string' ? f.problem : '',
        suggestion: typeof f?.suggestion === 'string' ? f.suggestion : '',
        anchorQuote: typeof f?.anchorQuote === 'string' ? f.anchorQuote : '',
        issueNumber: Number.isInteger(f?.issueNumber) ? f.issueNumber : null,
      })).filter((f) => f.problem);
    },
  },
];

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
    if (!CHECK_SCOPES.includes(check.scope)) {
      throw new Error(`checkRegistry: invalid scope "${check.scope}" for ${check.id} (must be one of ${CHECK_SCOPES.join(', ')})`);
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
// is absent or invalid, so a hand-edited settings.json can't make a check throw.
export function resolveCheckConfig(check, storedConfig) {
  const parsed = check.configSchema.safeParse(storedConfig || {});
  if (parsed.success) return parsed.data;
  // Re-parse an empty object to materialize the schema defaults.
  const defaults = check.configSchema.safeParse({});
  return defaults.success ? defaults.data : {};
}

const readChecksSlice = (settings) => {
  const slice = settings?.pipelineEditorialChecks?.checks;
  return slice && typeof slice === 'object' && !Array.isArray(slice) ? slice : {};
};

/**
 * Merge the static registry with persisted per-check state from settings.
 * Returns one row per registered check:
 *   { id, label, description, scope, kind, category, severityDefault,
 *     enabled, config }
 * `enabled` falls back to the check's `defaultEnabled`; `config` is validated
 * through the check's schema (with defaults).
 */
export function resolveCheckState(settings) {
  const stored = readChecksSlice(settings);
  return EDITORIAL_CHECKS.map((check) => {
    const row = stored[check.id] || {};
    const enabled = typeof row.enabled === 'boolean' ? row.enabled : check.defaultEnabled !== false;
    return {
      id: check.id,
      label: check.label,
      description: check.description,
      scope: check.scope,
      kind: check.kind,
      category: check.category,
      severityDefault: check.severityDefault,
      enabled,
      config: resolveCheckConfig(check, row.config),
    };
  });
}

/**
 * The checks that should actually run for a given settings + optional subset.
 * Returns `{ check, config }` pairs (the live registry entry + its resolved
 * config) for every enabled check, narrowed to `subsetIds` when provided.
 */
export function getEnabledChecks(settings, subsetIds = null) {
  const subset = Array.isArray(subsetIds) && subsetIds.length ? new Set(subsetIds) : null;
  return resolveCheckState(settings)
    .filter((row) => row.enabled && (!subset || subset.has(row.id)))
    .map((row) => ({ check: getCheck(row.id), config: row.config }))
    .filter((x) => x.check);
}
