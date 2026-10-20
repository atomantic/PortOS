import { describe, it, expect } from 'vitest';
import { pickMoltworldAccount, buildQueueUrl, explorerBanner, portosAuthHeaders } from './moltworldExplore.js';

const SECRET = 'mw-secret-credential-123';
const accounts = {
  a1: { platform: 'moltworld', status: 'active', agentId: 'personality-1', credentials: { agentId: SECRET, username: 'Alice' } },
};

describe('moltworld explore helpers', () => {
  it('keeps the Moltworld credential out of the queue URL and banner, keyed by personality id', () => {
    const acct = pickMoltworldAccount(accounts);
    const url = buildQueueUrl('http://localhost:5555', acct.personalityId);
    expect(url).toBe('http://localhost:5555/api/agents/tools/moltworld/queue/personality-1');
    expect(url).not.toContain(SECRET);
    expect(explorerBanner(acct.name)).not.toContain(SECRET);
    expect(acct.agentId).toBe(SECRET);
  });

  it('sends the bearer only when PORTOS_API_TOKEN is set', () => {
    expect(portosAuthHeaders({ PORTOS_API_TOKEN: 't' })).toEqual({ Authorization: 'Bearer t' });
    expect(portosAuthHeaders({})).toEqual({});
  });
});
