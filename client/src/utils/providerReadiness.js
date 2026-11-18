/**
 * Is a provider READY to run on this install, and why not.
 *
 * Browser MIRROR of `server/lib/provider/providerPrerequisites.js` (where the server has
 * published `missingPrerequisites` it WINS) and of the normalization in
 * `server/cos-runner/allowedCommands.js` (pinned by
 * `server/cos-runner/allowedCommands.parity.test.js`). Unknown lookup values
 * mean "not probed", never "missing".
 */

import { isCredentialEnvVarName, isNonCredentialEnvVarName } from '../../../server/lib/credentialEnvVars.js';
import { isPrivateNetworkEndpoint } from './providerEndpoints.js';
import { gatewayForProvider, isGatewayBackedProvider } from './providerGateways.js';
import { isApiProvider, isCodexSubscriptionProvider, isProcessProvider } from './providerTypes.js';

/**
 * The advisory the server publishes on `GET /api/providers` when the user's own
 * ~/.codex/config.toml re-points this provider, or `null`.
 *
 * Deliberately NOT part of `missingPrerequisites`: pointing Codex at a local
 * bridge is legitimate, so it must never bucket a card as NEEDS SETUP.
 * `advisory.baseUrl` is machine-local — render it here and nowhere else.
 * SERVER-ONLY: the browser cannot read the config file, so an older server
 * yields `null`.
 * @returns {{code:string,label:string,keys:string[],baseUrl:string|null}|null}
 */
export const codexRoutingAdvisory = (provider) => (
  Array.isArray(provider?.prerequisiteAdvisories)
    ? provider.prerequisiteAdvisories.find((entry) => entry?.code === 'codexRoutingOverridden') || null
    : null
);

/**
 * Whether the AI Providers page should offer a "Refresh Models" button: reads
 * the server's `canRefreshModels`, derived from the per-vendor fetcher table
 * (`server/lib/aiToolkit/internal/modelFetchers.js`) so "refreshable" has one
 * definition. Strict `=== true` so a payload from an older server (no field)
 * hides the button rather than offering one that 404s.
 * @param {{canRefreshModels?:boolean}|null|undefined} provider
 * @returns {boolean}
 */
export const supportsModelRefresh = (provider) => provider?.canRefreshModels === true;

/**
 * Base name of a spawn command, normalized the way the CoS Agent Runner's
 * allowlist check does before its membership test: strip any directory
 * prefix, then a trailing Windows `.exe`. Mirror of `isAllowedCommand`'s
 * normalization in `server/cos-runner/allowedCommands.js`, pinned by
 * `server/cos-runner/allowedCommands.parity.test.js`.
 *
 * The server uses `path.basename`, which is platform-specific — on a POSIX
 * host a backslash is NOT a separator. This mirror always treats both `/` and
 * `\` as separators, so a Windows-style path typed into the editor on a POSIX
 * install reads as "allowed" when the server would spawn-time reject it. That
 * direction is deliberate: this drives an informational warning, and a false
 * *warning* about a path the user's own platform handles fine is worse than a
 * missing one for a path shape that platform can't run anyway.
 */
const runnerCommandBaseName = (command) => {
  const base = String(command).replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  // Only `.exe` — a `.cmd`/`.bat` npm shim is deliberately NOT stripped,
  // matching the server: the spawn path runs with `shell: false` and cannot
  // execute a batch shim, so accepting it would only move the failure later.
  return base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
};

/**
 * Would the CoS Agent Runner (`/spawn`, `/spawn-tui`) accept this command?
 *
 * `allowedCommands` is the server-published list (`runnerAllowedCommands` on
 * `GET /api/providers`) — the client never carries its own copy, because the
 * allowlist is the runner's exec boundary and must stay hand-curated
 * server-side rather than derived from user-writable provider config.
 *
 * Returns `null` for "can't tell" — the list hasn't been fetched, or the field
 * is still blank — which is distinct from `false` ("fetched, and this command
 * is definitely off the list"). Only an explicit `false` should render a
 * warning; a failed fetch must not accuse a perfectly good command.
 *
 * The command is matched UNTRIMMED (past the blank guard), because the editor
 * persists it untrimmed too — `'claude '` really would fail the runner's check.
 */
export const isRunnerAllowedCommand = (command, allowedCommands) => {
  if (!Array.isArray(allowedCommands) || allowedCommands.length === 0) return null;
  if (typeof command !== 'string' || command.trim() === '') return null;
  return allowedCommands.includes(runnerCommandBaseName(command));
};

