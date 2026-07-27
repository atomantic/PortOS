import { getAllProviders } from '../providers.js';
import { getProviderQuotas } from '../providerUsage.js';
import { getQuotaBurnDispatches, recordQuotaBurnDispatch, selectBurnCandidates, quotaBurnConfig, QUOTA_BURN_TASK_TYPE } from '../quotaBurn.js';

function providerForFamily(providers, family) {
  const available = (providers || []).filter((provider) =>
    provider?.enabled && (provider.type === 'cli' || provider.type === 'tui'));
  if (family.providerId) return available.find((provider) => provider.id === family.providerId) || null;
  const familyName = family.id.toLowerCase();
  return available.find((provider) => String(provider.id || '').toLowerCase().includes(familyName)) || null;
}

function renderPrompt(candidate) {
  const { family, limit, hoursUntilReset } = candidate;
  return [
    `# ${family.id} quota-burn task`,
    '',
    `This configured ${family.id} quota window resets in about ${Math.max(0, Math.ceil(hoursUntilReset))} hours.`,
    `Window: ${limit.label || limit.scope || 'provider window'}; remaining: ${limit.percentRemaining}%; reserve: ${family.reservePercent}%.`,
    `Dispatch cap: ${family.maxDispatchesPerWindow} for this reset window.`,
    '',
    'Carry out the configured work below. Do not use another provider family as a substitute.',
    '',
    family.prompt.trim(),
  ].join('\n');
}

/**
 * Programmatic pre-agent hook. It refreshes quota readings immediately before
 * dispatch, pins an agent-capable provider in the selected family, and returns
 * a skip instead of spawning when any prerequisite is missing.
 */
export async function buildTaskInput({ app } = {}) {
  if (!app) return { skip: { reason: 'no-app' } };
  const config = quotaBurnConfig(app);
  const ledger = await getQuotaBurnDispatches();
  const quotas = await getProviderQuotas({ refresh: true });
  const candidates = selectBurnCandidates(quotas, config, { dispatches: ledger });
  const candidate = candidates[0];
  if (!candidate) return { skip: { reason: 'no-burnable-provider-quota' } };

  const providerResult = await getAllProviders();
  const provider = providerForFamily(
    Array.isArray(providerResult) ? providerResult : providerResult?.providers,
    candidate.family,
  );
  if (!provider) return { skip: { reason: 'no-enabled-agent-provider-in-family' } };

  await recordQuotaBurnDispatch(candidate.dispatchKey);
  return {
    prompt: renderPrompt(candidate),
    providerId: provider.id,
    model: candidate.family.model || null,
  };
}

export const __test = { providerForFamily, renderPrompt, QUOTA_BURN_TASK_TYPE };
