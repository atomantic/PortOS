/**
 * Provider PREREQUISITES — the things that must already be true on this host
 * before a provider can run at all: the CLI binary it shells out to is on
 * PortOS's PATH, and the credential it authenticates with is stored.
 *
 * Three different questions get asked about a provider, and this is the first
 * of them:
 *
 *   1. prerequisites (here)                  — can it run at all?
 *   2. readiness (`services/providerReadiness.js`) — is the local daemon it
 *      points at up and serving the model it asks for?
 *   3. availability (`aiToolkit/providerStatus.js`) — is it benched after a
 *      recent failure?
 *
 * Until #4611 this check existed only in the browser (`providerCardState` in
 * client/src/utils/providerReadiness.js), so it painted a `NEEDS SETUP` card while the
 * server happily routed a run at the very same provider and discovered the
 * missing binary at spawn time as a raw ENOENT. This module is the server-side
 * copy the routing layer and the API payload both read, and the client now
 * consumes the published result — one computation, two consumers, no drift.
 *
 * Pure: every input is passed in, nothing is probed here. The probing half is
 * `services/providerPrerequisites.js`.
 *
 * **SENTINEL DISCIPLINE.** `runtime` is `null` for NOT PROBED, which must never
 * read as "missing" — an unprobed CLI would otherwise take every perfectly
 * installed provider out of the fallback chain the first time a run failed.
 * Same for each entry of `gatewayKeySet`: `false` is "that gateway's sibling API
 * record holds no key", `null`/absent is "the caller cannot tell". Only a
 * definite negative produces a finding.
 *
 * Credentials carried in a secret env var (Bedrock, an Ollama auth token) stay
 * presentation-only here: the provider card resolves them from the sanitized
 * env-var metadata, while routing must not assume the server can inspect the
 * process environment that will ultimately run the provider.
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

// The private-network / loopback classification (RFC1918, Tailscale CGNAT,
// `.local`/`.ts.net`, single-label hosts) lives in `server/lib/localEndpoint.js`
// now, alongside the other endpoint-locality predicates it composes with
// (`isLocalInstanceHost`) — `client/src/utils/providerEndpoints.js` re-exports
// the same function rather than keeping a browser mirror.
export { isPrivateNetworkEndpoint };

/**
 * The key a CLI/TUI provider's runtime is published under in the runtimes map
 * from `services/providerRuntimeInstaller.js`, or `null` when that map has
 * nothing to say about this provider.
 *
 * `null` for an API provider (nothing is spawned) and — unlike the client's
 * same-named helper, which uses the key to offer an INSTALL button — `null` for
 * a command carrying an explicit path. The runtime table answers exactly one
 * question: "does the bare binary resolve on PortOS's PATH?" A provider
 * configured as `/opt/tools/codex` is not that question: the runner spawns the
 * configured path against the provider's own env (`buildCliChildEnv`), so
 * basename-matching it would report a perfectly working CLI as missing and drop
 * it from the fallback chain. No key means NOT PROBED, which is the honest
 * answer here.
 */
export const providerRuntimeKey = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const command = typeof provider?.command === 'string' ? provider.command.trim() : '';
  if (command === '' || /[\\/]/.test(command)) return null;
  // Same reasoning as the explicit path: a provider that overrides `PATH` in its
  // own env is resolved against THAT path at spawn time (`buildCliChildEnv`),
  // not the one the table scanned, so the table's answer isn't about it.
  if (Object.keys(provider?.envVars || {}).some((key) => key.toUpperCase() === 'PATH')) return null;
  return commandBasename(command) || null;
};

/** Does this provider's record hold an API key? Accepts a raw OR a sanitized provider. */
const providerHasApiKey = (provider) =>
  provider?.hasApiKey === true || Boolean(provider?.apiKey);

/**
 * The ChatGPT-subscription finding for a Codex provider, or `null`.
 *
 * PRESENTATION ONLY — deliberately absent from {@link ROUTING_BLOCKING_CODES}.
 * Codex can authenticate several ways and PortOS's readiness snapshot may be
 * seconds stale, so a card may say "sign in" while the router still tries the
 * run: taking a working provider out of the fallback chain is the worse failure
 * (see the module note above).
 *
 * `readiness: null` is NOT PROBED and produces nothing, and so does every
 * status that isn't a definite negative — `unknown` must never be painted as
 * signed out.
 */
