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
 * client/src/utils/providers.js), so it painted a `NEEDS SETUP` card while the
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
 * Same for `orcaRouterKeySet`: `false` is "the sibling holds no key", `null` is
 * "the caller cannot tell". Only a definite negative produces a finding.
 *
 * Credentials carried in a secret env var (Bedrock, an Ollama auth token) are
 * deliberately NOT covered here yet — that is issue #4612.
 */

import { PROVIDER_TYPES } from './aiToolkit/constants.js';
import { isLocalInstanceHost } from './localProviderRuntime.js';
import { commandBasename } from './providerModels.js';

/**
 * Hosts inside the trust boundary, where an unauthenticated OpenAI-compatible
 * server is a normal setup rather than a misconfiguration: RFC1918 LAN ranges,
 * link-local, and the Tailscale CGNAT range 100.64.0.0/10 (PortOS is a
 * tailnet-first product — an API provider pointed at another machine's Ollama
 * is a first-class configuration, not an edge case).
 */
const PRIVATE_IP_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * IPv6 counterpart to {@link PRIVATE_IP_RE}: unique-local (`fc00::/7`) and
 * link-local (`fe80::/10`). Tailscale hands out a ULA address alongside the
 * CGNAT v4 one, so without this a tailnet peer reached over IPv6 reads as a
 * public host and its keyless provider is blocked on a missing API key.
 *
 * Gated on the host being an IPv6 literal (it contains a `:`) and compared
 * NUMERICALLY on the leading hextet — a bare `/^f[cd]/` prefix test would also
 * claim hostnames like `fdrive.example.com`, and `fd::1` expands to a leading
 * hextet of `0x00fd`, which is not in `fc00::/7` at all.
 */
const isPrivateIpv6 = (host) => {
  if (!host.includes(':')) return false;
  const first = host.split(':')[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false; // '' for `::1` — loopback, matched by isLocalInstanceHost
  const n = parseInt(first, 16);
  return (n >= 0xfc00 && n <= 0xfdff) || (n >= 0xfe80 && n <= 0xfebf);
};

/** The hostname of an endpoint (scheme optional), lowercased and de-bracketed; `null` when unparseable. */
const endpointHost = (endpoint) => {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;
  const trimmed = endpoint.trim();
  // A scheme-less endpoint ("192.0.2.10:1234/v1") is still a host — give the
  // parser one so it doesn't read the leading segment as a scheme.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  if (!URL.canParse(candidate)) return null;
  return new URL(candidate).hostname.toLowerCase().replace(/^\[|\]$/g, '');
};

/**
 * Is this endpoint inside the private network — loopback, a LAN/tailnet
 * address, a `.local`/`.ts.net`/`.internal` name, or a bare single-label host?
 *
 * Decides whether a missing API key is actually a missing prerequisite. The
 * server attaches an `Authorization` header only when a key is stored, so a
 * keyless call to a private OpenAI-compatible server (LM Studio on the desk
 * machine, Ollama on a tailnet peer) works exactly as configured — treating it
 * as un-runnable would take a supported deployment out of the fallback chain.
 * A public endpoint with no key stays flagged: that one really is misconfigured.
 *
 * MIRROR of `isPrivateNetworkEndpoint` in client/src/utils/providers.js — keep
 * in lockstep. A host that cannot be parsed reads as NOT private, keeping the
 * stricter of the two answers for input we don't understand.
 *
 * The two disagree only on compact loopback spellings (`http://127.1`), which
 * `URL` expands and the client's cheap regex does not. That no longer reaches
 * the card: the client consumes THIS answer when the server publishes one, and
 * falls back to its own regex only against a server too old to publish.
 */
export const isPrivateNetworkEndpoint = (endpoint) => {
  const host = endpointHost(endpoint);
  if (host === null) return false;
  if (isLocalInstanceHost(host)) return true;
  if (PRIVATE_IP_RE.test(host)) return true;
  if (isPrivateIpv6(host)) return true;
  if (/\.(local|internal|lan|home\.arpa|ts\.net)$/.test(host)) return true;
  // A single-label host resolves only inside the local network (`http://nas:11434`).
  return !host.includes('.') && !host.includes(':');
};

/** True for a process-backed provider (cli/tui), which needs its binary on PATH. */
const isProcessProvider = (provider) =>
  provider?.type === PROVIDER_TYPES.CLI || provider?.type === PROVIDER_TYPES.TUI;

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
  return commandBasename(command) || null;
};

/** Does this provider's record hold an API key? Accepts a raw OR a sanitized provider. */
const providerHasApiKey = (provider) =>
  provider?.hasApiKey === true || Boolean(provider?.apiKey);

/**
 * Which prerequisites `provider` is missing, and whether it is runnable at all.
 *
 * @param {object} provider — raw or sanitized provider record
 * @param {object} [options]
 * @param {object|null} [options.runtime] — the provider's entry of the runtimes
 *   map. `null` = NOT PROBED (see the sentinel note at the top of this file).
 * @param {boolean|null} [options.orcaRouterKeySet] — does the sibling
 *   `orcarouter` API provider hold the key an OpenCode OrcaRouter wrapper
 *   inherits at spawn time? `false` covers both "no key" and "sibling deleted";
 *   `null` is "cannot tell".
 * @returns {{met: boolean, missing: {code: string, label: string}[]}}
 */
export const providerPrerequisites = (provider, { runtime = null, orcaRouterKeySet = null } = {}) => {
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
  // The OpenCode OrcaRouter wrappers carry no key of their own — theirs lives on
  // the sibling API provider, so that's the prerequisite to report.
  if (provider?.orcarouterBacked === true && orcaRouterKeySet === false) {
    missing.push({ code: 'inheritedApiKey', label: 'OrcaRouter API provider has no API key' });
  }

  return { met: missing.length === 0, missing };
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
 * credentials, an Ollama auth token), or an OrcaRouter wrapper carrying its own
 * key rather than the sibling's. Routing on those would take working providers
 * out of the chain, so they stay presentation-only until #4612 teaches this
 * module about env-var credentials; then they can move into this list.
 */
export const ROUTING_BLOCKING_CODES = Object.freeze(['runtime']);

/**
 * Is any of these findings severe enough to skip the provider when routing?
 * @param {{code: string}[]} missing
 */
export const blocksRouting = (missing) =>
  Array.isArray(missing) && missing.some((entry) => ROUTING_BLOCKING_CODES.includes(entry?.code));
