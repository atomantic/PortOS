/**
 * Is a provider READY to run on this install, and if not, why: how it
 * authenticates (`credentialSource`), which prerequisite it is missing, the
 * CoS Agent Runner allowlist check for its command, the key its CLI runtime is
 * published under, and the card state the AI Providers page groups by
 * (`providerCardState`).
 *
 * Browser MIRROR of `server/lib/providerPrerequisites.js` (the same
 * computation `getFallbackProvider` routes on — where the server has published
 * `missingPrerequisites` it WINS) and of the normalization in
 * `server/cos-runner/allowedCommands.js` (pinned by
 * `server/cos-runner/allowedCommands.parity.test.js`). Unknown lookup values
 * mean "not probed", never "missing".
 *
 * Re-exported by `./providers.js` for existing `utils/providers` imports.
 */

import { isPrivateNetworkEndpoint } from './providerEndpoints.js';
import { gatewayForProvider, isGatewayBackedProvider } from './providerGateways.js';
import { isApiProvider, isCodexSubscriptionProvider, isProcessProvider } from './providerTypes.js';

/**
 * The 'your own ~/.codex/config.toml is re-pointing this provider' advisory the
 * server publishes on `GET /api/providers`, or `null`.
 *
 * Deliberately NOT part of `missingPrerequisites`: pointing Codex at a local
 * bridge is a legitimate choice, so it must never bucket a card as NEEDS SETUP.
 * What it fixes is PortOS reporting a ChatGPT account's readiness and quota for
 * work that account never served. `advisory.baseUrl` is machine-local — render
 * it here and nowhere else.
 *
 * SERVER-ONLY, with no client fallback: the browser cannot read the user's
 * config file, so an older server publishing nothing correctly yields `null`.
 * @returns {{code:string,label:string,keys:string[],baseUrl:string|null}|null}
 */
export const codexRoutingAdvisory = (provider) => (
  Array.isArray(provider?.prerequisiteAdvisories)
    ? provider.prerequisiteAdvisories.find((entry) => entry?.code === 'codexRoutingOverridden') || null
    : null
);

/**
 * Whether the AI Providers page should offer a "Refresh Models" button for this
 * provider — i.e. whether the server has a model fetcher that can answer for it.
 *
 * Reads the server's own answer off the payload. `canRefreshModels` is derived
 * on read from the per-vendor fetcher table
 * (`server/lib/aiToolkit/internal/modelFetchers.js`) and decorated onto every
 * provider-shaped response in `routes/providers.js`, so there is exactly one
 * definition of "refreshable" and it lives next to the dispatch that has to
 * honor it.
 *
 * This used to be a ~40-line hand-written mirror of both server dispatch arms,
 * kept in lockstep by a comment. It drifted in both directions: too generous
 * showed a button that 404'd, too stingy hid the feature with no error at all.
 * Strict `=== true` so a legacy payload from an older server (no such field)
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
 * The key a CLI/TUI provider's runtime is published under in the `runtimes` map
 * from `GET /api/providers/runtimes` — the binary it spawns, basename-normalized
 * so a provider pinned to an absolute path still matches.
 *
 * Deliberately NOT a client-side copy of the runtime table: the server owns
 * which runtimes exist and how they install, and a key with no entry in the
 * fetched map simply renders no install widget. That's the right default for a
 * custom command PortOS has no installer for.
 *
 * API providers have no runtime here — the two fronted by a local app resolve
 * through `localBackendForProvider` (which also matches a renamed provider by
 * its endpoint) and get their install state from the local-LLM status.
 */
/**
 * Does this provider resolve its binary somewhere PortOS's runtime probe never
 * looked — an explicit path in `command`, or a `PATH` of its own in
 * `envVars`?
 *
 * The runtime row answers one question, "does the bare binary resolve on
 * PortOS's PATH?", and neither of these is that question: the runner spawns
 * such a provider against its own resolution. MIRROR of the same two guards in
 * `providerRuntimeKey` in server/lib/providerPrerequisites.js, which is what
 * keeps the card's badge and the server's routing decision agreeing.
 * @param {{type?:string,command?:string,envVars?:Record<string,string>}} provider
 */
export const resolvesOutsidePortosPath = (provider) => {
  if (!isProcessProvider(provider)) return false;
  if (/[\\/]/.test(String(provider?.command || '').trim())) return true;
  return Object.keys(provider?.envVars || {}).some((key) => key.toUpperCase() === 'PATH');
};

export const providerRuntimeKey = (provider) => {
  if (!isProcessProvider(provider)) return null;
  const command = provider?.command;
  if (typeof command !== 'string' || command.trim() === '') return null;
  return runnerCommandBaseName(command.trim());
};