const codexAccountFinding = (provider, readiness) => {
  if (!readiness || !isCodexSubscriptionProvider(provider)) return null;
  switch (readiness.status) {
    case CODEX_ACCOUNT_STATUS.signedOut:
      return { code: 'codexAccount', label: 'No ChatGPT account is signed in' };
    case CODEX_ACCOUNT_STATUS.reauthRequired:
      return { code: 'codexAccount', label: 'ChatGPT sign-in has expired' };
    case CODEX_ACCOUNT_STATUS.quotaExhausted:
      return { code: 'codexQuota', label: 'ChatGPT usage limit reached' };
    default:
      return null;
  }
};

/**
 * The 'your own Codex config is re-pointing this provider' notice, or `null`.
 *
 * An ADVISORY, not a prerequisite: it never lands in `missing`, never reaches
 * {@link ROUTING_BLOCKING_CODES}, and never makes a card read NEEDS SETUP.
 * Pointing Codex at a local bridge is a legitimate choice — the only failure is
 * PortOS reporting a ChatGPT account's readiness and quota for work that
 * account never served. So: report it, and offer the opt-out (the provider's
 * `ignoreUserConfig` flag, which appends `--ignore-user-config` at spawn).
 *
 * Silent once the provider already ignores the user config, since then the file
 * describes nothing PortOS runs. Silent on a `null` snapshot too — that is
 * NOT DETERMINED, and accusing an install whose config could not be read would
 * be exactly the false report this exists to prevent.
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
 * The local-backing findings for a codex record, in the order a user should act
 * on them. Both are DEFINITE negatives — the marker is on the record, or the
 * installed binary was probed and answered — so both block routing: spawning
 * either one would run the OpenAI cloud model the user thought they had
 * replaced, or die on an unknown flag mid-run.
 *
 * `support: null` is NOT PROBED and produces nothing, per the sentinel rule at
 * the top of this file.
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
  // API providers auth solely via the stored key — but only an endpoint outside
  // the private network actually needs one.
  if (provider?.type === PROVIDER_TYPES.API
    && !providerHasApiKey(provider)
    && !isPrivateNetworkEndpoint(provider?.endpoint)) {
    missing.push({ code: 'apiKey', label: 'API key is not set' });
  }
  // A gateway-backed OpenCode wrapper normally inherits from the sibling API
  // provider of the same id, but an explicitly stored wrapper key takes
  // precedence at spawn.
  const gateway = gatewayForProvider(provider);
  if (gateway && !providerHasApiKey(provider) && gatewayKeySet?.[gateway.id] === false) {
    missing.push({ code: 'inheritedApiKey', label: `${gateway.label} API provider has no API key` });
  }

  const codexFinding = codexAccountFinding(provider, codexAccount);
  if (codexFinding) missing.push(codexFinding);
  missing.push(...codexLocalBackingFindings(provider, codexOssSupport));

  // Advisories are a SEPARATE list on purpose: everything in `missing` blocks
  // something (a card's bucket, a strict readiness verdict), and this must
  // block nothing.
  const routingAdvisory = codexRoutingAdvisory(provider, codexRouting);
  return {
    met: missing.length === 0,
    missing,
    advisories: routingAdvisory ? [routingAdvisory] : [],
  };
};

/**
 * A one-line reason a provider was skipped, for the run log — "Codex CLI is not
 * installed; API key is not set". `null` when nothing is missing, so a caller
 * can use it as the whole gate.
 */
export const describeMissingPrerequisites = (missing) =>
  (Array.isArray(missing) && missing.length > 0)
    ? missing.map((entry) => entry?.label).filter(Boolean).join('; ') || null
    : null;

/**
 * The findings a ROUTING decision is allowed to act on — a deliberately
 * narrower set than what the card displays.
 *
 * A missing binary is unarguable: no credential, env var, or config file makes
 * `spawn codex` work when `codex` is not on PATH, so skipping that candidate
 * can only ever save a doomed run. The credential findings are NOT in that
 * class. This module reads only the provider's own stored key, and a provider
 * can legitimately authenticate another way — a secret env var (Bedrock's AWS
 * credentials, an Ollama auth token), or a gateway wrapper carrying its own
 * key rather than the sibling's. Routing on those would take working providers
 * out of the chain, so they stay presentation-only. The provider card may
 * report those credentials separately without changing the routing gate.
 */
export const ROUTING_BLOCKING_CODES = Object.freeze(['runtime', 'codexOss', 'codexLocalRuntime']);

/**
 * Is any of these findings severe enough to skip the provider when routing?
 * @param {{code: string}[]} missing
 */
export const blocksRouting = (missing) =>
  Array.isArray(missing) && missing.some((entry) => ROUTING_BLOCKING_CODES.includes(entry?.code));
