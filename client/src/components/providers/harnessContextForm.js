import {
  bareLocalModelId, getOpencodeLocalProviderNamespace, isClaudeCommand, isOpencodeCommand,
  parseOpencodeConfigContent,
} from '../../../../server/lib/provider/providerModels.js';
import { isGatewayNamespace } from '../../../../server/lib/provider/providerGateways.js';
import { SPLASH_CONTEXT, SPLASH_MODEL } from '../../../../server/lib/splashRuntime.js';

const CLAUDE_WINDOW = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';
const OPENCODE_CONFIG = 'OPENCODE_CONFIG_CONTENT';
const MIN_TOKENS = 512;
const MAX_TOKENS = 2097152;
export const CONTEXT_CHOICES = [
  ['32K', 32768], ['64K', 65536], ['128K', 131072],
  ['256K', 262144], ['512K', 524288], ['1M', 1000000],
];

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

// "K" follows daemon launch flags (1024); "M" is a decimal million.
// Store only integers; never silently round an ambiguous shorthand.
export function parseHarnessContext(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+)\s*([km])?$/i);
  if (!match || (!match[2] && match[1].includes('.'))) return undefined;
  const suffix = match[2]?.toLowerCase();
  const count = Number(match[1].replaceAll(',', '')) * (suffix === 'k' ? 1024 : suffix === 'm' ? 1000000 : 1);
  return Number.isSafeInteger(count) && count >= MIN_TOKENS && count <= MAX_TOKENS ? count : undefined;
}

function opencodeContextTarget(provider) {
  const model = provider.defaultModel;
  if (!model || (provider.secretEnvVars || []).includes(OPENCODE_CONFIG)) return null;
  const raw = provider.envVars?.[OPENCODE_CONFIG];
  const base = parseOpencodeConfigContent(raw);
  if (raw && !base) return null;
  const managed = getOpencodeLocalProviderNamespace(provider);
  const slash = model.indexOf('/');
  const namespace = managed || (slash > 0 ? model.slice(0, slash) : null);
  // Without a managed namespace, only edit an explicit inline declaration.
  // Never invent a replacement for a native catalog or ~/.config/opencode.
  if (!namespace || !Object.hasOwn(object(base?.provider), namespace)) return null;
  const id = managed
    ? isGatewayNamespace(namespace) ? model : bareLocalModelId(model, namespace)
    : model.slice(slash + 1);
  if (!id || /(^|\/)auto$/.test(id)) return null;
  const limit = object(base?.provider?.[namespace]?.models?.[id]?.limit);
  const splash = namespace === 'splash' && id === SPLASH_MODEL;
  return {
    key: JSON.stringify(['opencode', namespace, id]), kind: 'opencode', model, id, namespace,
    value: provider.harnessContext?.model && provider.harnessContext.model === model ? provider.harnessContext.tokens : '',
    inherited: typeof limit.context === 'number' ? limit.context : null,
    output: typeof limit.output === 'number' ? limit.output : splash ? 8192 : null,
    input: typeof limit.input === 'number' ? limit.input : null,
    fallback: splash ? SPLASH_CONTEXT : null, splash,
  };
}

export function getHarnessContextTarget(provider) {
  if (!['cli', 'tui'].includes(provider?.type) || !provider.command) return null;
  if (isOpencodeCommand(provider.command)) return opencodeContextTarget(provider);
  if (!isClaudeCommand(provider.command) || (provider.secretEnvVars || []).includes(CLAUDE_WINDOW)) return null;
  const value = provider.envVars?.[CLAUDE_WINDOW];
  // Native Claude models know their own limits. A gateway override is explicit
  // and can only affect IDs Claude Code treats as custom.
  if (!provider.envVars?.ANTHROPIC_BASE_URL && value == null) return null;
  return { key: 'claude', kind: 'claude', model: provider.defaultModel, value: !provider.harnessContext?.model ? provider.harnessContext?.tokens ?? '' : '',
    inherited: parseHarnessContext(value), fallback: provider.splashBacked === true ? SPLASH_CONTEXT : null, splash: provider.splashBacked === true };
}

export function harnessContextError(target, value) {
  const parsed = parseHarnessContext(value);
  if (parsed === undefined) return 'Enter a context window from 512 to 2,097,152 tokens, such as 64K, 256K, or 1M.';
  if (parsed != null && target.output >= parsed) return 'The context window must be larger than the configured OpenCode output limit.';
  if (parsed != null && target.input > parsed) return 'The context window cannot be smaller than the configured OpenCode input limit.';
  return null;
}

export function harnessContextPayload(target, value) {
  const tokens = parseHarnessContext(value);
  return tokens == null ? null : { tokens, ...(target.kind === 'opencode' ? { model: target.model } : {}) };
}
