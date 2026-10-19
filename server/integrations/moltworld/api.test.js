import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: fetchMock }));
vi.mock('./rateLimits.js', () => ({ checkRateLimit: vi.fn(), recordAction: vi.fn(), syncFromExternal: vi.fn() }));

import * as moltworld from './api.js';

const SECRET = 'mw-secret-agent-9f8e7d';
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// Every console line the client writes, flattened for substring checks.
const loggedText = (spies) => spies.flatMap(s => s.mock.calls).map(args => args.join(' ')).join('\n');

describe('moltworld api logging', () => {
  let logSpy;
  let errorSpy;

  beforeEach(() => {
    fetchMock.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never writes the agentId to logs, even when it rides in a query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agent: { id: SECRET } }));
    await moltworld.getProfile(SECRET);

    const text = loggedText([logSpy, errorSpy]);
    expect(text).toContain('/api/agents/profile');
    expect(text).not.toContain(SECRET);
  });

  it('does not log the agentId for a 404 on a query-string endpoint', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
    await expect(moltworld.getBalance(SECRET)).rejects.toThrow();

    const text = loggedText([logSpy, errorSpy]);
    expect(text).toContain('/api/agents/balance');
    expect(text).not.toContain(SECRET);
  });

  it('logs registration without the returned agentId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agentId: SECRET }));
    const result = await moltworld.register('Example Agent');

    expect(result.agentId).toBe(SECRET);
    expect(loggedText([logSpy, errorSpy])).not.toContain(SECRET);
  });
});
