/**
 * `providerPrerequisites(provider, opts)` reports whether a provider can run on this host, returning `{ met, missing }` for CLI binaries and required API keys.
 *
 * Of three provider questions this is the first: prerequisites (here: can it run at all?), readiness (`services/providerReadiness.js`: is its local daemon up and serving the model?),
 * availability (`aiToolkit/providerStatus.js`: is it benched after a failure?). It is the server-side copy of the client's `providerCardState` check (#4611), so routing and the API payload
 * agree with the card instead of discovering a missing binary at spawn as a raw ENOENT. Pure: every input is passed in; probing lives in `services/providerPrerequisites.js`.
 *
 * SENTINEL DISCIPLINE: `runtime` is `null` for NOT PROBED and must never read as "missing" (it would drop installed providers from the fallback chain). Likewise each `gatewayKeySet` entry:
 * `false` is "sibling API record holds no key", `null`/absent is "cannot tell". Only a definite negative produces a finding.
 *
 * Credentials in a secret env var (Bedrock, an Ollama auth token) stay presentation-only: the card resolves them from sanitized env-var metadata, while routing must not assume the server
 * can inspect the environment that will run the provider.
 */

import { isProcessProvider } from './providerTypes.js';
import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { CODEX_ACCOUNT_STATUS, isCodexSubscriptionProvider } from './codexAccount.js';
import { isPrivateNetworkEndpoint } from './localEndpoint.js';
import {
  CODEX_OSS_LOCAL_PROVIDERS,
  CODEX_OSS_MIN_VERSION,
  codexOssLocalProvider,
  codexUnsupportedLocalRuntime,
  commandBasename,
  isCodexProvider,
} from './providerModels.js';
import { gatewayForProvider } from './providerGateways.js';

// The private-network / loopback classification lives in `server/lib/localEndpoint.js` with the other endpoint-locality predicates; `client/src/utils/providerEndpoints.js` re-exports it.
export { isPrivateNetworkEndpoint };

/**
 * The key a CLI/TUI provider's runtime is published under in the runtimes map from `services/providerRuntimeInstaller.js`, or `null` when that map has nothing to say.
 * `null` for an API provider and, unlike the client's same-named helper (which offers an INSTALL button), for a command with an explicit path: the table only answers "does the bare binary resolve
 * on PortOS's PATH?", and a configured `/opt/tools/codex` is spawned against the provider's own env (`buildCliChildEnv`), so basename-matching would drop a working CLI. No key means NOT PROBED.
 */
export const providerRuntimeKey = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const command = typeof provider?.command === 'string' ? provider.command.trim() : '';
  if (command === '' || /[\\/]/.test(command)) return null;
  // Same reasoning as the explicit path: a provider overriding `PATH` in its env is resolved against THAT at spawn (`buildCliChildEnv`).
  if (Object.keys(provider?.envVars || {}).some((key) => key.toUpperCase() === 'PATH')) return null;
  return commandBasename(command) || null;
};

/** Does this provider's record hold an API key? Accepts a raw OR a sanitized provider. */
const providerHasApiKey = (provider) =>
  provider?.hasApiKey === true || Boolean(provider?.apiKey);

/**
 * The ChatGPT-subscription finding for a Codex provider, or `null`. PRESENTATION ONLY, absent from {@link ROUTING_BLOCKING_CODES}: Codex can authenticate several ways and the readiness
 * snapshot may be stale, so removing a working provider from the fallback chain is the worse failure. `readiness: null` (NOT PROBED) and any non-definite-negative status (`unknown`) produce nothing.
 */
const codexAccountFinding = (provider, readiness) => {
  if (!readiness || !isCodexSubscriptionProvider(provider)) return null;
  switch (readiness.status) {
    case CODEX_ACCOUNT_STATUS.signedOut:
      return { code: 'codexAccount', label: 'No ChatGPT account is signed in' };
    case CODEX_ACCOUNT_STATUS.reauthRequired:
      return { code: 'codexAccount', label: 'ChatGPT sign-in has expired' };
    default:
      return null;
  }
};

/**
 * The 'your own Codex config is re-pointing this provider' notice, or `null`. An ADVISORY: never in `missing` or {@link ROUTING_BLOCKING_CODES}, never makes a card read NEEDS SETUP
 * (pointing Codex at a local bridge is legitimate; the failure is PortOS reporting a ChatGPT account's readiness and quota for work it never served). Offers the opt-out
 * (`ignoreUserConfig`, appending `--ignore-user-config` at spawn). Silent once the provider ignores user config, and on a `null` snapshot (NOT DETERMINED).
 */
const codexRoutingAdvisory = (provider, routing) => {
  if (!routing?.overridden || !isCodexProvider(provider)) return null;
  if (provider?.ignoreUserConfig === true) return null;
  return {
    code: 'codexRoutingOverridden',
    label: 'Codex model routing is overridden by your own ~/.codex/config.toml',
    keys: [...routing.keys],
    // Machine-local: for the local UI only. Never log it, never federate it.
    baseUrl: routing.baseUrl || null,
  };
};

