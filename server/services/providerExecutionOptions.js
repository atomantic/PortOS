import { buildCodexAuthModeArgs, isCodexCommand } from '../lib/codex.js';
import { codexOssLocalProvider } from '../lib/providerModels.js';
import { EXECUTION_OPTION_DEFINITIONS, resolveExecutionOptions, executionOptionsError } from '../lib/executionOptions.js';
import { probeCodexModelsViaAppServer } from '../lib/aiToolkit/internal/codexModelListProbe.js';
import { prepareCliSpawn } from '../lib/bufferedSpawn.js';

/** A read-only runtime probe; never sends a prompt or starts a model turn. */
export async function getExecutionOptionCapabilities(provider, model) {
  const descriptor = { version: 1, options: [], reason: null };
  if (!isCodexCommand(provider?.command) || !['cli', 'tui'].includes(provider?.type)
      || provider.codexAuthMode !== 'chatgpt' || codexOssLocalProvider(provider)
      || provider.gatewayBacked || provider.credentialBootstrap || provider.credentialBootstrapId
      || (provider.args || []).some((arg) => /forced_login_method|model_provider|service_tier|features\.(?:fast_mode|ultrafast_mode)/.test(arg))) {
    return { ...descriptor, reason: 'Speed requires a Codex CLI or TUI route explicitly authenticated with ChatGPT.' };
  }
  if (!model || model === 'codex-configured-default') {
    return { ...descriptor, reason: 'Choose an explicit model to verify speed availability.' };
  }
  const invocation = prepareCliSpawn(provider.command, [
    ...(provider.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...buildCodexAuthModeArgs(provider), 'app-server',
  ], { ...process.env, ...provider.envVars });
  const models = await probeCodexModelsViaAppServer(invocation.command, invocation.args, provider, { includeDetails: true });
  const entry = models.find((item) => item.id === model || item.model === model);
  const tiers = entry?.serviceTiers;
  if (!Array.isArray(tiers)) return { ...descriptor, reason: 'This runtime did not advertise model speed capabilities.' };
  const fast = tiers.some((tier) => tier.id === 'fast' || tier.id === 'priority');
  return { ...descriptor, options: [{ ...EXECUTION_OPTION_DEFINITIONS.serviceTier,
    values: fast ? ['standard', 'fast'] : ['standard'] }] };
}

export async function prepareExecutionOptions(provider, model, options, source = 'run') {
  const attribution = resolveExecutionOptions(
    { source: 'provider', options: provider.executionOptions },
    { source, options },
  );
  if (Object.keys(attribution.requested).length === 0) return { provider, attribution };
  const capabilities = await getExecutionOptionCapabilities(provider, model)
    .catch(() => { throw executionOptionsError('Execution speed capabilities could not be verified; retry capability inspection before dispatch.'); });
  for (const [key, value] of Object.entries(attribution.requested)) {
    if (!capabilities.options.find((option) => option.key === key)?.values.includes(value)) {
      throw executionOptionsError(capabilities.reason || `Execution option ${key}=${value} is unsupported by this route and model`);
    }
  }
  const copy = { ...provider, executionOptions: attribution.requested,
    executionOptionSupport: Object.fromEntries(capabilities.options.map((option) => [option.key, option.values])) };
  if (provider.apiKey) Object.defineProperty(copy, 'apiKey', { value: provider.apiKey, enumerable: false });
  return { provider: copy, attribution };
}
