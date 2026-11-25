/** Determines which configured provider routes can generate HTML Pages without tools. */

import { restrictedMtplxOpenCodeConfig } from '../opencodeConfig.js';
import { resolveCliEffort } from './providerModels.js';
import { isToolFreeOneShotProvider } from './providerVendors.js';

export function htmlPagesProviderCapability(provider, model, effort) {
  if (!provider || provider.enabled === false) return null;
  if (isToolFreeOneShotProvider(provider)) return { kind: 'tool-free' };
  const config = restrictedMtplxOpenCodeConfig(provider, model);
  if (!config || (effort && resolveCliEffort(effort, provider, model) !== effort)) return null;
  return { kind: 'opencode-mtplx', endpoint: config.provider.mtplx.options.baseURL };
}
