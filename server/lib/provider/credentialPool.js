/**
 * Multi-key credential pools on one service instance (#17384): entry resolution, origin binding, strategy selection, per-model and key-wide cooldowns, and the per-request rotation session.
 *
 * A service instance (`ai_connections` row) runs under ONE primary key —
 * `instanceApiKeyFor` in `providerServiceInstances.js`. A pool adds more keys
 * for the same backend, held in `credentials.credentialPool`:
 *
 *   { strategy: 'fill_first' | 'round_robin' | 'least_used',
 *     entries: [{ id, label, source: 'stored', apiKey, origin, enabled, addedAt }
 *              | { id, label, source: 'env', envVar, enabled, addedAt }],
 *     order: [credentialId, …],      // priority = position; unlisted ids follow
 *     disabledEnv: [ENV_VAR_NAME, …] } // auto-discovered siblings switched off
 *
 * plus numbered env siblings of the definition's own variables
 * (`OPENROUTER_API_KEY_2`, `_3`, … up to the first gap), discovered at request
 * time and never written anywhere. A row without the key is a one-entry pool:
 * {@link resolvePoolEntries} answers just the primary and every caller treats a
 * pool under two usable entries as "no pool", so existing rows behave exactly
 * as before.
 *
 * Origin binding: a STORED pool key is bound to the origin (scheme+host+port) it
 * was added under. When the endpoint a request would go to has another origin,
 * the key is withheld — the `evaluateSecretEndpoint` posture: a key the user
 * gave for one host is never forwarded to a new one without being re-bound.
 * Env siblings follow the definition's shipped hosts the same way.
 *
 * Cooldowns live in a caller-owned in-memory ledger ({@link createPoolLedger}),
 * keyed by service slug and credential id, so a restart clears them (the same
 * lifetime as provider benches). {@link peekPoolStatus} reads it without
 * creating, rotating or expiring anything.
 *
 * Pure: no I/O, no clock and no process env except as arguments.
 */

import { CREDENTIAL_POOL_KEY } from './providerGraphRecords.js';

// Mirrors providerCooldown.js MAX_BENCH_MS (pinned equal by the test) without its error-classifier closure,
// so providerGraphRecords.js can import this leaf for CREDENTIAL_POOL_KEY.
export const MAX_POOL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export { CREDENTIAL_POOL_KEY };
export const POOL_STRATEGIES = Object.freeze(['fill_first', 'round_robin', 'least_used']);
export const DEFAULT_POOL_STRATEGY = 'fill_first';
export const PRIMARY_CREDENTIAL_ID = 'primary';
export const MAX_POOL_ENTRIES = 32;
/** Siblings `_2` … `_N` probed per canonical variable — a gap ends discovery earlier. */
export const MAX_ENV_SIBLINGS = 20;
const ENV_ID_PREFIX = 'env:';

// Cooldown windows. Rate limits clear in minutes; a bad key needs a human; a
// spent balance does not refill sooner than the provider says.
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
export const AUTH_COOLDOWN_MS = 15 * 60 * 1000;
export const BILLING_COOLDOWN_MS = 60 * 60 * 1000;
/** A key rejected as unauthorized this many times in a row is dead until reset or edited. */
export const AUTH_DEAD_AFTER = 2;
/** The longest the one same-key retry for a model-scoped 429 waits before resending. */
export const MAX_SAME_KEY_RETRY_DELAY_MS = 2000;
const DEFAULT_SAME_KEY_RETRY_DELAY_MS = 500;

// Providers whose 429s are counted per model, so one hot model must not bench
// the key for the others (Anthropic per-model RPM/TPM, OpenRouter per-model
// upstream limits).
const MODEL_SCOPED_DEFINITIONS = new Set(['anthropic', 'openrouter']);
const MODEL_SCOPED_HOSTS = ['api.anthropic.com', 'openrouter.ai'];

