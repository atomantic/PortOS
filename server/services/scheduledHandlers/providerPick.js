/**
 * Which provider a burn job spends, shared by every job type. Its own module so the
 * registry's lazy job imports are not defeated by importing a sibling job's helper
 * (`agentPrompt.js` pulls the CoS task store and managed-app store).
 */

import { isProcessProvider } from '../../lib/provider/providerTypes.js';
import { getAllProviders } from '../provider/providers.js';
import { commandBasename } from '../../lib/provider/providerModels.js';

/**
 * Is this the "no subscription family" identity? A MANUAL maintenance run
 * (`services/maintenanceRun.js`) may pin a provider in no family (OpenCode TUI, local
 * wrappers) and constructs this identity explicitly; recognizing it HERE, not from a
 * falsy `familyId`, keeps the automatic burn sweep out of it.
 */
export const isUnfamiliedBurn = (family) => family?.unfamilied === true && !family.id;

/**
 * An agent-capable provider in the burning family. A job's explicit `providerId` wins;
 * otherwise match the family id against enabled providers, preferring type `prefer`
 * (default `tui`: unattended agent burns should be watchable and steerable; most families
 * register CLI and TUI and the CLI sorts first). A PROGRAMMATIC job passes `prefer: 'cli'`
 * (one headless prompt); the other type stays a fallback so a one-type family still burns.
 *
 * Excluded: API-type providers (bill per token, no window) and local-runtime wrappers (no
 * window to spend; `resolveEnabledFamilies` drops them from quota cards too).
 * `unfamilied` lifts the local-runtime exclusion only together with an explicit
 * `providerId`; `isProcessProvider` must still hold because the ladder spawns a CLI/TUI agent.
 */
export function providerForFamily(providers, { familyId, providerId, prefer = 'tui', unfamilied = false }) {
  const localRuntimeAllowed = unfamilied === true && !familyId && Boolean(providerId);
  const available = (providers || []).filter((provider) =>
    provider?.enabled
    && (localRuntimeAllowed || (provider.ollamaBacked !== true && provider.lmstudioBacked !== true && provider.mtplxBacked !== true && provider.llamaBacked !== true && provider.vllmBacked !== true && provider.sglangBacked !== true && provider.splashBacked !== true))
    && isProcessProvider(provider));
  if (providerId) return available.find((provider) => provider.id === providerId) || null;
  const inFamily = available.filter((provider) => !(provider.executionSourceProviderId || provider.executionSelectionRoot) && matchesFamily(provider, familyId));
  return inFamily.find((provider) => provider.type === prefer) || inFamily[0] || null;
}

/**
 * Does this provider belong to `familyId`? The BINARY identifies the family, not the id
 * (`agy` ships as `antigravity-cli`/`antigravity-tui`); the id substring is the fallback
 * for wrapper scripts. Exported because `providerForFamily` honors an explicit `providerId`
 * pin without re-checking, and `quotaBurnInvoke.js` must refuse an out-of-family pin.
 */
export const matchesFamily = (provider, familyId) => {
  const needle = String(familyId || '').toLowerCase();
  if (!needle) return false;
  return commandBasename(provider.command) === needle
    || String(provider.id || '').toLowerCase().includes(needle);
};

/** Reason reported when the family has nothing spendable; an unfamilied run was given no provider to pin. */
export const noProviderReason = (family) => (isUnfamiliedBurn(family)
  ? 'a run outside every subscription family must name the provider to use'
  : `no enabled CLI/TUI provider in the ${family?.id} family`);

/** `providerForFamily` against the live provider list. */
export async function resolveBurnProvider({ job, family, prefer }) {
  const result = await getAllProviders();
  return providerForFamily(Array.isArray(result) ? result : result?.providers, {
    familyId: family?.id,
    providerId: job?.providerId || null,
    prefer,
    unfamilied: isUnfamiliedBurn(family),
  });
}
