import { describe, expect, it } from 'vitest';
import { MAX_BENCH_MS } from './providerCooldown.js';
import { serviceDefinitionById } from '../serviceDefinitions.js';
import { CREDENTIAL_POOL_SCHEMA_LIMITS } from '../providerValidation.js';
import {
  AUTH_DEAD_AFTER,
  BILLING_COOLDOWN_MS,
  CREDENTIAL_POOL_KEY,
  MAX_POOL_COOLDOWN_MS,
  MAX_POOL_ENTRIES,
  POOL_STRATEGIES,
  RATE_LIMIT_COOLDOWN_MS,
  createCredentialSession,
  createPoolLedger,
  fingerprintKey,
  isModelScopedPool,
  isPoolEnvVarName,
  peekPoolStatus,
  providerRetryAfterMs,
  readStoredPool,
  resetPoolCooldowns,
  resolvePoolEntries,
  selectPoolCredential,
  usablePoolEntries,
  writeStoredPool,
} from './credentialPool.js';

const OPENROUTER = serviceDefinitionById('openrouter');
const OPENAI = serviceDefinitionById('openai');
const ROUTER_URL = 'https://openrouter.ai/api/v1';
const NOW = Date.parse('2026-01-01T00:00:00Z');

const key = (n) => `sk-or-test-key-${String(n).padStart(4, '0')}`;
const storedEntry = (n, extra = {}) => ({ id: `key-${n}`, label: `Key ${n}`, source: 'stored', apiKey: key(n), origin: 'https://openrouter.ai', enabled: true, ...extra });

function routerConnection({ entries = [], strategy, order, disabledEnv, baseUrl = ROUTER_URL, credentialVia = 'stored' } = {}) {
  return {
    slug: 'openrouter',
    definitionId: 'openrouter',
    credentialVia,
    transports: { openai: { baseUrl } },
    credentials: {
      apiKey: key(1),
      [CREDENTIAL_POOL_KEY]: { strategy, entries, order: order ?? [], disabledEnv: disabledEnv ?? [] },
    },
  };
}

const resolve = (connection, { env = {}, endpoint = null } = {}) => resolvePoolEntries(connection, OPENROUTER, {
  primaryKey: connection.credentials.apiKey, env, endpoint,
});