const QUOTA_BODY_RE = /insufficient[_ ]quota|exceeded your current quota|quota[_ ]exceeded|billing|credit(s)? (balance|limit)|out of credits|payment required|insufficient[_ ]credits|spend limit/i;

const isNonBlank = (value) => typeof value === 'string' && value.trim() !== '';

/** `scheme://host[:port]` of a URL, or `null` when it does not parse. */
export function originOf(url) {
  if (!isNonBlank(url) || !URL.canParse(url)) return null;
  const origin = new URL(url).origin;
  return origin === 'null' ? null : origin;
}

/** The origins a definition ships as its own defaults — the hosts env-borne keys are meant for. */
export function definitionDefaultOrigins(definition) {
  return new Set(Object.values(definition?.transports || {})
    .map((transport) => originOf(transport?.defaultBaseUrl))
    .filter(Boolean));
}

/** The origin a connection's requests go to: its OpenAI transport, else Anthropic, else any declared one. */
export function connectionOrigin(connection) {
  const transports = connection?.transports || {};
  const url = transports.openai?.baseUrl ?? transports.anthropic?.baseUrl
    ?? Object.values(transports).find((transport) => isNonBlank(transport?.baseUrl))?.baseUrl;
  return originOf(url);
}

/**
 * A masked, display-safe label for a key: a short vendor prefix when the key is
 * long enough that it reveals nothing, and the last four characters.
 */
export function fingerprintKey(apiKey) {
  if (!isNonBlank(apiKey)) return null;
  const key = apiKey.trim();
  if (key.length < 12) return '••••';
  const prefix = /^[A-Za-z]{2,4}[-_]/.exec(key)?.[0] ?? '';
  return `${prefix}…${key.slice(-4)}`;
}

/** Numbered siblings of `name` present in `env`: `NAME_2`, `NAME_3`, … stopping at the first gap. */
export function envSiblingNames(name, env = {}) {
  const found = [];
  for (let n = 2; n < MAX_ENV_SIBLINGS + 2; n += 1) {
    const candidate = `${name}_${n}`;
    if (!isNonBlank(env[candidate])) break;
    found.push(candidate);
  }
  return found;
}

/**
 * Whether `name` may be referenced by an env pool entry: one of the
 * definition's own credential variables or a numbered sibling of one. Anything
 * else (`PGPASSWORD`, another vendor's key) would let a pool forward an
 * unrelated process secret to this provider.
 */
export function isPoolEnvVarName(name, definition) {
  if (!isNonBlank(name)) return false;
  return (definition?.credential?.envVars || []).some((base) => name === base || new RegExp(`^${base}_[0-9]{1,3}$`).test(name));
}

/**
 * The stored pool, normalized: malformed entries dropped, the strategy
 * defaulted, duplicates by id removed. Never throws on a hand-edited row.
 */
export function readStoredPool(credentials) {
  const raw = credentials?.[CREDENTIAL_POOL_KEY];
  const pool = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const seen = new Set();
  const entries = (Array.isArray(pool.entries) ? pool.entries : []).filter((entry) => {
    if (!entry || typeof entry !== 'object' || !isNonBlank(entry.id) || seen.has(entry.id)) return false;
    if (entry.id === PRIMARY_CREDENTIAL_ID || entry.id.startsWith(ENV_ID_PREFIX)) return false;
    const valid = entry.source === 'stored' ? isNonBlank(entry.apiKey) : entry.source === 'env' && isNonBlank(entry.envVar);
    if (valid) seen.add(entry.id);
    return valid;
  }).slice(0, MAX_POOL_ENTRIES);
  return {
    strategy: POOL_STRATEGIES.includes(pool.strategy) ? pool.strategy : DEFAULT_POOL_STRATEGY,
    entries,
    order: Array.isArray(pool.order) ? pool.order.filter(isNonBlank) : [],
    disabledEnv: Array.isArray(pool.disabledEnv) ? pool.disabledEnv.filter(isNonBlank) : [],
  };
}

