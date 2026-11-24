/**
 * Subscription-quota provider family identity: `PROVIDER_FAMILIES` (claude/codex/agy/grok),
 * `PROVIDER_FAMILY_IDS`, `familyLabel` and `familyForProvider(config)`.
 */

import { isClaudeHarnessProvider } from './providerTypes.js';
import { commandBasename } from './providerModels.js';

/**
 * Subscription-quota FAMILY identity: which provider configs belong to the same paid plan (`claude`, `codex`, `agy`, `grok`). The pure half of the registry `server/services/provider/providerUsage.js` drives (which attaches a `fetch` per family that spawns PTYs to scrape a CLI's `/usage`); pricing, cost attribution and route validation need "which plan is this provider on?"
 * without starting a subprocess. Distinct from `lib/provider/providerVendors.js`, which is argv-shaped and includes vendors with no subscription quota to meter (opencode, kimi, cursor).
 */

/**
 * A provider config belongs to at most one family. CLI/TUI commands are matched
 * by binary basename; the Grok/Kimi-style API providers by id or endpoint.
 * Local-runtime CLI wrappers (Ollama, MTPLX, llama.cpp, vLLM) are local/free and have no
 * subscription quota, so they map to no family (see `familyForProvider`).
 */
export const PROVIDER_FAMILIES = [
  {
    id: 'claude',
    label: 'Claude Code',
    idPattern: /claude/i,
    matches: isClaudeHarnessProvider
  },
  {
    id: 'codex',
    label: 'Codex',
    idPattern: /codex/i,
    matches: (p) => commandBasename(p.command) === 'codex'
  },
  {
    id: 'agy',
    label: 'Antigravity',
    idPattern: /antigravity|(^|[-_])agy([-_]|$)/i,
    matches: (p) => commandBasename(p.command) === 'agy' || /antigravity/i.test(p.id || '')
  },
  {
    id: 'grok',
    label: 'Grok',
    idPattern: /grok/i,
    matches: (p) => commandBasename(p.command) === 'grok' || /grok/i.test(p.id || '')
  }
];

/** Every family id, for schemas that must accept only a real family. */
export const PROVIDER_FAMILY_IDS = PROVIDER_FAMILIES.map((f) => f.id);

/** The human label for a family id, falling back to the id itself. Pure. */
export const familyLabel = (id) => PROVIDER_FAMILIES.find((f) => f.id === id)?.label || id;

/** The family id a single provider config belongs to, or null (a local-runtime wrapper, a pay-as-you-go API provider); the inverse of `resolveEnabledFamilies`, so cost reporting attributes spend to the subscription that covered it. */
export function familyForProvider(provider) {
  if (!provider || provider.ollamaBacked === true || provider.lmstudioBacked === true || provider.mtplxBacked === true || provider.llamaBacked === true || provider.vllmBacked === true || provider.sglangBacked === true || provider.splashBacked === true) return null;
  return PROVIDER_FAMILIES.find((f) => f.matches(provider))?.id ?? null;
}

/**
 * The family a provider ID alone identifies, or `null`. Strictly weaker than `familyForProvider`: the BINARY really identifies a family, but a Zod schema validating a stored config has only the id (the provider list is service state it can't reach), so this answers what an id settles and `null` otherwise, letting the caller fall through to the live check.
 * Used by `quotaBurnValidation.js` to reject a burn step pinned to another family's subscription before it reaches disk; an id naming no family is accepted there and resolved at dispatch.
 */
export function familyForProviderId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!value) return null;
  return PROVIDER_FAMILIES.find((f) => f.idPattern.test(value))?.id ?? null;
}
