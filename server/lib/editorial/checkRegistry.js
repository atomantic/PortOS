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

// The serializable config-field types a check can declare for its UI form.
// `configSchema` (a Zod schema) stays the validation authority on the server;
// `configFields` is the wire-safe *render* descriptor the Editorial Checks UI
// reads to build the per-check config form (the Zod schema can't cross the wire).
// Keep this in lockstep with the controls EditorialCheckCard's ConfigField
// renders — only advertise a type the UI can actually draw (no 'select' until
// the <select> control + an `options` contract land).
export const CHECK_FIELD_TYPES = Object.freeze(['number', 'boolean', 'text']);

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
  const vsa = vowelSkeleton(a);
  if (vsa && vsa === vowelSkeleton(b)) signals.push('same vowel pattern');
  if (la.length >= 3 && lb.length >= 3 && la.slice(0, 3) === lb.slice(0, 3)) signals.push('same opening');
  if (la.endsWith(lb.slice(-2)) && la.slice(-2) === lb.slice(-2)) signals.push('same ending');
  return signals;
}

// ---------------------------------------------------------------------------
// Shared scaffolding for the relationship-link checks (#1287). All three walk
// `canon.characters × relationshipLinks`, so the id-bearing character list,
// the id→name lookup, and the link iteration live here once.
// ---------------------------------------------------------------------------

// Id-bearing characters + an id→name lookup (falling back to the id when a
// character is unnamed). The three checks index off this same pair.
function relationshipCanon(ctx) {
  const chars = (ctx.canon?.characters || []).filter((c) => c && c.id);
  return { chars, nameById: new Map(chars.map((c) => [c.id, c.name || c.id])) };
}