/** `credentials` with `pool` written back, or the key removed when the pool holds nothing worth storing. */
export function writeStoredPool(credentials, pool) {
  const next = { ...(credentials || {}) };
  const empty = pool.entries.length === 0 && pool.order.length === 0 && pool.disabledEnv.length === 0
    && pool.strategy === DEFAULT_POOL_STRATEGY;
  if (empty) delete next[CREDENTIAL_POOL_KEY];
  else next[CREDENTIAL_POOL_KEY] = { strategy: pool.strategy, entries: pool.entries, order: pool.order, disabledEnv: pool.disabledEnv };
  return next;
}

/**
 * Every credential the instance could run under, in priority order, each with
 * its resolved key (in memory only) and why it is withheld, if it is.
 *
 * @param {{credentials?: object, credentialVia?: string}} connection
 * @param {object|null} definition - the row's `SERVICE_DEFINITIONS` entry
 * @param {{primaryKey?: string, env?: Record<string,string|undefined>, endpoint?: string|null}} context
 *   `primaryKey` is `instanceApiKeyFor(connection, definition, env)`; `endpoint`
 *   is where this request would go (defaults to the connection's own origin).
 * @returns {{strategy: string, entries: object[]}}
 */
export function resolvePoolEntries(connection, definition, { primaryKey = '', env = {}, endpoint = null } = {}) {
  const via = connection?.credentialVia ?? 'stored';
  const pool = readStoredPool(connection?.credentials);
  // A program that signs in, or a launch wrapper that supplies the key, has no
  // key PortOS could rotate.
  if (via !== 'stored' && via !== 'env') return { strategy: pool.strategy, entries: [] };
  const targetOrigin = endpoint ? originOf(endpoint) : connectionOrigin(connection);
  const shippedOrigins = definitionDefaultOrigins(definition);
  const envTrusted = targetOrigin !== null && shippedOrigins.has(targetOrigin);

  const candidates = [];
  if (isNonBlank(primaryKey)) {
    candidates.push({ id: PRIMARY_CREDENTIAL_ID, label: 'Primary key', source: via, envVar: null, auto: false, enabled: true, apiKey: primaryKey, boundOrigin: null, withheld: null });
  }
  for (const entry of pool.entries) {
    if (entry.source === 'stored') {
      const withheld = entry.enabled === false ? 'disabled' : entry.origin !== targetOrigin ? 'origin-mismatch' : null;
      candidates.push({ id: entry.id, label: entry.label || 'Pool key', source: 'stored', envVar: null, auto: false, enabled: entry.enabled !== false, apiKey: entry.apiKey, boundOrigin: entry.origin ?? null, withheld });
      continue;
    }
    const value = isPoolEnvVarName(entry.envVar, definition) ? env[entry.envVar] : undefined;
    const withheld = entry.enabled === false ? 'disabled'
      : !isPoolEnvVarName(entry.envVar, definition) ? 'env-not-allowed'
        : !isNonBlank(value) ? 'env-missing'
          : !envTrusted ? 'origin-mismatch' : null;
    candidates.push({ id: entry.id, label: entry.label || entry.envVar, source: 'env', envVar: entry.envVar, auto: false, enabled: entry.enabled !== false, apiKey: isNonBlank(value) ? value : '', boundOrigin: null, withheld });
  }
  const referenced = new Set(candidates.map((candidate) => candidate.envVar).filter(Boolean));
  for (const base of definition?.credential?.envVars || []) {
    for (const name of envSiblingNames(base, env)) {
      if (referenced.has(name)) continue;
      referenced.add(name);
      const disabled = pool.disabledEnv.includes(name);
      candidates.push({ id: `${ENV_ID_PREFIX}${name}`, label: name, source: 'env', envVar: name, auto: true, enabled: !disabled, apiKey: env[name], boundOrigin: null, withheld: disabled ? 'disabled' : envTrusted ? null : 'origin-mismatch' });
    }
  }

  // One key is one credential, however many entries name it: a duplicate would
  // double its share under round-robin and split its cooldown.
  const seenKeys = new Set();
  const unique = candidates.filter((candidate) => {
    if (!isNonBlank(candidate.apiKey)) return true;
    if (seenKeys.has(candidate.apiKey)) return false;
    seenKeys.add(candidate.apiKey);
    return true;
  });
  const rank = (id) => { const index = pool.order.indexOf(id); return index === -1 ? Number.MAX_SAFE_INTEGER : index; };
  const entries = unique
    .map((candidate, natural) => ({ candidate, natural }))
    .sort((a, b) => (rank(a.candidate.id) - rank(b.candidate.id)) || (a.natural - b.natural))
    .map(({ candidate }, priority) => ({ ...candidate, priority, fingerprint: fingerprintKey(candidate.apiKey) }));
  return { strategy: pool.strategy, entries };
}