// Environment variables whose names are conventionally credentials. The
// explicit secretEnvVars list remains the primary source, but it is a masking
// list rather than a credential schema — providers may mark optional values
// such as AWS_PROFILE secret too. Filter both sources so only actual credential
// names participate in readiness. The explicit list can still name a custom
// credential that does not follow this convention (for example MY_LLM_KEY).
const CREDENTIAL_ENV_VAR_RE = /(?:^|_)(?:API_KEY|APIKEY|AUTH|ACCESS_KEY|ACCESS_TOKEN|BEARER|CLIENT_SECRET|CREDENTIALS?|KEY|PASSWORD|PRIVATE_KEY|SECRET|TOKEN)(?:_|$)/i;

const NON_CREDENTIAL_ENV_VAR_RE = /(?:^|_)(?:BASE_URL|CONFIG|CONFIG_CONTENT|ENDPOINT|HOST|MODEL|MODE|PATH|PORT|PROFILE|REGION)(?:_|$)/i;

const NON_CREDENTIAL_ENV_VAR_NAMES = new Set(['CLAUDE_CODE_USE_BEDROCK']);

const providerHasStoredKey = (provider) =>
  provider?.hasApiKey === true || Boolean(provider?.apiKey);

const credentialEnvVars = (provider) => {
  if (!isProcessProvider(provider)) return [];
  const envVars = provider?.envVars && typeof provider.envVars === 'object' ? provider.envVars : {};
  const secretEnvVars = Array.isArray(provider?.secretEnvVars) ? provider.secretEnvVars : [];
  const explicit = new Set(secretEnvVars.filter((name) => typeof name === 'string' && name !== ''));
  const names = [...secretEnvVars, ...Object.keys(envVars)];
  return [...new Set(names.filter((name) => typeof name === 'string'
    && !NON_CREDENTIAL_ENV_VAR_NAMES.has(name)
    && !NON_CREDENTIAL_ENV_VAR_RE.test(name)
    && (explicit.has(name) || CREDENTIAL_ENV_VAR_RE.test(name))))];
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
  // Codex CLI/TUI providers can use the ChatGPT subscription that Codex owns
  // outside PortOS. It is neither a stored API key nor an environment
  // credential, so the regular credential UI must not tell the user to paste a
  // key. `providerCardState` receives the separate, bounded account verdict.
  if (isCodexSubscriptionProvider(provider)) {
    return { kind: 'subscription', ref: 'codex' };
  }
  // Local API endpoints need no credential, even if an old record happens to
  // retain one from before the endpoint was changed.
  if (isApiProvider(provider) && isPrivateNetworkEndpoint(provider?.endpoint)) {
    return { kind: 'none', ref: null };
  }
  // API providers are the only ordinary providers whose stored key is read by
  // PortOS itself. A legacy apiKey on a CLI/TUI record is not passed to the
  // process and must not hide an empty process credential.
  if (isApiProvider(provider)) {
    return { kind: 'stored', ref: provider?.id || null };
  }
  // A gateway wrapper with its own key is the one process-backed exception:
  // withGatewayApiKey leaves it untouched, so that key really is used.
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

/**
 * The four states a provider card can be in on the AI Providers page, ordered
 * the way the page groups them: usable now, temporarily benched, missing a
 * prerequisite, or simply switched off.
 */
export const PROVIDER_CARD_STATE = Object.freeze({
  READY: 'ready',
  BENCHED: 'benched',
  BLOCKED: 'blocked',
  UNKNOWN: 'unknown',
  DISABLED: 'disabled',
});

/**
 * Which prerequisites a provider is missing, and the card state that follows
 * from them — one place, so a card's border, its badge and the section the page
 * files it under can never disagree with each other.
 *
 * NOT the same thing as `ProviderReadiness` /
 * `GET /api/providers/readiness`, which probes whether the local DAEMON a
 * provider points at (llama.cpp, Ollama, LM Studio, MTPLX, vLLM) is up and serving
 * the right model. This decides the card's bucket from its toggle, its
 * credentials and the server's bench status; the two render side by side.
 *
 * The prerequisite half is the SERVER's answer now (#4611): `GET
 * /api/providers` publishes `missingPrerequisites` per provider from
 * server/lib/providerPrerequisites.js, and `getFallbackProvider` skips a
 * provider whose CLI that same computation found missing — so a card blocked on
 * an uninstalled binary is no longer a routing candidate that dies at spawn
 * time on a raw ENOENT. (Routing acts only on that finding; stored, inherited,
 * and env-var credential findings stay presentation-only, and the browser now
 * derives known env-var gaps without over-reporting redacted values.)
 *
 * This function consumes the published list and adds what the browser alone
 * can see (the local-app runtime shape and sanitized env-credential state
 * below). With an older server publishing nothing, it falls back to deriving
 * the credential checks itself.
 *
 * Inputs are passed in rather than read from globals so this stays pure:
 *   runtime          — the provider's entry of the `runtimes` map (CLI binary)
 *                      or the local-app shape the page derives from the
 *                      local-LLM status. `null` = NOT PROBED, which must never
 *                      read as "missing" (an older server, or a card drawn
 *                      before the probe lands, would otherwise accuse every
 *                      perfectly-installed CLI).
 *   status           — the runtime-availability entry from
 *                      `GET /api/providers/status`; `available === false`
 *                      means the provider is benched after a failure.
 *   keySetFor        — tri-state lookup for a stored or inherited key. It must
 *                      return `true`/`false` when known and `null` or another
 *                      non-boolean when unknown.
 *   envVarSet        — tri-state lookup for an environment credential. An
 *                      explicitly empty configured value is `false`; a missing
 *                      or redacted value is unknown and must not be reported.
 *
 * `disabled` outranks `blocked`: a provider the user switched off is not a gap
 * in this install. PortOS ships dozens of provider records the user may never
 * want, and calling every switched-off one "needs setup" makes an install with
 * a perfectly good provider read as degraded or half-configured. What such a
 * provider is missing is still returned in `missing` — a note for the user IF
 * they decide to turn it on, not an outstanding task. `benched` only applies to
 * an enabled provider that otherwise meets its prerequisites.
 *
 * @returns {{state: string, missing: {code: string, label: string}[]}}
 */
export const providerCardState = (provider, {
  runtime = null,
  status = null,
  keySetFor = null,
  envVarSet = null,
  // `undefined` means an older server did not provide the account feature at
  // all; `null` means this page tried to fetch it but could not determine a
  // verdict. They must not collapse into "signed out" or "ready".
  codexAccount = undefined,
} = {}) => {
  // The server publishes its own verdict on `GET /api/providers`
  // (`missingPrerequisites`, from server/lib/providerPrerequisites.js) and
  // routes the fallback chain on exactly that computation. Where it has an
  // answer it WINS, so the card and the router cannot drift.
  //
  // An ARRAY is the sentinel for "published" — including the empty array, which
  // is a real answer ("nothing missing"). Anything else (an older server, a
  // payload fetched before the field existed) means not published, and the
  // local derivation below stands in.
  const published = Array.isArray(provider?.missingPrerequisites) ? provider.missingPrerequisites : null;
  const missing = published ? [...published] : [];
  const addMissing = (code, label) => {
    if (!missing.some((entry) => entry?.code === code && (code !== 'envVar' || entry?.label === label))) {
      missing.push({ code, label });
    }
  };

  // Kept client-side even when the server has published: `runtime` here may be
  // the LOCAL-APP shape the page derives from the local-LLM status (an LM Studio
  // / Ollama app installed with no CLI shim on PATH), which the server's runtime
  // table does not cover. For a plain CLI provider this is the same row the
  // server probed, and `addMissing` de-dupes it by code.
  //
  // Except when the provider resolves its binary somewhere else. The runtime row
  // answers "does the bare binary resolve on PortOS's PATH?", which says nothing
  // about a provider configured as `/opt/tools/codex` or one that overrides
  // `PATH` in its own env — the runner spawns those against their own
  // resolution. Badging them NEEDS SETUP accuses a working provider, and the
  // server (which owns the routing decision) already declines to. The install
  // widget still renders from the same row: "PortOS can install this for you"
  // remains true and useful either way.
  if (runtime && runtime.installed === false && !resolvesOutsidePortosPath(provider)) {
    addMissing('runtime', `${runtime.label || 'Runtime'} is not installed`);
  }
  // The server's published findings remain authoritative for stored/inherited
  // credentials. Env credentials are also derived here because their values
  // are intentionally redacted in the payload; the tri-state lookup lets an
  // explicitly empty value be reported without treating a redacted/absent
  // value as missing.
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
  } else if (codexSubscription && accountStatus === 'quota-exhausted') {
    addMissing('codexQuota', 'ChatGPT usage limit reached');
  }

  // Switched off wins over every finding — see the precedence note above. The
  // findings ride along so the card can still say what enabling it would take.
  if (!provider?.enabled) return { state: PROVIDER_CARD_STATE.DISABLED, missing };
  if (codexSubscription && codexAccount === null) return { state: PROVIDER_CARD_STATE.UNKNOWN, missing };
  if (codexSubscription && accountStatus === 'unknown') return { state: PROVIDER_CARD_STATE.UNKNOWN, missing };
  if (missing.length > 0) return { state: PROVIDER_CARD_STATE.BLOCKED, missing };
  if (status?.available === false) return { state: PROVIDER_CARD_STATE.BENCHED, missing };
  return { state: PROVIDER_CARD_STATE.READY, missing };
};