describe('pool resolution', () => {
  it('reads an existing single-key row as a one-entry pool that never opens a session', () => {
    const connection = { slug: 'openai', definitionId: 'openai', credentialVia: 'stored', transports: { openai: { baseUrl: 'https://api.openai.com/v1' } }, credentials: { apiKey: 'sk-only-one-key-1234' } };
    const { entries, strategy } = resolvePoolEntries(connection, OPENAI, { primaryKey: 'sk-only-one-key-1234' });
    expect(strategy).toBe('fill_first');
    expect(entries.map((entry) => entry.id)).toEqual(['primary']);
    expect(createCredentialSession({ entries, strategy, slug: 'openai', ledger: createPoolLedger(), model: 'gpt-x', modelScoped: false })).toBeNull();
  });

  it('auto-discovers numbered env siblings up to the first gap, without writing them anywhere', () => {
    const env = { OPENROUTER_API_KEY_2: 'sk-or-env-two-0002', OPENROUTER_API_KEY_3: 'sk-or-env-three-03', OPENROUTER_API_KEY_5: 'sk-or-env-five-005' };
    const connection = routerConnection();
    const { entries } = resolve(connection, { env });
    expect(entries.map((entry) => entry.id)).toEqual(['primary', 'env:OPENROUTER_API_KEY_2', 'env:OPENROUTER_API_KEY_3']);
    expect(entries.every((entry) => entry.withheld === null)).toBe(true);
    // What would be persisted for this row holds no env secret.
    const stored = JSON.stringify(writeStoredPool(connection.credentials, readStoredPool(connection.credentials)));
    expect(stored).not.toContain('sk-or-env');
  });

  it('withholds a stored key whose bound origin is not where the request goes', () => {
    const connection = routerConnection({ entries: [storedEntry(2)], baseUrl: 'https://proxy.example.com/v1' });
    const { entries } = resolve(connection, { env: { OPENROUTER_API_KEY_2: 'sk-or-env-two-0002' } });
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry.withheld]));
    expect(byId['key-2']).toBe('origin-mismatch');
    // Env siblings are meant for the definition's shipped host, not a custom one.
    expect(byId['env:OPENROUTER_API_KEY_2']).toBe('origin-mismatch');
    expect(usablePoolEntries(entries).map((entry) => entry.id)).toEqual(['primary']);
    // The target endpoint of THIS request decides, not only the row.
    expect(usablePoolEntries(resolve(routerConnection({ entries: [storedEntry(2)] }), { endpoint: 'https://other.example.com/v1' }).entries)
      .map((entry) => entry.id)).toEqual(['primary']);
  });

  it('refuses env references outside the definition\'s own credential variables', () => {
    expect(isPoolEnvVarName('OPENROUTER_API_KEY_7', OPENROUTER)).toBe(true);
    expect(isPoolEnvVarName('PGPASSWORD', OPENROUTER)).toBe(false);
    expect(isPoolEnvVarName('OPENAI_API_KEY', OPENROUTER)).toBe(false);
    const connection = routerConnection({ entries: [{ id: 'key-x', source: 'env', envVar: 'PGPASSWORD', enabled: true }] });
    const entry = resolve(connection, { env: { PGPASSWORD: 'not-for-providers' } }).entries.find((candidate) => candidate.id === 'key-x');
    expect(entry.withheld).toBe('env-not-allowed');
    expect(entry.apiKey).toBe('');
  });

  it('orders by the stored order, dedupes identical keys and masks every fingerprint', () => {
    const connection = routerConnection({ entries: [storedEntry(2), storedEntry(3), { ...storedEntry(9), apiKey: key(1) }], order: ['key-3', 'primary'] });
    const { entries } = resolve(connection);
    expect(entries.map((entry) => [entry.id, entry.priority])).toEqual([['key-3', 0], ['primary', 1], ['key-2', 2]]);
    expect(entries.every((entry) => !entry.fingerprint.includes(entry.apiKey.slice(0, -4)))).toBe(true);
    expect(fingerprintKey(key(3))).toBe('sk-…0003');
    expect(fingerprintKey('short')).toBe('••••');
  });

  it('gives a sign-in or launch-wrapper service no pool', () => {
    expect(resolvePoolEntries({ ...routerConnection({ entries: [storedEntry(2)] }), credentialVia: 'cli-login' }, OPENROUTER, { primaryKey: '' }).entries).toEqual([]);
  });

  it('tolerates a hand-edited pool', () => {
    const pool = readStoredPool({ [CREDENTIAL_POOL_KEY]: { strategy: 'chaos', entries: [null, { id: 'primary', source: 'stored', apiKey: 'x' }, { id: 'a', source: 'stored' }, storedEntry(2), storedEntry(2)] } });
    expect(pool.strategy).toBe('fill_first');
    expect(pool.entries.map((entry) => entry.id)).toEqual(['key-2']);
  });
});

describe('strategies', () => {
  const connection = routerConnection({ entries: [storedEntry(2), storedEntry(3)] });
  const { entries } = resolve(connection);

  it('fill_first sticks to the highest-priority healthy key', () => {
    const ledger = createPoolLedger();
    const picks = [1, 2, 3].map(() => selectPoolCredential(entries, { ledger, slug: 's', strategy: 'fill_first', now: NOW }).id);
    expect(picks).toEqual(['primary', 'primary', 'primary']);
  });

  it('round_robin cycles, and a peek does not advance it', () => {
    const ledger = createPoolLedger();
    selectPoolCredential(entries, { ledger, slug: 's', strategy: 'round_robin', now: NOW, commit: false });
    const picks = [1, 2, 3, 4].map(() => selectPoolCredential(entries, { ledger, slug: 's', strategy: 'round_robin', now: NOW }).id);
    expect(picks).toEqual(['primary', 'key-2', 'key-3', 'primary']);
  });

  it('least_used balances on accounted successes', () => {
    const ledger = createPoolLedger();
    const picks = [];
    for (let i = 0; i < 4; i += 1) {
      const session = createCredentialSession({ entries, strategy: 'least_used', slug: 's', ledger, model: 'm', modelScoped: true, clock: () => NOW });
      picks.push(session.credentialId);
      session.onSuccess();
    }
    expect(picks).toEqual(['primary', 'key-2', 'key-3', 'primary']);
  });
});