/** The entries a request may actually use (not withheld, holding a key). */
export const usablePoolEntries = (entries) => entries.filter((entry) => entry.withheld === null && isNonBlank(entry.apiKey));

/** Whether this instance's 429s are per model (cool the model) rather than per key (bench the key). */
export function isModelScopedPool({ definitionId = null, endpoint = null } = {}) {
  if (definitionId && MODEL_SCOPED_DEFINITIONS.has(definitionId)) return true;
  const host = originOf(endpoint) ? new URL(endpoint).hostname : null;
  return host !== null && MODEL_SCOPED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// --- the cooldown ledger ---------------------------------------------------

/** A fresh in-memory ledger: per-credential state plus the round-robin cursors. */
export const createPoolLedger = () => ({ credentials: new Map(), cursors: new Map() });

const stateKey = (slug, credentialId) => `${slug}\u0000${credentialId}`;

function credentialState(ledger, slug, credentialId) {
  const key = stateKey(slug, credentialId);
  let state = ledger.credentials.get(key);
  if (!state) {
    state = { benchedUntil: 0, benchReason: null, dead: false, authFailures: 0, uses: 0, lastUsedAt: 0, models: new Map(), rateLimitStreak: new Map() };
    ledger.credentials.set(key, state);
  }
  return state;
}

const peekState = (ledger, slug, credentialId) => ledger.credentials.get(stateKey(slug, credentialId)) ?? null;

/**
 * Whether one credential may serve `model` now, and if not why and until when.
 * Read-only: an elapsed cooldown simply reads as available.
 */
export function credentialAvailability(ledger, slug, entry, model, now) {
  const state = peekState(ledger, slug, entry.id);
  if (!state) return { available: true, reason: null, until: null };
  if (state.dead) return { available: false, reason: 'dead', until: null };
  if (state.benchedUntil > now) return { available: false, reason: state.benchReason, until: state.benchedUntil };
  const cooled = model ? state.models.get(model) : null;
  if (cooled && cooled.until > now) return { available: false, reason: cooled.reason, until: cooled.until };
  return { available: true, reason: null, until: null };
}

/**
 * Pick the credential a request should use, or `null` when every usable entry
 * is cooling (the caller then falls through to the provider fallback chain).
 *
 * `fill_first` re-evaluates from the top on every call, which IS the
 * automatic return: once the primary's cooldown elapses the next request is
 * back on it, and a provider prompt cache keyed on that key stays warm.
 * `commit` advances the round-robin cursor; a peek passes `false`.
 *
 * @param {object[]} entries - `resolvePoolEntries(...).entries`
 * @param {{ledger: object, slug: string, strategy?: string, model?: string|null, now: number, exclude?: Set<string>, commit?: boolean}} options
 */
export function selectPoolCredential(entries, { ledger, slug, strategy = DEFAULT_POOL_STRATEGY, model = null, now, exclude = new Set(), commit = true }) {
  const ready = usablePoolEntries(entries)
    .filter((entry) => !exclude.has(entry.id))
    .filter((entry) => credentialAvailability(ledger, slug, entry, model, now).available);
  if (ready.length === 0) return null;
  if (strategy === 'round_robin') {
    const cursor = ledger.cursors.get(slug) ?? 0;
    if (commit) ledger.cursors.set(slug, cursor + 1);
    return ready[cursor % ready.length];
  }
  if (strategy === 'least_used') {
    const uses = (entry) => peekState(ledger, slug, entry.id)?.uses ?? 0;
    return ready.reduce((best, entry) => (uses(entry) < uses(best) ? entry : best));
  }
  return ready[0];
}

/** Account one successful request: a use, and the end of any 429 or auth-failure streak. */
export function recordPoolSuccess(ledger, slug, entry, model, now) {
  const state = credentialState(ledger, slug, entry.id);
  state.uses += 1;
  state.lastUsedAt = now;
  state.authFailures = 0;
  if (model) state.rateLimitStreak.delete(model);
}

/** Account one attempt that was sent, whatever its outcome — what `least_used` balances on. */
export function recordPoolAttempt(ledger, slug, entry, now) {
  const state = credentialState(ledger, slug, entry.id);
  state.lastUsedAt = now;
}

// --- failure classification -------------------------------------------------

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name);
  return match ? headers[match] : null;
}

