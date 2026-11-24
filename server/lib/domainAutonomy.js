/**
 * Per-domain autonomy guardrails (pure helpers).
 *
 * `AUTONOMY_DOMAINS`/`DOMAIN_IDS`/`DOMAIN_MODES`, `getDomainMode(config, id)` and
 * `normalizeDomainAutonomy(raw)` split the global autonomy posture into per-domain modes:
 * `off` (leave work for explicit user action), `dry-run` (surface what WOULD happen without the
 * side effect) and `execute` (act automatically). The default is `execute`, reproducing pre-#711
 * behavior, so an absent stored config needs no migration. Also `CREATIVE_DOMAIN` /
 * `getCreativeAutonomyMode(config)` (#2183), kept out of `DOMAIN_IDS` and mirroring `cos`.
 *
 * Side-effect-free: execution-point gating lives at each call site.
 */

export const DOMAIN_MODES = ['off', 'dry-run', 'execute'];

export const DEFAULT_DOMAIN_MODE = 'execute';

// `id` is the stored key; `label`/`description` drive the settings UI. Single source of truth;
// the client mirrors it.
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
 * Coerce a raw (hand-edited/partial) map to `{ [domainId]: mode }`: unknown keys dropped,
 * missing/invalid core domains become `execute`. A valid explicit `creative` override is
 * preserved, while absent/null/invalid `creative` remains omitted so `getCreativeAutonomyMode`
 * continues mirroring `cos`.
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
  if (isValidMode(source[CREATIVE_DOMAIN_ID])) {
    normalized[CREATIVE_DOMAIN_ID] = source[CREATIVE_DOMAIN_ID];
  }
  return normalized;
}

/**
 * A domain's mode from a CoS config; missing config or an invalid stored value resolves to `execute`.
 *
 * @param {object|null|undefined} config - CoS config (has optional `domainAutonomy`)
 * @param {string} domainId - one of DOMAIN_IDS
 * @returns {'off'|'dry-run'|'execute'}
 */
export function getDomainMode(config, domainId) {
  const candidate = config?.domainAutonomy?.[domainId];
  return isValidMode(candidate) ? candidate : DEFAULT_DOMAIN_MODE;
}

// The `creative` domain (#2183) governs the Creative Director orchestrator's gated tool dispatch.
// Deliberately NOT in DOMAIN_IDS: no forced `execute` default and no budget/usage ledger. Its
// default MIRRORS `cos` so installs that tuned CoS auto-run behave consistently with no
// migration; an explicit `domainAutonomy.creative` overrides. Kept separate so the knob can
// diverge later without another migration.
export const CREATIVE_DOMAIN_ID = 'creative';

export const CREATIVE_DOMAIN = Object.freeze({
  id: CREATIVE_DOMAIN_ID,
  label: 'Creative orchestrator',
  description:
    'Automatically run creative-suite tools (universe, story, pipeline, media) from an orchestrating agent. Defaults to mirror the CoS auto-run mode.'
});

/**
 * The `creative` domain's mode: a valid explicit `domainAutonomy.creative` wins, else mirrors `cos`.
 *
 * @param {object|null|undefined} config - CoS config
 * @returns {'off'|'dry-run'|'execute'}
 */
export function getCreativeAutonomyMode(config) {
  const explicit = config?.domainAutonomy?.[CREATIVE_DOMAIN_ID];
  return isValidMode(explicit) ? explicit : getDomainMode(config, 'cos');
}