describe('cooldowns', () => {
  const noDelay = async () => {};

  it('a model-scoped 429 retries once, then cools only that (key, model) and rotates it', async () => {
    const connection = routerConnection({ entries: [storedEntry(2)] });
    const { entries, strategy } = resolve(connection);
    const ledger = createPoolLedger();
    let now = NOW;
    const session = createCredentialSession({ entries, strategy, slug: 'openrouter', ledger, model: 'model-a', modelScoped: true, clock: () => now, delay: noDelay });
    expect(session.credentialId).toBe('primary');
    expect(await session.onFailure({ status: 429, body: 'rate limited' })).toBe(true);
    expect(session.credentialId).toBe('primary');
    expect(await session.onFailure({ status: 429, body: 'rate limited' })).toBe(true);
    expect(session.credentialId).toBe('key-2');
    session.onSuccess();

    // model-a is cooled on the primary; model-b still runs there.
    const nextA = createCredentialSession({ entries, strategy, slug: 'openrouter', ledger, model: 'model-a', modelScoped: true, clock: () => now });
    const nextB = createCredentialSession({ entries, strategy, slug: 'openrouter', ledger, model: 'model-b', modelScoped: true, clock: () => now });
    expect(nextA.credentialId).toBe('key-2');
    expect(nextB.credentialId).toBe('primary');

    // Automatic return once the cooldown elapses.
    now += RATE_LIMIT_COOLDOWN_MS + 1;
    expect(createCredentialSession({ entries, strategy, slug: 'openrouter', ledger, model: 'model-a', modelScoped: true, clock: () => now }).credentialId).toBe('primary');
  });

  it('a 402 benches the key for every model and rotates at once, returning after its window', async () => {
    const { entries, strategy } = resolve(routerConnection({ entries: [storedEntry(2)] }));
    const ledger = createPoolLedger();
    let now = NOW;
    const session = createCredentialSession({ entries, strategy, slug: 'openrouter', ledger, model: 'model-a', modelScoped: true, clock: () => now, delay: noDelay });
    expect(await session.onFailure({ status: 402, body: '{"error":{"message":"Insufficient credits"}}' })).toBe(true);
    expect(session.credentialId).toBe('key-2');
    expect(createCredentialSession({ entries, strategy, slug: 'openrouter', ledger, model: 'model-b', modelScoped: true, clock: () => now }).credentialId).toBe('key-2');
    now += BILLING_COOLDOWN_MS + 1;
    expect(createCredentialSession({ entries, strategy, slug: 'openrouter', ledger, model: 'model-b', modelScoped: true, clock: () => now }).credentialId).toBe('primary');
  });

  it('a quota body on a 429 is billing exhaustion, not a rate limit', async () => {
    const { entries, strategy } = resolve(routerConnection({ entries: [storedEntry(2)] }));
    const ledger = createPoolLedger();
    const session = createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: true, clock: () => NOW, delay: noDelay });
    expect(await session.onFailure({ status: 429, body: 'You exceeded your current quota' })).toBe(true);
    expect(session.credentialId).toBe('key-2');
    expect(peekPoolStatus(entries, { ledger, slug: 's', now: NOW })[0].cooldown.reason).toBe('quota');
  });

  it('a key-scoped provider benches the whole key on its first 429', async () => {
    const { entries, strategy } = resolve(routerConnection({ entries: [storedEntry(2)] }));
    const ledger = createPoolLedger();
    const session = createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: false, clock: () => NOW, delay: noDelay });
    expect(await session.onFailure({ status: 429, body: '' })).toBe(true);
    expect(session.credentialId).toBe('key-2');
  });

  it('a 401 benches the key and marks it dead when it persists, until reset', async () => {
    const { entries, strategy } = resolve(routerConnection({ entries: [storedEntry(2)] }));
    const ledger = createPoolLedger();
    let now = NOW;
    for (let i = 0; i < AUTH_DEAD_AFTER; i += 1) {
      const session = createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: true, clock: () => now, delay: noDelay });
      expect(session.credentialId).toBe('primary');
      await session.onFailure({ status: 401, body: 'invalid api key' });
      now += 16 * 60 * 1000;
    }
    expect(peekPoolStatus(entries, { ledger, slug: 's', now })[0].dead).toBe(true);
    expect(createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: true, clock: () => now }).credentialId).toBe('key-2');
    resetPoolCooldowns(ledger, 's', 'primary');
    expect(createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: true, clock: () => now }).credentialId).toBe('primary');
  });

  it('falls through once every key is cooling, and leaves non-key failures alone', async () => {
    const { entries, strategy } = resolve(routerConnection({ entries: [storedEntry(2)] }));
    const ledger = createPoolLedger();
    const session = createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: false, clock: () => NOW, delay: noDelay });
    expect(await session.onFailure({ status: 500, body: 'upstream error' })).toBe(false);
    expect(await session.onFailure({ status: 402, body: '' })).toBe(true);
    expect(await session.onFailure({ status: 402, body: '' })).toBe(false);
    // Nothing ready → no session: the caller sends the record's own key and its fallback chain decides.
    expect(createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: false, clock: () => NOW })).toBeNull();
  });

  it('honors Retry-After and reset hints, capped like every bench', () => {
    expect(providerRetryAfterMs({ headers: { 'Retry-After': '30' } }, NOW)).toBe(30_000);
    expect(providerRetryAfterMs({ headers: new Headers({ 'retry-after': new Date(NOW + 90_000).toUTCString() }) }, NOW)).toBe(90_000);
    expect(providerRetryAfterMs({ body: JSON.stringify({ error: { metadata: { headers: { 'X-RateLimit-Reset': String(NOW + 120_000) } } } }) }, NOW)).toBe(120_000);
    expect(providerRetryAfterMs({ headers: { 'retry-after': String(30 * 24 * 3600) } }, NOW)).toBe(MAX_POOL_COOLDOWN_MS);
    expect(providerRetryAfterMs({ headers: { 'retry-after': '-5' }, body: 'not json' }, NOW)).toBeNull();
    expect(MAX_POOL_COOLDOWN_MS).toBe(MAX_BENCH_MS);
  });

  it('keeps the route schema\'s copies of the strategy list and entry cap in step', () => {
    expect(CREDENTIAL_POOL_SCHEMA_LIMITS).toEqual({ strategies: [...POOL_STRATEGIES], maxEntries: MAX_POOL_ENTRIES });
  });
});