/**
 * Does this provider resolve its binary somewhere PortOS's runtime probe never
 * looked — an explicit path in `command`, or a `PATH` of its own in
 * `envVars`?
 *
 * The runtime row answers one question, "does the bare binary resolve on
 * PortOS's PATH?", and neither of these is that question: the runner spawns
 * such a provider against its own resolution. MIRROR of the same two guards in
 * `providerRuntimeKey` in server/lib/provider/providerPrerequisites.js, which is what
 * keeps the card's badge and the server's routing decision agreeing.
 * @param {{type?:string,command?:string,envVars?:Record<string,string>}} provider
 */
export const resolvesOutsidePortosPath = (provider) => {
  if (!isProcessProvider(provider)) return false;
  if (/[\\/]/.test(String(provider?.command || '').trim())) return true;
  return Object.keys(provider?.envVars || {}).some((key) => key.toUpperCase() === 'PATH');
};

/**
 * The key a CLI/TUI provider's runtime is published under in the `runtimes` map
 * from `GET /api/providers/runtimes` (binary basename, so an absolute-path
 * command still matches). The server owns which runtimes exist; a key with no
 * entry renders no install widget. API providers have no runtime here; local-app
 * ones resolve through `localBackendForProvider`.
 */
export const providerRuntimeKey = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const command = provider?.command;
  if (typeof command !== 'string' || command.trim() === '') return null;
  return runnerCommandBaseName(command.trim());
};

// The name classifier lives in server/lib (it also drives response masking).
// An explicit secretEnvVars entry can still name a custom credential (MY_LLM_KEY).

const providerHasStoredKey = (provider) =>
  provider?.hasApiKey === true || Boolean(provider?.apiKey);

const credentialEnvVars = (provider) => {
  if (!isProcessProvider(provider)) return [];
  const envVars = provider?.envVars && typeof provider.envVars === 'object' ? provider.envVars : {};
  const secretEnvVars = Array.isArray(provider?.secretEnvVars) ? provider.secretEnvVars : [];
  const explicit = new Set(secretEnvVars.filter((name) => typeof name === 'string' && name !== ''));
  const names = [...secretEnvVars, ...Object.keys(envVars)];
  return [...new Set(names.filter((name) => typeof name === 'string'
    && !isNonCredentialEnvVarName(name)
    && (explicit.has(name) || isCredentialEnvVarName(name))))];
};

/**
 * Identify how a provider authenticates, without deciding whether that
 * credential is present. `null` is a deliberate ref for `none`, while a
 * credential ref names the provider id, inherited sibling, or env var to look
 * up. An own key wins over the gateway marker because the server leaves a
 * provider carrying `provider.apiKey` untouched at spawn time.
 *
 * @param {{id?:string,type?:string,endpoint?:string,apiKey?:string,hasApiKey?:boolean,gatewayBacked?:string,orcarouterBacked?:boolean,envVars?:Record<string,string>,secretEnvVars?:string[]}|null|undefined} provider
 * @returns {{kind:'stored'|'inherited'|'env'|'subscription'|'none',ref:string|null}}
 */
export const credentialSource = (provider) => {
  // Codex CLI/TUI providers can use the ChatGPT subscription Codex owns outside
  // PortOS: neither a stored key nor an env credential, so never tell the user
  // to paste a key. `providerCardState` receives the separate account verdict.
  if (isCodexSubscriptionProvider(provider)) {
    return { kind: 'subscription', ref: 'codex' };
  }
  // Local API endpoints need no credential, even if a stale one is retained.
  if (isApiProvider(provider) && isPrivateNetworkEndpoint(provider?.endpoint)) {
    return { kind: 'none', ref: null };
  }
  // Only API providers have their stored key read by PortOS itself; a legacy
  // apiKey on a CLI/TUI record is not passed to the process.
  if (isApiProvider(provider)) {
    return { kind: 'stored', ref: provider?.id || null };
  }
  // A gateway wrapper with its own key is the one process-backed exception
  // (withGatewayApiKey leaves it untouched).
  if (isGatewayBackedProvider(provider) && providerHasStoredKey(provider)) {
    return { kind: 'stored', ref: provider?.id || null };
  }
  const [envVar] = credentialEnvVars(provider);
  if (envVar) return { kind: 'env', ref: envVar };
  const gateway = gatewayForProvider(provider);
  if (gateway) return { kind: 'inherited', ref: gateway.id };
  return { kind: 'none', ref: null };
};

const normalizeCredentialState = (state) =>
  state === true || state === false ? state : null;

