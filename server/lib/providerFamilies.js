import { commandBasename, isClaudeCommand } from './providerModels.js';
import { isGrokCommand } from './grok.js';

/**
 * Subscription-quota FAMILY identity: which provider configs belong to the same
 * paid plan (`claude`, `codex`, `agy`, `grok`).
 *
 * This is the pure half of the registry `server/services/providerUsage.js`
 * drives — that service attaches a `fetch` per family, and those fetches spawn
 * PTYs to scrape a CLI's `/usage` panel. Identity has no business dragging that
 * graph in: pricing, cost attribution, and route validation all need to answer
 * "which plan is this provider on?" without being able to start a subprocess.
 *
 * Distinct from `lib/providerVendors.js`, which is argv-shaped and includes
 * vendors with no subscription quota to meter (opencode, kimi, cursor).
 */

/**
 * A provider config belongs to at most one family. CLI/TUI commands are matched
 * by binary basename; the Grok/Kimi-style API providers by id or endpoint.
 * Local-runtime CLI wrappers (Ollama or MTPLX) are local/free and have no
 * subscription quota, so they map to no family (see `familyForProvider`).
 */
export const PROVIDER_FAMILIES = [
  {
    id: 'claude',
    label: 'Claude Code',
    matches: (p) => (p.type === 'cli' || p.type === 'tui') && isClaudeCommand(p.command)
  },
  {
    id: 'codex',
    label: 'Codex',
    matches: (p) => commandBasename(p.command) === 'codex'
  },
  {
    id: 'agy',
    label: 'Antigravity',
    matches: (p) => commandBasename(p.command) === 'agy' || /antigravity/i.test(p.id || '')
  },
  {
    id: 'grok',
    label: 'Grok',
    matches: (p) => isGrokCommand(p.command) || /grok/i.test(p.id || '')
  }
];

/** Every family id, for schemas that must accept only a real family. */
export const PROVIDER_FAMILY_IDS = PROVIDER_FAMILIES.map((f) => f.id);

/** The human label for a family id, falling back to the id itself. Pure. */
export const familyLabel = (id) => PROVIDER_FAMILIES.find((f) => f.id === id)?.label || id;

/**
 * The family id a single provider config belongs to, or null for one that
 * belongs to none (a local-runtime wrapper, a pay-as-you-go API provider).
 * The inverse of `resolveEnabledFamilies`, so cost reporting can attribute a
 * provider's spend to the subscription that actually covered it.
 */
export function familyForProvider(provider) {
  if (!provider || provider.ollamaBacked === true || provider.mtplxBacked === true || provider.llamaBacked === true) return null;
  return PROVIDER_FAMILIES.find((f) => f.matches(provider))?.id ?? null;
}