describe('status reads', () => {
  it('peekPoolStatus is read-only: no ledger rows, no cursor, no expiry', async () => {
    const { entries, strategy } = resolve(routerConnection({ entries: [storedEntry(2)], strategy: 'round_robin' }));
    const ledger = createPoolLedger();
    const before = peekPoolStatus(entries, { ledger, slug: 's', now: NOW });
    expect(ledger.credentials.size).toBe(0);
    expect(ledger.cursors.size).toBe(0);
    expect(before.map((entry) => entry.cooldown)).toEqual([null, null]);

    const session = createCredentialSession({ entries, strategy, slug: 's', ledger, model: 'm', modelScoped: false, clock: () => NOW, delay: async () => {} });
    await session.onFailure({ status: 429, body: '' });
    const snapshot = JSON.stringify([...ledger.credentials.entries()].map(([k, v]) => [k, { ...v, models: [...v.models], rateLimitStreak: [...v.rateLimitStreak] }]));
    const cursor = ledger.cursors.get('s');
    const status = peekPoolStatus(entries, { ledger, slug: 's', now: NOW + RATE_LIMIT_COOLDOWN_MS * 2 });
    expect(status[0].cooldown).toBeNull();
    expect(JSON.stringify([...ledger.credentials.entries()].map(([k, v]) => [k, { ...v, models: [...v.models], rateLimitStreak: [...v.rateLimitStreak] }]))).toBe(snapshot);
    expect(ledger.cursors.get('s')).toBe(cursor);
    expect(JSON.stringify(status)).not.toContain(key(2));
  });

  it('knows which providers rate-limit per model', () => {
    expect(isModelScopedPool({ definitionId: 'anthropic' })).toBe(true);
    expect(isModelScopedPool({ endpoint: ROUTER_URL })).toBe(true);
    expect(isModelScopedPool({ definitionId: 'openai', endpoint: 'https://api.openai.com/v1' })).toBe(false);
  });
});