const defaultKeySetFor = (provider, id) =>
  id && id === provider?.id ? providerHasStoredKey(provider) : null;

const defaultEnvVarSet = (provider, name) => {
  if (!name || !Object.hasOwn(provider?.envVars || {}, name)) return null;
  const value = provider.envVars[name];
  const isExplicitCredential = Array.isArray(provider?.secretEnvVars)
    && provider.secretEnvVars.includes(name);
  // `***` is the sanitized secret sentinel, not evidence that the value is
  // present. A redacted value is unknown; an explicitly empty SECRET value is
  // known missing. An unmarked empty value may deliberately clear an ambient
  // host credential so the process can use another auth path, so it is unknown.
  if (value === '***' || typeof value !== 'string') return null;
  if (value === '' && !isExplicitCredential) return null;
  return value !== '';
};

const credentialEnvGroups = (provider) => {
  const names = credentialEnvVars(provider);
  const groups = [];
  const grouped = new Set();
  const hasAwsAccessPair = names.includes('AWS_ACCESS_KEY_ID') && names.includes('AWS_SECRET_ACCESS_KEY');

  for (const name of names) {
    if (name === 'AWS_ACCESS_KEY_ID' && hasAwsAccessPair) {
      groups.push(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
      grouped.add('AWS_ACCESS_KEY_ID');
      grouped.add('AWS_SECRET_ACCESS_KEY');
    } else if (!grouped.has(name) && !(hasAwsAccessPair && name === 'AWS_SESSION_TOKEN')) {
      groups.push([name]);
      grouped.add(name);
    }
  }
  return groups;
};

const inheritedCredentialMissing = (provider, keySetFor) => {
  const gateway = gatewayForProvider(provider);
  if (!gateway || providerHasStoredKey(provider)) return null;
  const rawState = typeof keySetFor === 'function'
    ? keySetFor(gateway.id)
    : defaultKeySetFor(provider, gateway.id);
  return normalizeCredentialState(rawState) === false
    ? { code: 'inheritedApiKey', label: `${gateway.label} API provider has no API key` }
    : null;
};

const credentialMissing = (provider, { keySetFor = null, envVarSet = null } = {}) => {
  const source = credentialSource(provider);
  if (source.kind === 'none' || source.kind === 'subscription' || !source.ref) return null;

  if (source.kind === 'env') {
    const groups = credentialEnvGroups(provider).map((group) => group.map((name) => {
      const rawState = typeof envVarSet === 'function' ? envVarSet(name) : defaultEnvVarSet(provider, name);
      return { name, state: normalizeCredentialState(rawState) };
    }));
    const inherited = inheritedCredentialMissing(provider, keySetFor);
    // Providers can expose alternative credential schemes in one env map (for
    // example Bedrock bearer auth or the AWS access-key pair). A complete known
    // group satisfies the provider; a partial/unknown group keeps the result
    // non-blocking rather than accusing a credential whose state is uncertain.
    const satisfied = groups.some((group) => group.every(({ state }) => state === true));
    const unknown = groups.some((group) => group.some(({ state }) => state === null));
    if (satisfied || unknown) return inherited;
    const missing = groups.flatMap((group) => group.filter(({ state }) => state === false).map(({ name }) => ({
      code: 'envVar',
      label: `${name} environment variable is not set`,
    })));
    if (inherited) missing.push(inherited);
    return missing.length > 0 ? missing : null;
  }

  if (source.kind === 'inherited') {
    return inheritedCredentialMissing(provider, keySetFor);
  }
  const rawState = typeof keySetFor === 'function'
    ? keySetFor(source.ref)
    : defaultKeySetFor(provider, source.ref);
  return normalizeCredentialState(rawState) === false
    ? { code: 'apiKey', label: 'API key is not set' }
    : null;
};

/** The states a provider card can be in on the AI Providers page, in page-group order. */
export const PROVIDER_CARD_STATE = Object.freeze({
  READY: 'ready',
  BENCHED: 'benched',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
  DISABLED: 'disabled',
});

/**
 * Which prerequisites a provider is missing, and the card state that follows —
 * one place, so a card's border, badge and page section cannot disagree.
 *
 * NOT `ProviderReadiness` / `GET /api/providers/readiness`, which probes whether
 * the local DAEMON a provider points at is up; this buckets the card from its
 * toggle, credentials and the server's bench status, and the two render side by side.
 *
 * The prerequisite half is the SERVER's answer: `GET /api/providers` publishes
 * `missingPrerequisites` (server/lib/provider/providerPrerequisites.js) and
 * `getFallbackProvider` routes on the same computation. Routing acts only on
 * that finding; credential findings are presentation-only. This function adds
 * what the browser alone can see (local-app runtime shape, sanitized env
 * credential state) and, with an older server publishing nothing, derives the
 * credential checks itself.
 *
 * Inputs are passed in so this stays pure:
 *   runtime   — the provider's entry of the `runtimes` map or the local-app shape
 *               derived from local-LLM status. `null` = NOT PROBED, never "missing".
 *   status    — entry from `GET /api/providers/status`; `available === false`
 *               means benched after a failure.
 *   keySetFor — tri-state lookup for a stored or inherited key: `true`/`false`
 *               when known, `null` or another non-boolean when unknown.
 *   envVarSet — tri-state lookup for an env credential. An explicitly empty
 *               configured value is `false`; missing or redacted is unknown.
 *
 * `disabled` outranks `blocked`: PortOS ships dozens of provider records the user
 * may never want, and calling each switched-off one "needs setup" would make a
 * healthy install read as degraded. Its gaps are still returned in `missing`.
 * `benched` only applies to an enabled provider that meets its prerequisites.
 *
 * @returns {{state: string, missing: {code: string, label: string}[]}}
 */
export const providerCardState = (provider, {
  runtime = null,
  status = null,
  keySetFor = null,
  envVarSet = null,
  // `undefined` = older server without the account feature; `null` = fetch
  // failed with no verdict. Neither may collapse into "signed out" or "ready".
  codexAccount = undefined,
} = {}) => {
  // The server's published verdict WINS so the card and the router cannot
  // drift. An ARRAY (even empty, meaning "nothing missing") is the sentinel for
  // "published"; anything else means the local derivation below stands in.
  const published = Array.isArray(provider?.missingPrerequisites)
    ? provider.missingPrerequisites.filter((entry) => entry?.code !== 'codexQuota')
    : null;
  const missing = published ? [...published] : [];
  const addMissing = (code, label) => {
    if (!missing.some((entry) => entry?.code === code && (code !== 'envVar' || entry?.label === label))) {
      missing.push({ code, label });
    }
  };

  // Kept client-side even when published: `runtime` may be the LOCAL-APP shape
  // (LM Studio / Ollama installed with no CLI shim) the server's table does not
  // cover; for a plain CLI it is the row the server probed and `addMissing`
  // de-dupes by code. Skipped when the provider resolves its binary elsewhere
  // (absolute path, own `PATH`): the runtime row only says whether the bare
  // binary resolves on PortOS's PATH, so badging it NEEDS SETUP would accuse a
  // working provider.
  if (runtime && runtime.installed === false && !resolvesOutsidePortosPath(provider)) {
    addMissing('runtime', `${runtime.label || 'Runtime'} is not installed`);
  }
  // Stored/inherited credential findings stay the server's. Env credentials are
  // also derived here because their values are redacted in the payload; the
  // tri-state lookup reports an explicitly empty value without treating a
  // redacted/absent one as missing.
  const source = credentialSource(provider);
  if (!published || source.kind === 'env') {
    const missingCredential = credentialMissing(provider, { keySetFor, envVarSet });
    for (const entry of Array.isArray(missingCredential) ? missingCredential : [missingCredential]) {
      if (entry) addMissing(entry.code, entry.label);
    }
  }

  const codexSubscription = isCodexSubscriptionProvider(provider);
  const accountStatus = codexAccount && typeof codexAccount === 'object'
    ? codexAccount.status
    : null;
  if (codexSubscription && accountStatus === 'signed-out') {
    addMissing('codexAccount', 'No ChatGPT account is signed in');
  } else if (codexSubscription && accountStatus === 'reauth-required') {
    addMissing('codexAccount', 'ChatGPT sign-in has expired');
  }

  // Switched off wins over every finding; they ride along so the card can say
  // what enabling it would take.
  if (!provider?.enabled) return { state: PROVIDER_CARD_STATE.DISABLED, missing };
  if (codexSubscription && codexAccount === null) return { state: PROVIDER_CARD_STATE.UNKNOWN, missing };
  if (codexSubscription && accountStatus === 'unknown') return { state: PROVIDER_CARD_STATE.UNKNOWN, missing };
  if (missing.length > 0) return { state: PROVIDER_CARD_STATE.BLOCKED, missing };
  if (status?.available === false || (codexSubscription && accountStatus === 'quota-exhausted')) {
    return { state: PROVIDER_CARD_STATE.BENCHED, missing };
  }
  return { state: PROVIDER_CARD_STATE.READY, missing };
};
