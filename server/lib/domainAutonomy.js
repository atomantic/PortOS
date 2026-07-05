/**
 * Per-domain autonomy guardrails (pure helpers).
 *
 * Splits PortOS's single global autonomy posture into independent per-domain
 * knobs. Each domain is one of three modes:
 *
 *   - `off`      — never act automatically; leave the work for explicit user action.
 *   - `dry-run`  — compute what WOULD happen and surface it, but don't commit the
 *                  side effect (don't file, don't store-as-active, don't spawn, don't send).
 *   - `execute`  — act automatically (the historical default behavior).
 *
 * The default for every domain is `execute`, which exactly reproduces pre-#711
 * behavior — so an install with no stored `domainAutonomy` config needs no
 * migration; the absent-key path resolves to `execute`.
 *
 * These helpers are side-effect-free: callers pass in the CoS config (or a raw
 * domainAutonomy map) and read back a normalized mode. The execution-point
 * gating (brain.js, memoryExtractor.js, cos.js, telegram.js) lives at each call
 * site; this module only owns the vocabulary and normalization.
 */

export const DOMAIN_MODES = ['off', 'dry-run', 'execute'];

export const DEFAULT_DOMAIN_MODE = 'execute';

// The four domains the issue (#711) carves the global posture into. `id` is the
// stored key; `label`/`description` drive the settings UI. Keep this list as the
// single source of truth — the client mirrors it for rendering.
export const AUTONOMY_DOMAINS = [
  {
    id: 'brain',
    label: 'Brain auto-classify',
    description: 'Automatically classify captured thoughts and file them to a destination.'
  },
  {
    id: 'memory',
    label: 'Memory auto-extract',
    description: 'Automatically store high-confidence memories extracted from agent runs.'
  },
  {
    id: 'cos',
    label: 'CoS auto-run',
    description: 'Automatically spawn autonomous (non-user) tasks without approval.'
  },
  {
    id: 'messages',
    label: 'Messages auto-send',
    description: 'Automatically forward notifications to outbound channels (e.g. Telegram).'
  }
];

export const DOMAIN_IDS = AUTONOMY_DOMAINS.map((d) => d.id);

const isValidMode = (mode) => DOMAIN_MODES.includes(mode);

/**
 * Coerce a raw (possibly hand-edited / legacy / partial) domainAutonomy map into
 * a complete, valid `{ [domainId]: mode }` object. Unknown keys are dropped;
 * missing or invalid values fall back to `execute`.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeDomainAutonomy(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const normalized = {};
  for (const id of DOMAIN_IDS) {
    const candidate = source[id];
    normalized[id] = isValidMode(candidate) ? candidate : DEFAULT_DOMAIN_MODE;
  }
  return normalized;
}

/**
 * Read a single domain's mode from a CoS config object. Tolerates a missing
 * `config`, a missing `domainAutonomy`, and an unknown/invalid stored value —
 * all resolve to `execute` so absent config reproduces historical behavior.
 *
 * @param {object|null|undefined} config - CoS config (has optional `domainAutonomy`)
 * @param {string} domainId - one of DOMAIN_IDS
 * @returns {'off'|'dry-run'|'execute'}
 */
export function getDomainMode(config, domainId) {
  const candidate = config?.domainAutonomy?.[domainId];
  return isValidMode(candidate) ? candidate : DEFAULT_DOMAIN_MODE;
}

// The `creative` autonomy domain (#2183) governs the Creative Director
// orchestrator's gated tool dispatch (universe/story/pipeline/media generators an
// agent may drive autonomously). It is deliberately kept SEPARATE from the four
// normalized core domains above — it is NOT in DOMAIN_IDS, so it carries no forced
// `execute` default and no parallel budget/usage ledger, and existing budget/UI
// tests are untouched. Its default MIRRORS the `cos` domain's mode so installs
// that already tuned CoS auto-run get consistent orchestrator behavior with no
// migration; an explicit stored `domainAutonomy.creative` value (settable by a
// future settings UI) overrides the mirror. Decision recorded for review: keep
// separate + mirror cos rather than folding into `cos` outright, so the knob can
// diverge later without another migration.
export const CREATIVE_DOMAIN_ID = 'creative';

export const CREATIVE_DOMAIN = Object.freeze({
  id: CREATIVE_DOMAIN_ID,
  label: 'Creative orchestrator',
  description:
    'Automatically run creative-suite tools (universe, story, pipeline, media) from an orchestrating agent. Defaults to mirror the CoS auto-run mode.'
});

/**
 * Resolve the `creative` domain's mode (off | dry-run | execute). An explicit,
 * valid `domainAutonomy.creative` value wins; otherwise the mode MIRRORS the
 * `cos` domain (which itself defaults to `execute` for an absent config).
 *
 * @param {object|null|undefined} config - CoS config
 * @returns {'off'|'dry-run'|'execute'}
 */
export function getCreativeAutonomyMode(config) {
  const explicit = config?.domainAutonomy?.[CREATIVE_DOMAIN_ID];
  return isValidMode(explicit) ? explicit : getDomainMode(config, 'cos');
}
