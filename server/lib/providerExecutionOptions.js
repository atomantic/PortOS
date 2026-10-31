import { createHash } from 'node:crypto';
import { buildCodexAuthModeArgs, isCodexCommand } from './codex.js';
import { isGrokCommand, grokSpeedArgsConflict, grokSpeedTarget } from './grok.js';
import { probeGrokModelCatalog } from './grokModelCatalog.js';
import { codexOssLocalProvider, extractBakedModel } from './providerModels.js';
import { EXECUTION_OPTION_DEFINITIONS, resolveExecutionOptions, executionOptionsError } from './executionOptions.js';
import { probeCodexModelsViaAppServer } from './aiToolkit/internal/codexModelListProbe.js';
import { prepareCliSpawn } from './bufferedSpawn.js';

/** A read-only runtime probe; never sends a prompt or starts a model turn. */
async function inspectExecutionOptionCapabilities(provider, model, context = {}) {
  if (isGrokCommand(provider?.command)) return inspectGrokExecutionOptionCapabilities(provider, model, context);
  const descriptor = { version: 1, options: isCodexCommand(provider?.command) && ['cli', 'tui'].includes(provider?.type) ? [{ ...EXECUTION_OPTION_DEFINITIONS.serviceTier, values: [] }] : [], reason: null };
  if (provider?.enabled === false || provider?.unavailableReason) return { ...descriptor, reason: provider.unavailableReason || 'This provider is disabled.' };
  if ((provider?.args || []).some((arg) => /service_tier|features\.(?:fast_mode|ultrafast_mode)|fast_default_opt_out/.test(arg))) return { ...descriptor, reason: 'Speed conflicts with provider args; remove the baked speed setting before selecting an override.' };
  if (!isCodexCommand(provider?.command) || !['cli', 'tui'].includes(provider?.type)
      || provider.codexAuthMode === 'api' || codexOssLocalProvider(provider)
      || provider.gatewayBacked || provider.credentialBootstrap || provider.credentialBootstrapId
      || (provider.args || []).some((arg) => /forced_login_method|model_provider|service_tier|features\.(?:fast_mode|ultrafast_mode)|^--?(?:profile|p|cd|C|oss|local-provider)(?:=|$)/.test(arg))) {
    return { ...descriptor, reason: 'Speed requires a Codex CLI or TUI route explicitly authenticated with ChatGPT.' };
  }
  const bakedModel = extractBakedModel(provider.args);
  if (bakedModel && model && model !== 'codex-configured-default' && bakedModel !== model) return { ...descriptor, reason: 'The selected model conflicts with provider args; remove the baked model pin before selecting speed.' };
  const configArgs = [];
  for (let index = 0; index < (provider.args || []).length; index++) {
    const arg = provider.args[index];
    if (arg === '-c' || arg === '--config') {
      if (typeof provider.args[index + 1] === 'string') configArgs.push(arg, provider.args[++index]);
    } else if (arg.startsWith('--config=')) configArgs.push(arg);
  }
  const invocation = prepareCliSpawn(provider.command, [
    ...(provider.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...configArgs, ...buildCodexAuthModeArgs(provider), 'app-server',
  ], { ...process.env, ...provider.envVars });
  const details = await probeCodexModelsViaAppServer(invocation.command, invocation.args, provider, { includeDetails: true, cwd: context.cwd, ...(Number.isFinite(context.timeoutMs) ? { timeoutMs: Math.max(1, Math.min(15000, context.timeoutMs)) } : {}) }).catch(() => null);
  if (!details) return { ...descriptor, reason: 'This runtime could not verify speed capabilities. Refresh capabilities or update Codex.' };
  if (!['chatgpt', 'chatgptAuthTokens'].includes(details.accountType)
      || (details.config?.model_provider && details.config.model_provider !== 'openai')
      || details.config?.forced_login_method === 'api') {
    return { ...descriptor, reason: 'Speed requires the active OpenAI ChatGPT subscription route.' };
  }
  const explicit = model && model !== 'codex-configured-default';
  if (!explicit && (provider.args || []).includes('resume')) return { ...descriptor, reason: 'Choose an explicit model before changing a resumed session speed.' };
  const actualModel = explicit ? model : bakedModel || details.config?.models?.new_thread?.model || details.config?.model
    || details.models.find((item) => item.isDefault)?.id;
  const entry = details.models.find((item) => item.id === actualModel || item.model === actualModel);
  const tiers = entry?.serviceTiers;
  if (!Array.isArray(tiers)) return { ...descriptor, reason: 'This runtime did not advertise model speed capabilities.' };
  const fast = tiers.some((tier) => tier.id === 'fast' || tier.id === 'priority')
    && details.requirements?.featureRequirements?.fast_mode !== false;
  return { ...descriptor, model: entry.id || entry.model, authMode: 'chatgpt', options: [{ ...EXECUTION_OPTION_DEFINITIONS.serviceTier,
    values: fast ? ['standard', 'fast'] : ['standard'] }] };
}

/**
 * Grok Build speed is a serving tier on the model id, advertised by `grok models`
 * listing both `<base>` and `<base>-build-fast`. The public API provider is a
 * different harness and never reaches this probe.
 */
async function inspectGrokExecutionOptionCapabilities(provider, model, context = {}) {
  const cliRoute = ['cli', 'tui'].includes(provider?.type);
  const descriptor = {
    version: 1,
    options: cliRoute ? [{ ...EXECUTION_OPTION_DEFINITIONS.serviceTier, values: [] }] : [],
    reason: null,
  };
  if (provider?.enabled === false || provider?.unavailableReason) {
    return { ...descriptor, reason: provider.unavailableReason || 'This provider is disabled.' };
  }
  if (!cliRoute || provider.gatewayBacked || provider.credentialBootstrap || provider.credentialBootstrapId) {
    return { ...descriptor, reason: 'Speed requires a Grok Build CLI or TUI route.' };
  }
  if (grokSpeedArgsConflict(provider.args)) {
    return { ...descriptor, reason: 'Speed conflicts with provider args; remove the baked model pin before selecting an override.' };
  }
  const timeoutMs = Number.isFinite(context.timeoutMs) ? Math.max(1, Math.min(15_000, context.timeoutMs)) : 15_000;
  const details = await probeGrokModelCatalog(provider, { cwd: context.cwd, timeoutMs }).catch(() => null);
  if (!details) {
    return { ...descriptor, reason: 'This runtime could not verify speed capabilities. Refresh capabilities or update Grok.' };
  }
  const target = grokSpeedTarget(model, details.ids, details.defaultModel);
  if (!target.values.length) return { ...descriptor, model: target.model, reason: target.reason };
  return {
    ...descriptor,
    model: target.model,
    modelBase: target.modelBase,
    authMode: 'grok',
    options: [{ ...EXECUTION_OPTION_DEFINITIONS.serviceTier, values: target.values }],
  };
}

const capabilityReads = new Map();
export async function getExecutionOptionCapabilities(provider, model, { fresh = false, cwd, timeoutMs } = {}) {
  const key = createHash('sha256').update(JSON.stringify([provider?.id, provider?.command, provider?.type,
    provider?.args, provider?.codexAuthMode, provider?.ignoreUserConfig, provider?.envVars, provider?.enabled, provider?.unavailableReason, model, cwd])).digest('hex');
  const cached = capabilityReads.get(key);
  if (!fresh && cached && Date.now() < cached.expires) return cached.promise;
  const entry = { expires: Date.now() + 10_000, promise: inspectExecutionOptionCapabilities(provider, model, { cwd, timeoutMs }) };
  capabilityReads.set(key, entry);
  if (capabilityReads.size > 200) capabilityReads.delete(capabilityReads.keys().next().value);
  entry.promise.catch(() => { if (capabilityReads.get(key) === entry) capabilityReads.delete(key); });
  return entry.promise;
}

export async function prepareExecutionOptions(provider, model, options, source = 'run', context = {}) {
  const attribution = resolveExecutionOptions(
    { source: 'provider', options: provider.executionSelectionDefaults ?? provider.executionOptions },
    { source: 'selection', options: provider.executionSelectionOptions },
    { source, options },
  );
  if (Object.keys(attribution.requested).length === 0) return { provider, attribution };
  const capabilities = await getExecutionOptionCapabilities(provider, model, { fresh: true, cwd: context.cwd, timeoutMs: context.timeoutMs })
    .catch(() => { throw executionOptionsError('Execution speed capabilities could not be verified; retry capability inspection before dispatch.'); });
  for (const [key, value] of Object.entries(attribution.requested)) {
    if (!capabilities.options.find((option) => option.key === key)?.values.includes(value)) {
      throw executionOptionsError(capabilities.reason || `Execution option ${key}=${value} is unsupported by this route and model`);
    }
  }
  attribution.model = capabilities.model;
  const copy = { ...provider, ...(capabilities.model ? { defaultModel: capabilities.model } : {}), executionOptions: attribution.requested,
    executionOptionSupport: {
      ...Object.fromEntries(capabilities.options.map((option) => [option.key, option.values])),
      authMode: capabilities.authMode,
      ...(capabilities.modelBase ? { modelBase: capabilities.modelBase } : {}),
    },
    executionOptionAttribution: attribution };
  if (provider.apiKey) Object.defineProperty(copy, 'apiKey', { value: provider.apiKey, enumerable: false });
  return { provider: copy, attribution };
}