/** An absolute reset time in ms from a number that may be epoch ms, epoch s, or seconds from now. */
function resetNumberToMs(value, now) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > 1e12) return value;
  if (value > 1e9) return value * 1000;
  return now + value * 1000;
}

function resetToMs(value, now) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return resetNumberToMs(numeric, now);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * How long the provider says to wait, in ms, from its `Retry-After` header,
 * reset headers, or a `reset_at` in the error body — or `null` when it said
 * nothing usable. A past or absurd value is ignored, and the answer is capped
 * at {@link MAX_POOL_COOLDOWN_MS} like every other bench.
 */
export function providerRetryAfterMs({ headers = null, body = '' } = {}, now) {
  const candidates = [];
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter != null && retryAfter !== '') {
    const seconds = Number(retryAfter);
    candidates.push(Number.isFinite(seconds) ? now + seconds * 1000 : resetToMs(retryAfter, now));
  }
  for (const name of ['x-ratelimit-reset', 'x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']) {
    candidates.push(resetToMs(headerValue(headers, name), now));
  }
  if (isNonBlank(body) && body.trim().startsWith('{')) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch { parsed = null; }
    const error = parsed?.error && typeof parsed.error === 'object' ? parsed.error : {};
    candidates.push(resetToMs(parsed?.reset_at ?? error.reset_at ?? error.metadata?.headers?.['X-RateLimit-Reset'], now));
  }
  const future = candidates.filter((ms) => Number.isFinite(ms) && ms > now);
  if (future.length === 0) return null;
  return Math.min(Math.max(...future) - now, MAX_POOL_COOLDOWN_MS);
}

/**
 * What a failed attempt says about the CREDENTIAL that sent it.
 *
 * - `retry-same` — a first 429 on a model-scoped provider: one resend on the
 *   same key, since a single 429 is often a momentary burst.
 * - `cool-model` — a repeated 429 on a model-scoped provider: this key may not
 *   serve this model for a while; its other models are unaffected.
 * - `bench-key` — the key itself is out: a 429 on a key-scoped provider, a
 *   402 / quota body (spent balance), or a 401 (rejected key).
 * - `none` — not about the key (a 5xx, a bad request, a transport error); the
 *   pool leaves it to the caller's existing handling.
 *
 * @param {{status?: number, body?: string, headers?: object|null}} failure
 * @param {{modelScoped: boolean, rateLimitStreak?: number, now: number}} context
 * @returns {{action: 'retry-same'|'cool-model'|'bench-key'|'none', waitMs: number, reason: string|null}}
 */