/**
 * The local-backing findings for a codex record, in the order a user should act. Both are DEFINITE negatives (marker on the record, or the probed binary answered), so both block routing:
 * spawning either would run the OpenAI cloud model the user replaced, or die on an unknown flag. `support: null` is NOT PROBED and produces nothing.
 */
const codexLocalBackingFindings = (provider, codexOssSupport) => {
  if (!isProcessProvider(provider) || !isCodexProvider(provider)) return [];
  const unsupportedRuntime = codexUnsupportedLocalRuntime(provider);
  if (unsupportedRuntime) {
    return [{
      code: 'codexLocalRuntime',
      label: `Codex cannot run against ${unsupportedRuntime} — it serves ${Object.keys(CODEX_OSS_LOCAL_PROVIDERS).join(' / ')} only`,
    }];
  }
  if (!codexOssLocalProvider(provider)) return [];
  if (codexOssSupport?.supported !== false) return [];
  return [{
    code: 'codexOss',
    label: `Codex CLI ${CODEX_OSS_MIN_VERSION}+ is required to run a local model (--oss)`,
  }];
};

/**
 * Which prerequisites `provider` is missing, and whether it is runnable at all.
 *
 * @param {object} provider — raw or sanitized provider record
 * @param {object} [options]
 * @param {object|null} [options.runtime] — the provider's entry of the runtimes
 *   map. `null` = NOT PROBED (see the sentinel note at the top of this file).
 * @param {object|null} [options.codexAccount] — the Codex ChatGPT readiness
 *   snapshot, or `null` for NOT PROBED (presentation-only; see
 *   {@link codexAccountFinding}).
 * @param {Record<string, boolean|null>|null} [options.gatewayKeySet] — per gateway
 *   id, does the sibling API provider of that id hold the key an OpenCode
 *   wrapper inherits at spawn time? `false` covers both "no key" and "sibling
 *   deleted"; `null`/absent is "cannot tell".
 * @param {object|null} [options.codexRouting] — the user's `~/.codex/config.toml`
 *   routing snapshot from `lib/codexUserConfig.js`, or `null` for NOT
 *   DETERMINED. Produces an ADVISORY only (see {@link codexRoutingAdvisory}).
 * @returns {{met: boolean, missing: {code: string, label: string}[], advisories: object[]}}
 */
export const providerPrerequisites = (provider, {
  runtime = null,
  gatewayKeySet = null,
  codexAccount = null,
  codexRouting = null,
  codexOssSupport = null,
} = {}) => {
  const missing = [];

  if (runtime && runtime.installed === false) {
    missing.push({ code: 'runtime', label: `${runtime.label || 'Runtime'} is not installed` });
  }
  // API providers auth solely via the stored key, but only an endpoint outside the private network needs one.
  if (provider?.type === PROVIDER_TYPES.API
    && !providerHasApiKey(provider)
    && !isPrivateNetworkEndpoint(provider?.endpoint)) {
    missing.push({ code: 'apiKey', label: 'API key is not set' });
  }
  // A gateway-backed OpenCode wrapper inherits from the sibling API provider of the same id, but an explicitly stored wrapper key takes precedence at spawn.
  const gateway = gatewayForProvider(provider);
  if (gateway && !providerHasApiKey(provider) && gatewayKeySet?.[gateway.id] === false) {
    missing.push({ code: 'inheritedApiKey', label: `${gateway.label} API provider has no API key` });
  }

  const codexFinding = codexAccountFinding(provider, codexAccount);
  if (codexFinding) missing.push(codexFinding);
  missing.push(...codexLocalBackingFindings(provider, codexOssSupport));

  // Advisories are a SEPARATE list: everything in `missing` blocks something, and this must block nothing.
  const routingAdvisory = codexRoutingAdvisory(provider, codexRouting);
  return {
    met: missing.length === 0,
    missing,
    advisories: routingAdvisory ? [routingAdvisory] : [],
  };
};

/** A one-line reason a provider was skipped, for the run log ("Codex CLI is not installed; API key is not set"); `null` when nothing is missing, so it can be the whole gate. */
export const describeMissingPrerequisites = (missing) =>
  (Array.isArray(missing) && missing.length > 0)
    ? missing.map((entry) => entry?.label).filter(Boolean).join('; ') || null
    : null;

/**
 * The findings a ROUTING decision may act on, narrower than what the card displays. A missing binary is unarguable (nothing makes `spawn codex` work when it isn't on PATH).
 * Credential findings are not: this module reads only the provider's own stored key, and a provider may authenticate another way (secret env var, a gateway wrapper's own key),
 * so routing on them would drop working providers; they stay presentation-only.
 */
export const ROUTING_BLOCKING_CODES = Object.freeze(['runtime', 'codexOss', 'codexLocalRuntime']);

/**
 * Is any of these findings severe enough to skip the provider when routing?
 * @param {{code: string}[]} missing
 */
export const blocksRouting = (missing) =>
  Array.isArray(missing) && missing.some((entry) => ROUTING_BLOCKING_CODES.includes(entry?.code));