// Yields every relationship link that points somewhere, as { c, link, targetId }.
function* eachRelationshipLink(chars) {
  for (const c of chars) {
    for (const link of (Array.isArray(c.relationshipLinks) ? c.relationshipLinks : [])) {
      if (link?.targetCharacterId) yield { c, link, targetId: link.targetCharacterId };
    }
  }
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
    configFields: [
      {
        key: 'minSharedSignals',
        label: 'Minimum shared signals to flag',
        type: 'number',
        min: 1,
        max: 5,
        step: 1,
        help: 'How many similarity signals (first letter, length, vowel pattern, opening, ending) two names must share before they are flagged.',
      },
    ],
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
    id: 'relationships.reciprocity',
    label: 'Relationship reciprocity',
    description:
      'Flags one-sided structured relationship links — character A links to B, but B has no link back to A.',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'low',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      // For O(1) "does B link back to A?" lookups, index every link as a
      // "<source>→<target>" pair key.
      const linkPairs = new Set();
      for (const { c, targetId } of eachRelationshipLink(chars)) linkPairs.add(`${c.id}→${targetId}`);
      const findings = [];
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        // A dangling target (B doesn't exist) is the dangling-target check's
        // job; reciprocity only speaks to links between two real characters.
        if (!nameById.has(targetId)) continue;
        if (linkPairs.has(`${targetId}→${c.id}`)) continue;
        const aName = nameById.get(c.id);
        const bName = nameById.get(targetId);
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Characters: ${aName} → ${bName}`,
          problem: `"${aName}" has a ${link.type || 'custom'} link to "${bName}", but "${bName}" has no link back to "${aName}".`,
          suggestion: `Add a reciprocal relationship link from "${bName}" to "${aName}" (or remove the one-sided link if it's intentional).`,
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'relationships.dangling-target',
    label: 'Relationship dangling target',
    description:
      'Flags structured relationship links that point at a character id no longer present in the canon (deleted or renamed away).',
    scope: 'series',
    kind: 'deterministic',
    category: 'continuity',
    severityDefault: 'medium',
    defaultEnabled: true,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      const findings = [];
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        if (nameById.has(targetId)) continue;
        const aName = nameById.get(c.id);
        findings.push({
          severity: ctx.severityDefault,
          category: 'continuity',
          location: `Character: ${aName}`,
          problem: `"${aName}" has a ${link.type || 'custom'} relationship link pointing at a character id (${targetId}) that no longer exists in the canon.`,
          suggestion: 'Re-point the link at an existing character, or delete the stale link.',
          anchorQuote: aName,
          issueNumber: null,
        });
      }
      return findings;
    },
  },
  {
    id: 'relationships.opposition-reversal',
    label: 'Opposition role-reversal payoff',
    description:
      'Advisory — surfaces every tagged opposing-force pair (hunter/prey, winner/loser…) so you can confirm whether the reader ever sees the roles reverse, or deliberately not.',
    scope: 'series',
    kind: 'deterministic',
    category: 'arc',
    severityDefault: 'low',
    defaultEnabled: false,
    configSchema: z.object({}),
    run: (ctx) => {
      const { chars, nameById } = relationshipCanon(ctx);
      const findings = [];
      // Dedupe by the unordered character pair + axis so a reciprocally-tagged
      // opposition (A→B and B→A on the SAME axis) surfaces once — but two
      // DIFFERENT axes on the same pair (hunter/prey AND winner/loser) each
      // surface, since they're distinct payoffs the reader tracks separately.
      const seenPairs = new Set();
      for (const { c, link, targetId } of eachRelationshipLink(chars)) {
        if (!link.opposition?.axis || !nameById.has(targetId)) continue;
        const pairKey = `${[c.id, targetId].sort().join('|')}|${link.opposition.axis}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const aName = nameById.get(c.id);
        const bName = nameById.get(targetId);
        const { axis, thisRole, targetRole } = link.opposition;
        const roles = thisRole && targetRole ? ` (${aName}: ${thisRole}, ${bName}: ${targetRole})` : '';
        findings.push({
          severity: ctx.severityDefault,
          category: 'arc',
          location: `Characters: ${aName} / ${bName}`,
          problem: `Opposing-force pair tagged on "${aName}" / "${bName}" — axis "${axis}"${roles}.`,
          suggestion: 'Confirm the reader sees these roles reverse at some point in the arc (or that holding them fixed is the intended payoff).',
          anchorQuote: aName,
          issueNumber: null,
        });
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
    // Reads the stitched manuscript corpus — so the runner only pays the
    // section-collection I/O when a manuscript-consuming check is enabled.
    needsManuscript: true,
    configSchema: z.object({
      // Cap findings per run so a long manuscript can't flood the review.
      maxFindings: z.number().int().min(1).max(50).default(12),
      // Bound the prompt so a long series can't overflow a small/local
      // provider's context window (which would reject/clip the call and yield
      // zero findings). This is a single-call safeguard — full per-provider
      // context-window chunking (à la completenessPass) is tracked separately.
      maxManuscriptChars: z.number().int().min(2000).max(200_000).default(48_000),
    }),
    configFields: [
      {
        key: 'maxFindings',
        label: 'Max findings per run',
        type: 'number',
        min: 1,
        max: 50,
        step: 1,
        help: 'Cap findings so a long manuscript can not flood the review.',
      },
      {
        key: 'maxManuscriptChars',
        label: 'Max manuscript characters analyzed',
        type: 'number',
        min: 2000,
        max: 200_000,
        step: 1000,
        help: 'Bounds the prompt so a long series can not overflow a small provider context window.',
      },
    ],
    gate: (ctx) => (ctx.manuscript || '').trim().length > 0,
    run: async (ctx) => {
      const cap = ctx.config?.maxManuscriptChars ?? 48_000;
      const full = ctx.manuscript || '';
      const manuscript = full.length > cap
        ? `${full.slice(0, cap)}\n\n[manuscript truncated to the first ${cap} characters for this check]`
        : full;
      const { content } = await ctx.callStagedLLM(
        INFO_DUMPING_STAGE,
        { manuscript },
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

/**
 * Merge the static registry with persisted per-check state from settings.
 * Returns one row per registered check:
 *   { id, label, description, scope, kind, category, severityDefault,
 *     enabled, config, configFields }
 * `enabled` falls back to the check's `defaultEnabled`; `config` is validated
 * through the check's schema (with defaults); `configFields` is the wire-safe
 * render descriptor the UI builds its config form from (empty array when the
 * check declares none).
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
      configFields: Array.isArray(check.configFields) ? check.configFields : [],
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
 * Returns `{ check, config }` pairs (the live registry entry + its resolved
 * config) for every enabled check, narrowed to `subsetIds` when provided.
 */
export function getEnabledChecks(settings, subsetIds = null) {
  return getEnabledCheckRows(settings, subsetIds)
    .map((row) => ({ check: getCheck(row.id), config: row.config }))
    .filter((x) => x.check);
}
