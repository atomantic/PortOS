/**
 * Which provider a burn job spends — shared by every job type.
 *
 * Its own module rather than a sibling job's export: the registry lazy-imports
 * job modules specifically so a status read doesn't drag in a job's heavy
 * dependencies (`agentPrompt.js` pulls the CoS task store and the managed-app
 * store), and importing this helper from there would have made every
 * programmatic job's probe load exactly that.
 */

import { getAllProviders } from '../providers.js';
import { commandBasename } from '../../lib/providerModels.js';

/**
 * An agent-capable provider in the burning family. A job's explicit
 * `providerId` wins; otherwise match the family id against the enabled
 * providers, PREFERRING the type named by `prefer` (default `tui`).
 *
 * Preferring the TUI is the point for an AGENT burn: it runs unattended for
 * minutes on the user's own subscription, and a TUI agent is watchable in Active
 * Agents and can be steered mid-run, where a headless CLI run can only be read
 * after it has finished. Most families have both registered (`claude-code` +
 * `claude-code-tui`, `codex` + `codex-tui`, …) and the CLI sorts first, so a
 * plain `find` silently picked the unobservable one every time.
 * `pickScrapeProvider` applies the same preference when reading `/usage`.
 *
 * A PROGRAMMATIC job passes `prefer: 'cli'` instead: it sends one headless
 * prompt through the stage runner, with no agent session to watch or steer, so
 * the TUI's observability buys nothing and its interactive startup is pure
 * overhead. The other type is still accepted as a fallback — a family with only
 * a TUI registered must not silently stop burning.
 *
 * Two exclusions, both about what a burn is FOR — spending a subscription window
 * that would otherwise expire unused:
 * - API-type providers bill per token rather than drawing down a window.
 * - Local-runtime wrappers run a LOCAL model, so there is no window to spend and
 *   burning through one accomplishes nothing. `resolveEnabledFamilies` drops
 *   them from the quota cards for exactly this reason; a `claude-ollama-tui`
 *   would otherwise be a perfectly good match for the `claude` family.
 */
export function providerForFamily(providers, { familyId, providerId, prefer = 'tui' }) {
  const available = (providers || []).filter((provider) =>
    provider?.enabled && provider.ollamaBacked !== true && provider.mtplxBacked !== true && provider.llamaBacked !== true
    && (provider.type === 'cli' || provider.type === 'tui'));
  if (providerId) return available.find((provider) => provider.id === providerId) || null;
  const inFamily = available.filter((provider) => matchesFamily(provider, familyId));
  return inFamily.find((provider) => provider.type === prefer) || inFamily[0] || null;
}

/**
 * Does this provider belong to `familyId`?
 *
 * The BINARY is what actually identifies the family — the provider id is a
 * user-facing label and does not have to contain the family name. Matching on
 * the id alone silently stranded the whole `agy` family: its providers ship as
 * `antigravity-cli` / `antigravity-tui`, neither of which contains "agy", so a
 * configured Antigravity burn plan reported "no enabled CLI/TUI provider" and
 * could never dispatch — while the quota card sat right above it showing a
 * healthy window, because `providerUsage`'s own matcher checks the command.
 *
 * The id substring stays as a fallback for a provider registered under a wrapper
 * script whose basename isn't the family name.
 */
const matchesFamily = (provider, familyId) => {
  const needle = String(familyId || '').toLowerCase();
  if (!needle) return false;
  return commandBasename(provider.command) === needle
    || String(provider.id || '').toLowerCase().includes(needle);
};

/** The reason a job reports when its family has nothing it is allowed to spend. */
export const noProviderReason = (family) => `no enabled CLI/TUI provider in the ${family?.id} family`;

/** `providerForFamily` against the live provider list. */
export async function resolveBurnProvider({ job, family, prefer }) {
  const result = await getAllProviders();
  return providerForFamily(Array.isArray(result) ? result : result?.providers, {
    familyId: family?.id,
    providerId: job?.providerId || null,
    prefer,
  });
}
