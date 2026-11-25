/** Identify Splash coding presets that follow the managed runtime or retain an explicit context limit. */

import { SPLASH_CONTEXT, SPLASH_MODEL, SPLASH_ORIGIN } from '../splashRuntime.js';
import { bareLocalModelId, getOpencodeLocalProviderNamespace, isClaudeCommand, isOpencodeCommand, parseOpencodeConfigContent } from './providerModels.js';

export const CLAUDE_CONTEXT_ENV_KEY = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';

export function splashHarnessTarget(provider, model = provider?.defaultModel) {
  if (provider?.splashBacked !== true || bareLocalModelId(model, 'splash') !== SPLASH_MODEL) return null;
  if (provider.command && isClaudeCommand(provider.command)) {
    const endpoint = provider.envVars?.ANTHROPIC_BASE_URL;
    if (typeof endpoint !== 'string' || endpoint.replace(/\/+$/, '') !== SPLASH_ORIGIN) return null;
    return { kind: 'claude', legacy: provider.envVars?.[CLAUDE_CONTEXT_ENV_KEY] };
  }
  if (!isOpencodeCommand(provider.command) || getOpencodeLocalProviderNamespace(provider) !== 'splash') return null;
  const config = parseOpencodeConfigContent(provider.envVars?.OPENCODE_CONFIG_CONTENT);
  const splash = config?.provider?.splash;
  const endpoint = splash?.options?.baseURL;
  if (typeof endpoint !== 'string' || endpoint.replace(/\/+$/, '') !== `${SPLASH_ORIGIN}/v1`) return null;
  return { kind: 'opencode', legacy: splash.models?.[SPLASH_MODEL]?.limit?.context };
}

export function followsSplashContext(provider, target) {
  if (!target) return false;
  if (provider.harnessContext?.followRuntime === true) return true;
  if (Number.isSafeInteger(provider.harnessContext?.tokens)) return false;
  // The old bundled Claude preset wrote exactly the fixed 64K default into
  // envVars. Different hand-entered values remain pins until the user opts in.
  return target.legacy == null || target.legacy === '' ||
    (target.kind === 'claude' && String(target.legacy) === String(SPLASH_CONTEXT));
}
