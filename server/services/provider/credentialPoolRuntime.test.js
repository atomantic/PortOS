import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ readGraph: vi.fn() }));
vi.mock('./providerGraphStore.js', () => store);

const { runChatCompletion } = await import('../chatCompletionExchange.js');
const { describeConnectionPool, openCredentialSession, resetCredentialPoolRuntime } = await import('./credentialPoolRuntime.js');

const ROUTER = 'https://openrouter.ai/api/v1';
const PRIMARY = 'sk-or-primary-key-0001';
const BACKUP = 'sk-or-backup-key-0002';
const ENV_SIBLING = 'sk-or-env-sibling-0003';

const connection = (overrides = {}) => ({
  id: 'conn-1',
  slug: 'openrouter',
  definitionId: 'openrouter',
  enabled: true,
  credentialVia: 'stored',
  transports: { openai: { baseUrl: ROUTER } },
  credentials: {
    apiKey: PRIMARY,
    credentialPool: { strategy: 'fill_first', entries: [{ id: 'key-b', label: 'Backup', source: 'stored', apiKey: BACKUP, origin: 'https://openrouter.ai', enabled: true }], order: [], disabledEnv: [] },
  },
  ...overrides,
});

const provider = (overrides = {}) => ({ id: 'or-preset', name: 'OpenRouter', type: 'api', serviceId: 'openrouter', endpoint: ROUTER, apiKey: PRIMARY, ...overrides });

const ok = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { status: 200 });
const fail = (status, body = '') => new Response(body, { status });

const sentKeys = (fetchMock) => fetchMock.mock.calls.map(([, init]) => init.headers.Authorization.replace('Bearer ', ''));

describe('credential pool at the completion boundary', () => {
  let fetchMock;
  beforeEach(() => {
    resetCredentialPoolRuntime();
    store.readGraph.mockResolvedValue({ connections: [connection()], bindings: [], routes: [] });
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const complete = (model, overrides) => runChatCompletion({ provider: provider(overrides), model, prompt: 'hi', temperature: 0, maxTokens: 10, timeout: 5000 });

  it('rotates a repeatedly rate-limited model to the backup key and keeps other models on the primary', async () => {
    fetchMock.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok('from backup'));
    const first = await complete('model-a');
    expect(first.text).toBe('from backup');
    expect(sentKeys(fetchMock)).toEqual([PRIMARY, PRIMARY, BACKUP]);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(ok('fine'));
    await complete('model-a');
    await complete('model-b');
    expect(sentKeys(fetchMock)).toEqual([BACKUP, PRIMARY]);
  });

  it('rotates at once on a 402 and surfaces the last failure when every key is spent', async () => {
    fetchMock.mockResolvedValueOnce(fail(402, 'Insufficient credits')).mockResolvedValueOnce(fail(402, 'Insufficient credits on backup'));
    const result = await complete('model-a');
    expect(sentKeys(fetchMock)).toEqual([PRIMARY, BACKUP]);
    // The caller's existing bench + fallback handling sees the final failure unchanged.
    expect(result.status).toBe(402);
    expect(result.body).toBe('Insufficient credits on backup');
  });

  it('sends the record\'s own key once when it is not the service\'s primary, or names no service', async () => {
    fetchMock.mockResolvedValue(fail(429));
    await complete('model-a', { apiKey: 'sk-overridden-key-9999' });
    await complete('model-a', { serviceId: undefined });
    expect(sentKeys(fetchMock)).toEqual(['sk-overridden-key-9999', PRIMARY]);
    expect(store.readGraph).toHaveBeenCalledTimes(1);
  });

  it('withholds the stored pool key once the endpoint moved to another origin', async () => {
    store.readGraph.mockResolvedValue({ connections: [connection({ transports: { openai: { baseUrl: 'https://proxy.example.com/v1' } } })], bindings: [], routes: [] });
    expect(await openCredentialSession(provider({ endpoint: 'https://proxy.example.com/v1' }), 'model-a')).toBeNull();
  });

  it('pools a numbered env sibling, resolved from the process at request time', async () => {
    const env = { OPENROUTER_API_KEY_2: ENV_SIBLING };
    const graph = { connections: [connection({ credentials: { apiKey: PRIMARY } })], bindings: [], routes: [] };
    const session = await openCredentialSession(provider(), 'model-a', { graph, env, delay: async () => {} });
    expect(session.apiKey).toBe(PRIMARY);
    await session.onFailure({ status: 402, body: '' });
    expect(session.apiKey).toBe(ENV_SIBLING);
  });

  it('reports pool status without rotating or exposing a key', async () => {
    fetchMock.mockResolvedValueOnce(fail(402)).mockResolvedValueOnce(ok('ok'));
    await complete('model-a');
    const status = describeConnectionPool(connection(), { env: {} });
    const again = describeConnectionPool(connection(), { env: {} });
    expect(again).toEqual(status);
    expect(status.active).toBe(true);
    expect(status.entries.map((entry) => [entry.id, entry.cooldown?.reason ?? null])).toEqual([['primary', 'quota'], ['key-b', null]]);
    expect(JSON.stringify(status)).not.toContain(PRIMARY);
    expect(JSON.stringify(status)).not.toContain(BACKUP);
  });
});