export function classifyCredentialFailure({ status = 0, body = '', headers = null } = {}, { modelScoped, rateLimitStreak = 0, now }) {
  const hinted = providerRetryAfterMs({ headers, body }, now);
  const text = typeof body === 'string' ? body : '';
  if (status === 402 || (status === 429 && QUOTA_BODY_RE.test(text))) {
    return { action: 'bench-key', waitMs: hinted ?? BILLING_COOLDOWN_MS, reason: 'quota' };
  }
  if (status === 401) return { action: 'bench-key', waitMs: AUTH_COOLDOWN_MS, reason: 'auth' };
  if (status === 429) {
    if (!modelScoped) return { action: 'bench-key', waitMs: hinted ?? RATE_LIMIT_COOLDOWN_MS, reason: 'rate-limit' };
    if (rateLimitStreak < 1) {
      return { action: 'retry-same', waitMs: Math.min(hinted ?? DEFAULT_SAME_KEY_RETRY_DELAY_MS, MAX_SAME_KEY_RETRY_DELAY_MS), reason: 'rate-limit' };
    }
    return { action: 'cool-model', waitMs: hinted ?? RATE_LIMIT_COOLDOWN_MS, reason: 'rate-limit' };
  }
  return { action: 'none', waitMs: 0, reason: null };
}

/**
 * Record a failed attempt's verdict in the ledger. Returns the verdict so a
 * caller can act on it; a model-scoped 429 streak is counted here, so the
 * classification of the NEXT 429 on the same key and model sees it.
 */
export function applyCredentialFailure(ledger, slug, entry, model, failure, { modelScoped, now }) {
  const state = credentialState(ledger, slug, entry.id);
  const streak = model ? state.rateLimitStreak.get(model) ?? 0 : 0;
  const verdict = classifyCredentialFailure(failure, { modelScoped, rateLimitStreak: streak, now });
  if (verdict.action === 'retry-same') {
    state.rateLimitStreak.set(model, streak + 1);
  } else if (verdict.action === 'cool-model') {
    state.rateLimitStreak.delete(model);
    state.models.set(model, { until: now + verdict.waitMs, reason: verdict.reason });
  } else if (verdict.action === 'bench-key') {
    state.benchedUntil = now + verdict.waitMs;
    state.benchReason = verdict.reason;
    if (verdict.reason === 'auth') {
      state.authFailures += 1;
      if (state.authFailures >= AUTH_DEAD_AFTER) state.dead = true;
    }
  }
  return verdict;
}

/** Clear cooldowns, dead marks and 429 streaks — one credential, or the whole service when `credentialId` is null. */
export function resetPoolCooldowns(ledger, slug, credentialId = null) {
  const prefix = `${slug}\u0000`;
  for (const key of [...ledger.credentials.keys()]) {
    if (!key.startsWith(prefix)) continue;
    if (credentialId !== null && key !== stateKey(slug, credentialId)) continue;
    const state = ledger.credentials.get(key);
    state.benchedUntil = 0;
    state.benchReason = null;
    state.dead = false;
    state.authFailures = 0;
    state.models.clear();
    state.rateLimitStreak.clear();
  }
}

/** Drop a credential's ledger state entirely (it was removed from the pool). */
export const forgetPoolCredential = (ledger, slug, credentialId) => ledger.credentials.delete(stateKey(slug, credentialId));

/**
 * The display-safe status of every entry — what `/ai/services` renders. Never
 * a key value; never a mutation (no cursor advance, no ledger row created, no
 * expiry applied), so a status poll cannot rotate or bench anything.
 */
