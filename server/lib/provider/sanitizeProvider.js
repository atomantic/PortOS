/**
 * Provider response sanitizer (`sanitizeProvider`): strips `apiKey` (replacing with `hasApiKey`)
 * and redacts `secretEnvVars` / credential-named `envVars` before sending provider records to clients.
 */

import { isMaskedEnvVar } from '../credentialEnvVars.js';

/**
 * Sanitize a provider object for client responses.
 * Strips apiKey (replaces with hasApiKey boolean) and redacts secretEnvVars
 * values. An explicitly empty secret value stays empty so the client can
 * distinguish "configured but blank" from an unknown redacted value when it
 * paints provider readiness.
 */
export const sanitizeProvider = (provider) => {
  if (!provider) return provider;
  const { apiKey, envVars, secretEnvVars, ...rest } = provider;
  const sanitized = {
    ...rest,
    hasApiKey: Boolean(apiKey),
    envVars: envVars ? { ...envVars } : {},
    secretEnvVars: secretEnvVars || [],
  };
  // Redact secret-listed AND credential-named env vars (Secret box may be off)
  for (const key of Object.keys(sanitized.envVars)) {
    if (isMaskedEnvVar(key, secretEnvVars)) {
      sanitized.envVars[key] = sanitized.envVars[key] === '' ? '' : '***';
    }
  }
  return sanitized;
};