export function peekPoolStatus(entries, { ledger, slug, now }) {
  return entries.map((entry) => {
    const state = peekState(ledger, slug, entry.id);
    const availability = credentialAvailability(ledger, slug, entry, null, now);
    const cooledModels = state
      ? [...state.models.entries()].filter(([, cooled]) => cooled.until > now).map(([model, cooled]) => ({ model, until: new Date(cooled.until).toISOString(), reason: cooled.reason }))
      : [];
    return {
      id: entry.id,
      label: entry.label,
      source: entry.source,
      envVar: entry.envVar,
      auto: entry.auto,
      enabled: entry.enabled,
      priority: entry.priority,
      fingerprint: entry.fingerprint,
      boundOrigin: entry.boundOrigin,
      withheld: entry.withheld,
      dead: state?.dead === true,
      cooldown: availability.available || availability.reason === 'dead' ? null : { reason: availability.reason, until: new Date(availability.until).toISOString() },
      cooledModels,
      uses: state?.uses ?? 0,
      lastUsedAt: state?.lastUsedAt ? new Date(state.lastUsedAt).toISOString() : null,
    };
  });
}

// --- the per-request session ------------------------------------------------

const abortableDelay = (ms, signal) => new Promise((resolve) => {
  if (!(ms > 0) || signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
  signal?.addEventListener('abort', done, { once: true });
});

/**
 * One request's walk through the pool: the key to send now, and what to do
 * when that attempt fails. A session exists only for a pool of two or more
 * usable entries with one ready to serve; `null` means "send what you would
 * have sent".
 *
 * `onFailure` records the failure and answers whether to resend with the
 * session's (possibly new) `apiKey`. It answers `false` for a failure that is
 * not about the key, and once every usable entry has been tried or is cooling,
 * so the caller's existing bench + fallback handling sees the last failure.
 *
 * @param {{entries: object[], strategy: string, slug: string, ledger: object, model: string|null,
 *   modelScoped: boolean, clock?: () => number, delay?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   log?: (line: string) => void}} options
 */
export function createCredentialSession({ entries, strategy, slug, ledger, model, modelScoped, clock = Date.now, delay = abortableDelay, log = () => {} }) {
  if (usablePoolEntries(entries).length < 2) return null;
  const first = selectPoolCredential(entries, { ledger, slug, strategy, model, now: clock() });
  if (!first) return null;
  let current = first;
  const tried = new Set([first.id]);
  const maxAttempts = usablePoolEntries(entries).length * 2 + 1;
  let attempts = 1;
  recordPoolAttempt(ledger, slug, current, clock());
  return {
    get credentialId() { return current.id; },
    get apiKey() { return current.apiKey; },
    async onFailure(failure, { signal } = {}) {
      if (signal?.aborted || attempts >= maxAttempts) return false;
      const now = clock();
      const verdict = applyCredentialFailure(ledger, slug, current, model, failure, { modelScoped, now });
      if (verdict.action === 'none') return false;
      if (verdict.action === 'retry-same') {
        log(`🔁 Credential pool ${slug}: ${current.label} hit a 429 on ${model || 'its model'}; retrying once on the same key`);
        await delay(verdict.waitMs, signal);
        if (signal?.aborted) return false;
        attempts += 1;
        recordPoolAttempt(ledger, slug, current, clock());
        return true;
      }
      const scope = verdict.action === 'cool-model' ? `${model} on ${current.label}` : current.label;
      const next = selectPoolCredential(entries, { ledger, slug, strategy, model, now: clock(), exclude: tried });
      if (!next) {
        log(`🔑 Credential pool ${slug}: ${scope} cooling (${verdict.reason}); no other key ready — falling through`);
        return false;
      }
      log(`🔑 Credential pool ${slug}: ${scope} cooling (${verdict.reason}, ${Math.round(verdict.waitMs / 1000)}s); rotating to ${next.label}`);
      current = next;
      tried.add(next.id);
      attempts += 1;
      recordPoolAttempt(ledger, slug, current, clock());
      return true;
    },
    onSuccess() {
      recordPoolSuccess(ledger, slug, current, model, clock());
    },
  };
}
